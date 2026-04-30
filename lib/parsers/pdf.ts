import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Agent } from 'undici';

import { chunkMarkdown } from '@/lib/utils/chunk';
import { createSourceRefFallback } from '@/lib/utils/tree';
import type { NormalizedDocument } from '@/lib/types/mindmap';

const PDF_TEXT_MIN_LENGTH = 200;
const PDF_OCR_MIN_LENGTH = 30;
const PDF_RENDER_SCALE = 3;
const PDF_OCR_MAX_PAGES_DEFAULT = 3;
const PDF_OCR_TIMEOUT_MS_DEFAULT = 120_000;
const PDF_SIPS_TIMEOUT_MS_DEFAULT = 20_000;
const PDF_VLM_OCR_TIMEOUT_MS_DEFAULT = 30_000;
const PADDLE_OCR_PAGE_TIMEOUT_MS_DEFAULT = 120_000;
const MINERU_POLL_INTERVAL_MS_DEFAULT = 2_000;
const MINERU_POLL_TIMEOUT_MS_DEFAULT = 240_000;
const MINERU_RETRY_TIMES_DEFAULT = 2;
const execFileAsync = promisify(execFile);
const CA_CERT_FALLBACK_PATHS = ['/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt'];
const CJK_CHAR_RE = /[\u3400-\u9fff]/;
const KNOWN_UPPERCASE_TOKENS = new Set([
  'AI', 'API', 'APP', 'B2B', 'B2C', 'CEO', 'CFO', 'CIO', 'CTO', 'COO',
  'DNA', 'DHL', 'EPS', 'FAQ', 'GDP', 'GPS', 'HTTP', 'KPI', 'LLM', 'OKR',
  'PDF', 'RSA', 'SQL', 'SSH', 'SSL', 'UI', 'UX', 'VPN', 'WTO', 'MBA',
  'SDK', 'URL', 'XML', 'JSON', 'HTML', 'CSS', 'DOM', 'IT', 'US', 'UK',
  'THE', 'AND', 'FOR', 'NOT', 'ARE', 'BUT', 'ALL', 'CAN', 'HAS', 'HER',
  'WAS', 'ONE', 'OUR', 'OUT', 'WHO', 'HAD', 'HIS', 'HOW', 'ITS', 'MAY',
  'NEW', 'NOW', 'OLD', 'SEE', 'WAY', 'DAY', 'GET', 'LET', 'SAY',
  'SHE', 'TOO', 'USE', 'MAN', 'RUN', 'SET', 'TOP', 'RED', 'BIG',
  'A', 'I', 'O', 'AM', 'AN', 'AS', 'AT', 'BE', 'BY', 'DO', 'GO', 'HE',
  'IF', 'IN', 'IS', 'IT', 'ME', 'MY', 'NO', 'OF', 'ON', 'OR', 'SO',
  'TO', 'UP', 'WE', 'MR', 'MS', 'DR',
]);

function isNumericLikeToken(token: string): boolean {
  return /^[\d]+([./:\-][\d]+)*$/.test(token);
}

function hasRecoverableTextSignals(text: string): boolean {
  if (!text) return false;
  const cjkChars = (text.match(/[\u3400-\u9fff]/g) || []).length;
  if (cjkChars >= 2) return true;

  const tokens = text
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}\u3400-\u9fff]+|[^\p{L}\p{N}\u3400-\u9fff]+$/gu, ''))
    .filter(Boolean);

  const numericLike = tokens.filter((token) => isNumericLikeToken(token)).length;
  if (numericLike >= 2) return true;

  const readableAscii = tokens.filter((token) => {
    if (!/^[A-Za-z][A-Za-z-]{1,24}$/.test(token)) return false;
    const upper = token.toUpperCase();
    if (KNOWN_UPPERCASE_TOKENS.has(upper)) return true;
    const hasLowercase = /[a-z]/.test(token);
    const vowelCount = (token.match(/[aeiou]/gi) || []).length;
    const consonantCluster = token.match(/[bcdfghjklmnpqrstvwxyz]{4,}/gi) || [];
    return hasLowercase && vowelCount > 0 && consonantCluster.length === 0;
  }).length;

  return readableAscii >= 3;
}

function collapseCjkSpacing(text: string): string {
  let output = text;
  let prev = '';
  while (output !== prev) {
    prev = output;
    output = output.replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2');
  }
  return output;
}

function sanitizeOcrText(text: string): string {
  const tokens = text
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}\u3400-\u9fff]+|[^\p{L}\p{N}\u3400-\u9fff]+$/gu, ''))
    .filter(Boolean);
  const kept: string[] = [];

  for (const token of tokens) {
    if (CJK_CHAR_RE.test(token)) {
      kept.push(token);
      continue;
    }
    if (isNumericLikeToken(token)) {
      // Keep short numeric tokens but filter out long ID-like numbers
      if (token.length >= 7 && !/^(19|20)\d{2}([01]\d)?([0-3]\d)?$/.test(token)) {
        continue; // Skip long numbers that aren't dates
      }
      kept.push(token);
      continue;
    }
    if (!/^[A-Za-z][A-Za-z-]{1,24}$/.test(token)) {
      continue;
    }

    const upper = token.toUpperCase();
    if (KNOWN_UPPERCASE_TOKENS.has(upper)) {
      kept.push(token);
      continue;
    }

    const hasLowercase = /[a-z]/.test(token);
    const vowelCount = (token.match(/[aeiou]/gi) || []).length;
    const consonantCluster = token.match(/[bcdfghjklmnpqrstvwxyz]{4,}/gi) || [];
    if (hasLowercase && vowelCount > 0 && consonantCluster.length === 0) {
      kept.push(token);
    }
  }

  return collapseCjkSpacing(kept.join(' ')).replace(/\s{2,}/g, ' ').trim();
}

/**
 * Detect whether text extracted by pdfjs is garbled (mojibake).
 *
 * The key signal of PDF garbled text from missing ToUnicode CMap is:
 * - A high proportion of all-uppercase alphabetic tokens that are NOT known acronyms
 * - Many unique uppercase words that don't appear in normal English text
 * - Tokens with 3+ consecutive consonants (e.g. "WHRRATAARR", "SAEESISSR")
 * - Very long all-uppercase words that aren't standard acronyms
 *
 * Normal English text rarely has many different all-uppercase words.
 * Garbled PDF text typically has dozens of unique uppercase "words".
 *
 * Returns true if the text appears to be predominantly garbled.
 */
function isPdfTextGarbled(text: string): boolean {
  if (!text || text.length < 20) return false;

  // Extract all alphabetic tokens (words) from the text
  const tokens = text
    .replace(/[^A-Za-z\s\u3400-\u9fff\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  if (tokens.length === 0) return false;

  // Count CJK characters — if there's a meaningful amount of CJK,
  // the text is likely real content, not garbled
  const cjkChars = (text.match(/[\u3400-\u9fff\u4e00-\u9fff]/g) || []).length;
  const totalNonSpace = text.replace(/\s/g, '').length;
  if (totalNonSpace > 0 && cjkChars / totalNonSpace >= 0.15) {
    return false;
  }

  // Separate alphabetic tokens into all-uppercase vs others
  const alphaTokens = tokens.filter((t) => /^[A-Za-z]+$/.test(t));
  if (alphaTokens.length < 5) return false;

  // Known English words and common acronyms that are legitimately all-uppercase
  // Get unique all-uppercase tokens that aren't known words
  const uniqueUppercase = [...new Set(
    alphaTokens.filter((t) => /^[A-Z]+$/.test(t) && !KNOWN_UPPERCASE_TOKENS.has(t)),
  )];

  // Get unique mixed-case or all-lowercase tokens (these are likely real words)
  const uniqueLowercase = [...new Set(
    alphaTokens.filter((t) => /[a-z]/.test(t)),
  )];

  // Signal 1: Too many unique unknown uppercase words relative to lowercase words.
  // Normal text has mostly lowercase/mixed-case words; garbled text has mostly uppercase.
  if (uniqueUppercase.length >= 5) {
    const upperToLowerRatio = uniqueLowercase.length > 0
      ? uniqueUppercase.length / uniqueLowercase.length
      : Infinity;

    // If there are >= 2x as many unique unknown uppercase words as lowercase, likely garbled
    if (upperToLowerRatio >= 2.0) {
      return true;
    }

    // Even with some lowercase, if there are >= 10 unique unknown uppercase words,
    // it's suspicious — check consonant cluster patterns
    if (uniqueUppercase.length >= 10) {
      let suspiciousUppercaseCount = 0;
      for (const token of uniqueUppercase) {
        const upper = token.toUpperCase();
        const len = token.length;
        // 3+ consecutive consonants in an all-uppercase word
        const consonantClusters = upper.match(/[BCDFGHJKLMNPQRSTVWXYZ]{3,}/g) || [];
        if (consonantClusters.length > 0 && len >= 4) {
          suspiciousUppercaseCount++;
          continue;
        }
        // Very long uppercase words (>= 8 chars) that aren't known acronyms
        if (len >= 8) {
          suspiciousUppercaseCount++;
          continue;
        }
      }
      // If >= 30% of unique unknown uppercase words look suspicious, it's garbled
      if (suspiciousUppercaseCount / uniqueUppercase.length >= 0.3) {
        return true;
      }
    }
  }

  // Signal 2: Very long consecutive consonant clusters across all tokens
  let garbledTokenCount = 0;
  const uniqueAlpha = [...new Set(alphaTokens)];
  for (const token of uniqueAlpha) {
    if (KNOWN_UPPERCASE_TOKENS.has(token.toUpperCase())) continue;
    const upper = token.toUpperCase();
    // 4+ consecutive consonants is a very strong garbled signal
    const longConsonantClusters = upper.match(/[BCDFGHJKLMNPQRSTVWXYZ]{4,}/g) || [];
    if (longConsonantClusters.length > 0) {
      garbledTokenCount++;
    }
  }

  if (uniqueAlpha.length > 0 && garbledTokenCount / uniqueAlpha.length >= 0.2) {
    return true;
  }

  return false;
}

interface PdfCanvasAndContext {
  canvas: {
    toBuffer?: (mimeType: string) => Buffer;
    encode?: (format: string) => Promise<Buffer | Uint8Array>;
  };
  context: unknown;
}

interface PdfCanvasFactory {
  create(width: number, height: number): PdfCanvasAndContext;
  destroy(canvasAndContext: PdfCanvasAndContext): void;
}

interface OcrPageDebug {
  page: number;
  rawText: string;
  cleanedText: string;
  accepted: boolean;
  reason?: string;
}

interface OcrPagesResult {
  pageTexts: Array<{ page: number; text: string }>;
  pageDebugs: OcrPageDebug[];
  attemptedPages: number;
  errorMessages: string[];
  provider: string;
  model?: string;
}

export interface VlmOcrConfig {
  provider: 'openai' | 'zhipu' | 'qwen';
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface PaddleOcrConfig {
  pythonBin: string;
  scriptPath: string;
  lang: string;
  useAngleCls: boolean;
  pageTimeoutMs: number;
}

interface MineruOcrConfig {
  baseUrl: string;
  language: string;
  enableTable: boolean;
  enableFormula: boolean;
  isOcr: boolean;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  retryTimes: number;
}

export interface PdfParseOptions {
  forceOcr?: boolean;
  forceOcrMaxPages?: number;
}

function pdfjsAssetDir(name: string): string {
  return `${path.join(process.cwd(), 'node_modules', 'pdfjs-dist', name)}${path.sep}`;
}

function tesseractWorkerPath(): string {
  return path.join(process.cwd(), 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js');
}

function getOcrTimeoutMs(): number {
  const raw = Number(process.env.PDF_OCR_TIMEOUT_MS ?? PDF_OCR_TIMEOUT_MS_DEFAULT);
  if (!Number.isFinite(raw) || raw < 1) return PDF_OCR_TIMEOUT_MS_DEFAULT;
  return Math.floor(raw);
}

function getVlmOcrTimeoutMs(): number {
  const raw = Number(process.env.PDF_VLM_OCR_TIMEOUT_MS ?? PDF_VLM_OCR_TIMEOUT_MS_DEFAULT);
  if (!Number.isFinite(raw) || raw < 1) return PDF_VLM_OCR_TIMEOUT_MS_DEFAULT;
  return Math.floor(raw);
}

function getOcrEngine(): 'auto' | 'tesseract' | 'vlm' | 'paddle' | 'mineru' {
  const raw = (process.env.PDF_OCR_ENGINE || 'mineru').trim().toLowerCase();
  if (raw === 'tesseract' || raw === 'vlm' || raw === 'paddle' || raw === 'mineru') return raw;
  return 'mineru';
}

function resolveCaCertPathForOcr(): string | null {
  const explicitPath = process.env.PDF_OCR_CA_CERT_PATH?.trim();
  if (explicitPath) {
    return existsSync(explicitPath) ? explicitPath : null;
  }

  const nodeExtraCaPath = process.env.NODE_EXTRA_CA_CERTS?.trim();
  if (nodeExtraCaPath && existsSync(nodeExtraCaPath)) {
    return nodeExtraCaPath;
  }

  const fallbackPath = CA_CERT_FALLBACK_PATHS.find((item) => existsSync(item));
  return fallbackPath || null;
}

function getMineruFetchWithLocalCA(): typeof fetch {
  const certPath = resolveCaCertPathForOcr();
  if (!certPath) return fetch;

  try {
    const ca = readFileSync(certPath, 'utf8');
    const dispatcher = new Agent({ connect: { ca } });
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const nextInit = (init || {}) as RequestInit & { dispatcher?: unknown };
      if (nextInit.dispatcher) {
        return fetch(input, nextInit);
      }
      return fetch(input, { ...nextInit, dispatcher } as RequestInit & { dispatcher: Agent });
    }) as typeof fetch;
  } catch {
    return fetch;
  }
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown_fetch_error';
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code;
    const message = (cause as { message?: unknown }).message;
    if (code && message) return `${error.message}:${String(code)}:${String(message)}`;
    if (code) return `${error.message}:${String(code)}`;
    if (message) return `${error.message}:${String(message)}`;
  }
  return error.message || 'fetch_failed';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout_${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadPdfDocument(buffer: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs.getDocument({
    data: buffer,
    cMapUrl: pdfjsAssetDir('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: pdfjsAssetDir('standard_fonts'),
    wasmUrl: pdfjsAssetDir('wasm'),
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;
}

async function extractPdfText(buffer: Uint8Array): Promise<{
  text: string;
  pages: number;
  pageTexts: Array<{ page: number; text: string }>;
}> {
  const pdf = await loadPdfDocument(buffer);
  const pageTexts: Array<{ page: number; text: string }> = [];

  try {
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item) => ('str' in item ? item.str ?? '' : ''))
        .join(' ')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (text) {
        pageTexts.push({ page: i, text });
      }
    }

    return {
      text: pageTexts.map(({ page, text }) => `## Page ${page}\n\n${text}`).join('\n\n'),
      pages: pdf.numPages,
      pageTexts,
    };
  } finally {
    await pdf.destroy();
  }
}

async function renderPdfPageToPng(buffer: Uint8Array, pageNumber = 1): Promise<Buffer> {
  try {
    const pdf = await loadPdfDocument(buffer);

    try {
      const safePageNumber = Math.max(1, Math.min(pageNumber, pdf.numPages));
      const page = await pdf.getPage(safePageNumber);
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      const canvasFactory = pdf.canvasFactory as PdfCanvasFactory;
      const canvasAndContext = canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));

      try {
        await page.render({
          canvas: canvasAndContext.canvas,
          canvasContext: canvasAndContext.context,
          viewport,
        } as Parameters<typeof page.render>[0]).promise;

        const canvas = canvasAndContext.canvas;

        if (typeof canvas.toBuffer === 'function') {
          return canvas.toBuffer('image/png');
        }

        if (typeof canvas.encode === 'function') {
          return Buffer.from(await canvas.encode('png'));
        }

        throw new Error('PDF canvas cannot be encoded as PNG');
      } finally {
        canvasFactory.destroy(canvasAndContext);
      }
    } finally {
      await pdf.destroy();
    }
  } catch (error) {
    // In some Next.js + Node runtimes, pdfjs rendering can fail on certain PDFs.
    // On macOS, fallback to `sips` for first-page rendering so OCR can still proceed.
    if (process.platform === 'darwin' && pageNumber === 1) {
      return renderPdfFirstPageWithSips(buffer);
    }
    throw error;
  }
}

function getSipsTimeoutMs(): number {
  const raw = Number(process.env.PDF_SIPS_TIMEOUT_MS ?? PDF_SIPS_TIMEOUT_MS_DEFAULT);
  if (!Number.isFinite(raw) || raw < 1) return PDF_SIPS_TIMEOUT_MS_DEFAULT;
  return Math.floor(raw);
}

async function renderPdfFirstPageWithSips(buffer: Uint8Array): Promise<Buffer> {
  const tempRoot = path.join(process.cwd(), '.cache', 'pdf-tmp');
  await mkdir(tempRoot, { recursive: true });
  const workDir = await mkdtemp(path.join(tempRoot, 'mindmap-pdf-'));
  const inputPdfPath = path.join(workDir, 'input.pdf');
  const outputPngPath = path.join(workDir, 'page-1.png');

  try {
    await writeFile(inputPdfPath, Buffer.from(buffer));
    const { stdout, stderr } = await execFileAsync('sips', ['-s', 'format', 'png', inputPdfPath, '--out', outputPngPath], {
      timeout: getSipsTimeoutMs(),
    });
    if (!existsSync(outputPngPath)) {
      throw new Error(
        `sips_output_missing:${outputPngPath}:stdout=${String(stdout || '').slice(0, 160)}:stderr=${String(stderr || '').slice(0, 160)}`,
      );
    }
    return await readFile(outputPngPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function getOcrMaxPages(): number {
  const raw = Number(process.env.PDF_OCR_MAX_PAGES ?? PDF_OCR_MAX_PAGES_DEFAULT);
  if (!Number.isFinite(raw) || raw < 1) return PDF_OCR_MAX_PAGES_DEFAULT;
  return Math.floor(raw);
}

function resolveMineruOcrConfig(): MineruOcrConfig {
  const pollIntervalRaw = Number(process.env.MINERU_POLL_INTERVAL_MS ?? MINERU_POLL_INTERVAL_MS_DEFAULT);
  const pollTimeoutRaw = Number(process.env.MINERU_POLL_TIMEOUT_MS ?? MINERU_POLL_TIMEOUT_MS_DEFAULT);
  const retryTimesRaw = Number(process.env.MINERU_RETRY_TIMES ?? MINERU_RETRY_TIMES_DEFAULT);
  return {
    baseUrl: (process.env.MINERU_BASE_URL?.trim() || 'https://mineru.net/api/v1/agent').replace(/\/$/, ''),
    language: process.env.MINERU_LANGUAGE?.trim() || 'ch',
    enableTable: process.env.MINERU_ENABLE_TABLE === 'true',
    enableFormula: process.env.MINERU_ENABLE_FORMULA === 'true',
    isOcr: process.env.MINERU_IS_OCR !== 'false',
    pollIntervalMs: Number.isFinite(pollIntervalRaw) && pollIntervalRaw > 0
      ? Math.floor(pollIntervalRaw)
      : MINERU_POLL_INTERVAL_MS_DEFAULT,
    pollTimeoutMs: Number.isFinite(pollTimeoutRaw) && pollTimeoutRaw > 0
      ? Math.floor(pollTimeoutRaw)
      : MINERU_POLL_TIMEOUT_MS_DEFAULT,
    retryTimes: Number.isFinite(retryTimesRaw) && retryTimesRaw >= 0
      ? Math.floor(retryTimesRaw)
      : MINERU_RETRY_TIMES_DEFAULT,
  };
}

function resolvePaddleOcrConfig(): PaddleOcrConfig | null {
  const scriptPath = process.env.PADDLE_OCR_SCRIPT_PATH?.trim() || path.join(process.cwd(), 'scripts', 'paddle_ocr.py');
  if (!existsSync(scriptPath)) return null;

  const timeoutRaw = Number(process.env.PADDLE_OCR_TIMEOUT_MS ?? PADDLE_OCR_PAGE_TIMEOUT_MS_DEFAULT);
  const pageTimeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? Math.floor(timeoutRaw)
    : PADDLE_OCR_PAGE_TIMEOUT_MS_DEFAULT;

  return {
    pythonBin: process.env.PADDLE_OCR_PYTHON_BIN?.trim() || 'python3',
    scriptPath,
    lang: process.env.PADDLE_OCR_LANG?.trim() || 'ch',
    useAngleCls: process.env.PADDLE_OCR_USE_ANGLE_CLS === 'true',
    pageTimeoutMs,
  };
}

function resolveVlmOcrConfig(): VlmOcrConfig | null {
  const requestedProvider = (process.env.PDF_OCR_PROVIDER || process.env.LLM_PROVIDER || 'zhipu').trim().toLowerCase();
  const provider = requestedProvider === 'dashscope' ? 'qwen' : requestedProvider;

  if (provider === 'zhipu') {
    const apiKey = process.env.PDF_OCR_API_KEY?.trim() || process.env.ZHIPU_API_KEY?.trim();
    if (!apiKey) return null;
    return {
      provider,
      apiKey,
      baseUrl: process.env.PDF_OCR_BASE_URL?.trim() || process.env.ZHIPU_BASE_URL?.trim() || 'https://open.bigmodel.cn/api/paas/v4',
      model: process.env.PDF_OCR_MODEL?.trim() || 'glm-4.6v-flash',
    };
  }

  if (provider === 'openai') {
    const apiKey = process.env.PDF_OCR_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return null;
    return {
      provider,
      apiKey,
      baseUrl: process.env.PDF_OCR_BASE_URL?.trim() || process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
      model: process.env.PDF_OCR_MODEL?.trim() || 'gpt-4o-mini',
    };
  }

  if (provider === 'qwen') {
    const apiKey = process.env.PDF_OCR_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim();
    if (!apiKey) return null;
    return {
      provider,
      apiKey,
      baseUrl: process.env.PDF_OCR_BASE_URL?.trim() || process.env.DASHSCOPE_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: process.env.PDF_OCR_MODEL?.trim() || 'qwen-vl-plus',
    };
  }

  return null;
}

function getChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`;
}

function toImageUrlPayload(provider: VlmOcrConfig['provider'], image: Buffer): string {
  const base64 = image.toString('base64');
  return provider === 'zhipu' ? base64 : `data:image/png;base64,${base64}`;
}

function extractChatCompletionText(payload: unknown): string {
  const firstChoice = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
  const content = firstChoice?.message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const text = (item as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .join('\n');
  }

  return '';
}

function normalizeVlmOcrText(text: string): string {
  return text
    .replace(/^```(?:markdown|md|text)?/i, '')
    .replace(/```$/i, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface MineruSubmitResponse {
  code?: number;
  msg?: string;
  data?: {
    task_id?: string;
    file_url?: string;
  };
}

interface MineruTaskStatusResponse {
  code?: number;
  msg?: string;
  data?: {
    state?: string;
    full_zip_url?: string;
    markdown_url?: string;
    err_msg?: string;
    err_code?: number;
  };
}

function normalizeMineruMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ensurePdfFileName(fileName: string): string {
  const safe = fileName.replace(/[^\w.\-\u3400-\u9fff]+/g, '_');
  return safe.toLowerCase().endsWith('.pdf') ? safe : `${safe || 'document'}.pdf`;
}

async function submitMineruTask(
  buffer: Uint8Array,
  fileName: string,
  maxPages: number,
  config: MineruOcrConfig,
): Promise<string> {
  const requestFetch = getMineruFetchWithLocalCA();
  let submitRes: Response;
  try {
    submitRes = await requestFetch(`${config.baseUrl}/parse/file`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file_name: ensurePdfFileName(fileName),
        is_ocr: config.isOcr,
        language: config.language,
        page_range: maxPages > 1 ? `1-${maxPages}` : '1',
        enable_table: config.enableTable,
        enable_formula: config.enableFormula,
      }),
      signal: AbortSignal.timeout(getOcrTimeoutMs()),
    });
  } catch (error) {
    throw new Error(`mineru_submit_fetch_failed:${formatFetchError(error)}`);
  }

  if (!submitRes.ok) {
    throw new Error(`mineru_submit_http_${submitRes.status}`);
  }

  const submitJson = (await submitRes.json().catch(() => ({}))) as MineruSubmitResponse;
  if (submitJson.code !== 0) {
    throw new Error(`mineru_submit_failed:${submitJson.msg || 'unknown_error'}`);
  }
  const taskId = submitJson.data?.task_id?.trim();
  const uploadUrl = submitJson.data?.file_url?.trim();
  if (!taskId || !uploadUrl) {
    throw new Error('mineru_submit_invalid_response');
  }

  let uploadRes: Response;
  try {
    uploadRes = await requestFetch(uploadUrl, {
      method: 'PUT',
      body: Buffer.from(buffer),
      signal: AbortSignal.timeout(getOcrTimeoutMs()),
    });
  } catch (error) {
    throw new Error(`mineru_upload_fetch_failed:${formatFetchError(error)}`);
  }
  if (!uploadRes.ok) {
    throw new Error(`mineru_upload_http_${uploadRes.status}`);
  }

  return taskId;
}

async function pollMineruMarkdown(taskId: string, config: MineruOcrConfig): Promise<string> {
  const requestFetch = getMineruFetchWithLocalCA();
  const deadline = Date.now() + config.pollTimeoutMs;

  while (Date.now() < deadline) {
    let statusRes: Response;
    try {
      statusRes = await requestFetch(`${config.baseUrl}/parse/${taskId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(Math.max(5_000, Math.min(config.pollIntervalMs * 2, 30_000))),
      });
    } catch (error) {
      throw new Error(`mineru_status_fetch_failed:${formatFetchError(error)}`);
    }

    if (!statusRes.ok) {
      throw new Error(`mineru_status_http_${statusRes.status}`);
    }

    const statusJson = (await statusRes.json().catch(() => ({}))) as MineruTaskStatusResponse;
    if (statusJson.code !== 0) {
      throw new Error(`mineru_status_failed:${statusJson.msg || 'unknown_error'}`);
    }

    const state = (statusJson.data?.state || '').toLowerCase();
    if (state === 'done') {
      const markdownUrl = statusJson.data?.markdown_url?.trim();
      if (!markdownUrl) {
        throw new Error('mineru_markdown_url_missing');
      }
      let markdownRes: Response;
      try {
        markdownRes = await requestFetch(markdownUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(getOcrTimeoutMs()),
        });
      } catch (error) {
        throw new Error(`mineru_markdown_fetch_failed:${formatFetchError(error)}`);
      }
      if (!markdownRes.ok) {
        throw new Error(`mineru_markdown_http_${markdownRes.status}`);
      }
      return normalizeMineruMarkdown(await markdownRes.text());
    }
    if (state === 'failed') {
      const errCode = statusJson.data?.err_code;
      const errMsg = statusJson.data?.err_msg?.trim();
      throw new Error(
        `mineru_task_failed${errCode != null ? `:${errCode}` : ''}${errMsg ? `:${errMsg}` : ''}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }

  throw new Error(`mineru_poll_timeout_${config.pollTimeoutMs}ms`);
}

interface ParsedPaddleOcrResult {
  text: string;
  lineCount: number;
  avgScore?: number;
}

export function parsePaddleOcrJsonOutput(stdout: string): ParsedPaddleOcrResult {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error('paddle_ocr_invalid_json');
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('paddle_ocr_invalid_payload');
  }

  const directText = (payload as { text?: unknown }).text;
  const lines = (payload as { lines?: Array<{ text?: unknown; score?: unknown }> }).lines;
  const avgScoreRaw = (payload as { avg_score?: unknown }).avg_score;
  const avgScore = typeof avgScoreRaw === 'number' ? avgScoreRaw : undefined;

  if (typeof directText === 'string') {
    const normalized = directText.replace(/\r\n/g, '\n').trim();
    return {
      text: normalized,
      lineCount: normalized ? normalized.split('\n').filter(Boolean).length : 0,
      avgScore,
    };
  }

  if (Array.isArray(lines)) {
    const extracted = lines
      .map((line) => (line && typeof line.text === 'string' ? line.text : ''))
      .filter(Boolean);
    return {
      text: extracted.join('\n').trim(),
      lineCount: extracted.length,
      avgScore,
    };
  }

  throw new Error('paddle_ocr_missing_text');
}

async function recognizeImageWithPaddleOcr(
  pageImage: Buffer,
  pageNumber: number,
  config: PaddleOcrConfig,
): Promise<{ rawText: string; avgScore?: number; lineCount: number }> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'mindmap-paddle-'));
  const imagePath = path.join(workDir, `page-${pageNumber}.png`);

  try {
    await writeFile(imagePath, pageImage);
    const { stdout, stderr } = await execFileAsync(
      config.pythonBin,
      [config.scriptPath, imagePath],
      {
        timeout: config.pageTimeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          PADDLE_OCR_LANG: config.lang,
          PADDLE_OCR_USE_ANGLE_CLS: config.useAngleCls ? 'true' : 'false',
          PADDLE_PDX_CACHE_HOME:
            process.env.PADDLE_PDX_CACHE_HOME?.trim() || path.join(process.cwd(), '.cache', 'paddlex'),
          PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK:
            process.env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK?.trim() || 'True',
          MPLCONFIGDIR: process.env.MPLCONFIGDIR?.trim() || path.join(process.cwd(), '.cache', 'matplotlib'),
        },
      },
    );

    const output = parsePaddleOcrJsonOutput(String(stdout || '').trim());
    if (!output.text && stderr) {
      throw new Error(`paddle_ocr_empty_output:${String(stderr).slice(0, 160)}`);
    }

    return {
      rawText: output.text,
      avgScore: output.avgScore,
      lineCount: output.lineCount,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function recognizeImageWithVlmOcr(pageImage: Buffer, config: VlmOcrConfig): Promise<string> {
  const response = await fetch(getChatCompletionsUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: toImageUrlPayload(config.provider, pageImage),
              },
            },
            {
              type: 'text',
              text: '请对这张 PDF 页面截图做高精度 OCR。要求：逐行转写页面中的真实文字；保留中文、英文、数字、日期和标点；不要总结、不要补充、不要猜测；无法识别的局部请留空；只输出转写文本。',
            },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 4096,
      ...(config.provider === 'zhipu' ? { thinking: { type: 'disabled' } } : {}),
    }),
    signal: AbortSignal.timeout(getVlmOcrTimeoutMs()),
  });

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`vlm_ocr_http_${response.status}${message ? `:${message.slice(0, 120)}` : ''}`);
  }

  const payload = await response.json();
  return normalizeVlmOcrText(extractChatCompletionText(payload));
}

async function getPdfPageCount(buffer: Uint8Array): Promise<number | undefined> {
  try {
    const pdf = await loadPdfDocument(buffer);
    try {
      return pdf.numPages;
    } finally {
      await pdf.destroy();
    }
  } catch {
    return undefined;
  }
}

async function ocrPdfPagesWithVlm(
  buffer: Uint8Array,
  maxPages: number,
  config: VlmOcrConfig,
): Promise<OcrPagesResult> {
  const pageTexts: Array<{ page: number; text: string }> = [];
  const pageDebugs: OcrPageDebug[] = [];
  const errorMessages: string[] = [];
  let attemptedPages = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    attemptedPages += 1;
    try {
      const pageImage = await renderPdfPageToPng(buffer, page);
      const rawText = await recognizeImageWithVlmOcr(pageImage, config);
      const cleanedText = collapseCjkSpacing(rawText).replace(/[ \t]{2,}/g, ' ').trim();

      if (cleanedText.length >= 12) {
        pageTexts.push({ page, text: cleanedText });
        pageDebugs.push({
          page,
          rawText,
          cleanedText,
          accepted: true,
        });
      } else {
        const reason = 'vlm_ocr_text_too_short';
        errorMessages.push(`page_${page}:${reason}`);
        pageDebugs.push({
          page,
          rawText,
          cleanedText,
          accepted: false,
          reason,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_vlm_ocr_page_error';
      errorMessages.push(`page_${page}:${message}`);
      pageDebugs.push({
        page,
        rawText: '',
        cleanedText: '',
        accepted: false,
        reason: message,
      });
    }
  }

  return {
    pageTexts,
    pageDebugs,
    attemptedPages,
    errorMessages,
    provider: config.provider,
    model: config.model,
  };
}

async function ocrPdfPagesWithPaddle(
  buffer: Uint8Array,
  maxPages: number,
  config: PaddleOcrConfig,
): Promise<OcrPagesResult> {
  const pageTexts: Array<{ page: number; text: string }> = [];
  const pageDebugs: OcrPageDebug[] = [];
  const errorMessages: string[] = [];
  let attemptedPages = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    attemptedPages += 1;
    try {
      const pageImage = await renderPdfPageToPng(buffer, page);
      const { rawText } = await recognizeImageWithPaddleOcr(pageImage, page, config);
      const cleanedText = collapseCjkSpacing(rawText).replace(/[ \t]{2,}/g, ' ').trim();

      if (cleanedText.length >= 12) {
        const maybeGarbled = isPdfTextGarbled(cleanedText);
        const recoverable = hasRecoverableTextSignals(cleanedText);
        if (maybeGarbled && !recoverable) {
          const reason = 'paddle_ocr_text_appears_garbled';
          errorMessages.push(`page_${page}:${reason}`);
          pageDebugs.push({
            page,
            rawText,
            cleanedText,
            accepted: false,
            reason,
          });
          continue;
        }

        pageTexts.push({ page, text: cleanedText });
        pageDebugs.push({
          page,
          rawText,
          cleanedText,
          accepted: true,
        });
      } else {
        const reason = 'paddle_ocr_text_too_short';
        errorMessages.push(`page_${page}:${reason}`);
        pageDebugs.push({
          page,
          rawText,
          cleanedText,
          accepted: false,
          reason,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_paddle_ocr_page_error';
      errorMessages.push(`page_${page}:${message}`);
      pageDebugs.push({
        page,
        rawText: '',
        cleanedText: '',
        accepted: false,
        reason: message,
      });
    }
  }

  return {
    pageTexts,
    pageDebugs,
    attemptedPages,
    errorMessages,
    provider: 'paddleocr',
    model: `lang:${config.lang}`,
  };
}

async function ocrPdfPagesWithMineru(
  buffer: Uint8Array,
  maxPages: number,
  fileName: string,
  config: MineruOcrConfig,
): Promise<OcrPagesResult> {
  const isRetryableError = (message: string): boolean => {
    if (!message) return false;
    return (
      message.includes('mineru_task_failed:-60010') ||
      message.includes('mineru_submit_http_429') ||
      message.includes('mineru_status_http_429') ||
      message.includes('mineru_submit_fetch_failed') ||
      message.includes('mineru_status_fetch_failed') ||
      message.includes('mineru_markdown_fetch_failed')
    );
  };

  let lastError = '';
  for (let attempt = 0; attempt <= config.retryTimes; attempt += 1) {
    try {
      const taskId = await submitMineruTask(buffer, fileName, maxPages, config);
      const rawText = await pollMineruMarkdown(taskId, config);
      const cleanedText = collapseCjkSpacing(rawText).replace(/[ \t]{2,}/g, ' ').trim();
      const hasMeaningfulText = cleanedText.length >= 12;

      return {
        pageTexts: hasMeaningfulText ? [{ page: 1, text: cleanedText }] : [],
        pageDebugs: [
          {
            page: 1,
            rawText,
            cleanedText,
            accepted: hasMeaningfulText,
            ...(hasMeaningfulText ? {} : { reason: 'mineru_ocr_text_too_short' }),
          },
        ],
        attemptedPages: maxPages,
        errorMessages: hasMeaningfulText ? [] : ['page_1:mineru_ocr_text_too_short'],
        provider: 'mineru',
        model: 'agent',
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'unknown_mineru_ocr_error';
      const canRetry = attempt < config.retryTimes && isRetryableError(lastError);
      if (canRetry) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000 * (attempt + 1), 8000)));
        continue;
      }
      break;
    }
  }

  try {
    const message = lastError || 'unknown_mineru_ocr_error';
    return {
      pageTexts: [],
      pageDebugs: [
        {
          page: 1,
          rawText: '',
          cleanedText: '',
          accepted: false,
          reason: message,
        },
      ],
      attemptedPages: maxPages,
      errorMessages: [`page_1:${message}`],
      provider: 'mineru',
      model: 'agent',
    };
  } catch {
    return {
      pageTexts: [],
      pageDebugs: [
        {
          page: 1,
          rawText: '',
          cleanedText: '',
          accepted: false,
          reason: 'unknown_mineru_ocr_error',
        },
      ],
      attemptedPages: maxPages,
      errorMessages: ['page_1:unknown_mineru_ocr_error'],
      provider: 'mineru',
      model: 'agent',
    };
  }
}

async function ocrPdfPagesWithTesseract(buffer: Uint8Array, maxPages: number): Promise<OcrPagesResult> {
  const Tesseract = await import('tesseract.js');
  const langPath = process.env.TESSERACT_LANG_PATH?.trim();
  const cachePath = process.env.TESSERACT_CACHE_PATH?.trim();
  const gzip = process.env.TESSERACT_GZIP === 'false' ? false : undefined;
  const workerPath = process.env.TESSERACT_WORKER_PATH?.trim() || tesseractWorkerPath();
  const worker = await Tesseract.createWorker('eng+chi_sim', undefined, {
    workerPath,
    ...(langPath ? { langPath } : {}),
    ...(cachePath ? { cachePath } : {}),
    ...(gzip !== undefined ? { gzip } : {}),
  });

  const pageTexts: Array<{ page: number; text: string }> = [];
  const pageDebugs: OcrPageDebug[] = [];
  const errorMessages: string[] = [];
  let attemptedPages = 0;

  try {
    if (typeof worker.setParameters === 'function') {
      await worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.AUTO,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });
    }

    for (let page = 1; page <= maxPages; page += 1) {
      attemptedPages += 1;
      try {
        const pageImage = await renderPdfPageToPng(buffer, page);
        const tempRoot = path.join(process.cwd(), '.cache', 'ocr-tmp');
        await mkdir(tempRoot, { recursive: true });
        const workDir = await mkdtemp(path.join(tempRoot, `mindmap-ocr-page-${page}-`));
        const imagePath = path.join(workDir, `page-${page}.png`);
        let result: Awaited<ReturnType<typeof worker.recognize>>;
        try {
          await writeFile(imagePath, Buffer.isBuffer(pageImage) ? pageImage : Buffer.from(pageImage));
          result = await worker.recognize(imagePath);
        } finally {
          await rm(workDir, { recursive: true, force: true });
        }
        const rawText = result.data.text?.replace(/\s+/g, ' ').trim() ?? '';
        const cleanedText = rawText ? sanitizeOcrText(rawText) : '';

        if (rawText.length > PDF_OCR_MIN_LENGTH) {
          const candidate = cleanedText.length >= 12 ? cleanedText : rawText;
          const maybeGarbled = isPdfTextGarbled(candidate);
          const recoverable = hasRecoverableTextSignals(candidate);

          if (maybeGarbled && !recoverable) {
            const reason = 'ocr_text_appears_garbled';
            errorMessages.push(`page_${page}:${reason}`);
            pageDebugs.push({
              page,
              rawText,
              cleanedText,
              accepted: false,
              reason,
            });
            continue;
          }

          const minLength = recoverable ? 12 : PDF_OCR_MIN_LENGTH;
          if (candidate.length >= minLength) {
            pageTexts.push({ page, text: candidate });
            pageDebugs.push({
              page,
              rawText,
              cleanedText: candidate,
              accepted: true,
            });
          } else {
            const reason = 'ocr_text_too_short';
            errorMessages.push(`page_${page}:${reason}`);
            pageDebugs.push({
              page,
              rawText,
              cleanedText,
              accepted: false,
              reason,
            });
          }
        } else {
          const reason = 'ocr_text_too_short';
          errorMessages.push(`page_${page}:${reason}`);
          pageDebugs.push({
            page,
            rawText,
            cleanedText,
            accepted: false,
            reason,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown_ocr_page_error';
        errorMessages.push(`page_${page}:${message}`);
        pageDebugs.push({
          page,
          rawText: '',
          cleanedText: '',
          accepted: false,
          reason: message,
        });
      }
    }

    return { pageTexts, pageDebugs, attemptedPages, errorMessages, provider: 'tesseract', model: 'eng+chi_sim' };
  } finally {
    await worker.terminate();
  }
}

async function ocrPdfPages(
  buffer: Uint8Array,
  maxPages: number,
  fileName: string,
  options?: { allowLocalFallback?: boolean },
): Promise<OcrPagesResult> {
  const engine = getOcrEngine();
  const paddleConfig = resolvePaddleOcrConfig();
  const vlmConfig = resolveVlmOcrConfig();
  const mineruConfig = resolveMineruOcrConfig();
  const allowLocalFallback = options?.allowLocalFallback !== false;

  if (engine === 'mineru') {
    const mineruResult = await ocrPdfPagesWithMineru(buffer, maxPages, fileName, mineruConfig);
    if (mineruResult.pageTexts.length > 0) {
      return mineruResult;
    }
    if (!allowLocalFallback) {
      return mineruResult;
    }

    if (paddleConfig) {
      const paddleResult = await ocrPdfPagesWithPaddle(buffer, maxPages, paddleConfig);
      if (paddleResult.pageTexts.length > 0) {
        return {
          ...paddleResult,
          errorMessages: [...mineruResult.errorMessages, ...paddleResult.errorMessages],
        };
      }
      const tesseractResult = await ocrPdfPagesWithTesseract(buffer, maxPages);
      return {
        ...tesseractResult,
        errorMessages: [...mineruResult.errorMessages, ...paddleResult.errorMessages, ...tesseractResult.errorMessages],
      };
    }

    const tesseractResult = await ocrPdfPagesWithTesseract(buffer, maxPages);
    return {
      ...tesseractResult,
      errorMessages: [...mineruResult.errorMessages, ...tesseractResult.errorMessages],
    };
  }

  if (engine === 'paddle') {
    if (!paddleConfig) {
      return {
        pageTexts: [],
        pageDebugs: [],
        attemptedPages: 0,
        errorMessages: ['paddle_ocr_not_configured'],
        provider: 'paddleocr',
      };
    }
    return ocrPdfPagesWithPaddle(buffer, maxPages, paddleConfig);
  }

  if (engine !== 'tesseract' && vlmConfig) {
    const vlmResult = await ocrPdfPagesWithVlm(buffer, maxPages, vlmConfig);
    if (vlmResult.pageTexts.length > 0 || engine === 'vlm') {
      return vlmResult;
    }

    const tesseractResult = await ocrPdfPagesWithTesseract(buffer, maxPages);
    return {
      ...tesseractResult,
      errorMessages: [...vlmResult.errorMessages, ...tesseractResult.errorMessages],
    };
  }

  if (engine === 'vlm') {
    return {
      pageTexts: [],
      pageDebugs: [],
      attemptedPages: 0,
      errorMessages: ['vlm_ocr_not_configured'],
      provider: 'vlm',
    };
  }

  if (engine === 'auto') {
    const mineruResult = await ocrPdfPagesWithMineru(buffer, maxPages, fileName, mineruConfig);
    if (mineruResult.pageTexts.length > 0) {
      return mineruResult;
    }
  }

  if (paddleConfig) {
    const paddleResult = await ocrPdfPagesWithPaddle(buffer, maxPages, paddleConfig);
    if (paddleResult.pageTexts.length > 0) {
      return paddleResult;
    }

    const tesseractResult = await ocrPdfPagesWithTesseract(buffer, maxPages);
    return {
      ...tesseractResult,
      errorMessages: [...paddleResult.errorMessages, ...tesseractResult.errorMessages],
    };
  }

  return ocrPdfPagesWithTesseract(buffer, maxPages);
}

export async function parsePdfInput(
  base64Data: string,
  fileName = 'document.pdf',
  options?: PdfParseOptions,
): Promise<NormalizedDocument> {
  const raw = Buffer.from(base64Data, 'base64');
  const rawBytes = new Uint8Array(raw);
  let extracted = '';
  let pageTexts: Array<{ page: number; text: string; heading?: string }> = [];
  let parseWarning: string | undefined;
  let extractionErrorMessage: string | undefined;
  let ocrErrorMessage: string | undefined;
  let pdfPageCountHint = Math.max(1, getOcrMaxPages());
  let ocrAttemptedPages = 0;
  let ocrErrorMessages: string[] = [];
  let ocrPageDebugs: OcrPageDebug[] = [];
  let ocrProvider: string | undefined;
  let ocrModel: string | undefined;

  let textIsGarbled = false;

  try {
    const { text, pages, pageTexts: extractedPageTexts } = await extractPdfText(rawBytes);
    extracted = text;
    pdfPageCountHint = pages;
    pageTexts = extractedPageTexts;

    // Detect garbled text from missing ToUnicode CMap — treat as no valid text
    const extractedBody = extracted.replace(/## Page \d+\n\n/g, '');
    if (extracted && isPdfTextGarbled(extractedBody) && !hasRecoverableTextSignals(extractedBody)) {
      textIsGarbled = true;
      extractionErrorMessage = 'extracted_text_appears_garbled';
      extracted = '';
      pageTexts = [];
    }
  } catch (error) {
    extracted = '';
    extractionErrorMessage = error instanceof Error ? error.message : 'unknown_error';
    pdfPageCountHint = (await getPdfPageCount(rawBytes)) ?? Math.max(1, getOcrMaxPages());
  }

  let mergedText = extracted;
  let ocrUsed = false;
  const allowOCR = process.env.ENABLE_PDF_OCR !== 'false';
  const forceOcr = options?.forceOcr === true;

  if (allowOCR && (forceOcr || mergedText.length < PDF_TEXT_MIN_LENGTH)) {
    try {
      const requestedMaxPages = options?.forceOcrMaxPages;
      const forceMaxPages =
        typeof requestedMaxPages === 'number' && Number.isFinite(requestedMaxPages) && requestedMaxPages > 0
          ? Math.floor(requestedMaxPages)
          : pdfPageCountHint;
      const maxPages = forceOcr
        ? Math.max(1, Math.min(forceMaxPages, pdfPageCountHint))
        : Math.max(1, Math.min(getOcrMaxPages(), pdfPageCountHint));
      const ocrResult = await withTimeout(
        ocrPdfPages(rawBytes, maxPages, fileName, { allowLocalFallback: !forceOcr }),
        getOcrTimeoutMs(),
        'pdf_ocr',
      );
      ocrAttemptedPages = ocrResult.attemptedPages;
      ocrErrorMessages = ocrResult.errorMessages;
      ocrPageDebugs = ocrResult.pageDebugs;
      ocrProvider = ocrResult.provider;
      ocrModel = ocrResult.model;

      if (ocrResult.pageTexts.length > 0) {
        const ocrPageTexts = ocrResult.pageTexts.map(({ page, text }) => ({ page, heading: `OCR Page ${page}`, text }));
        const ocrText = ocrPageTexts.map(({ page, text }) => `## OCR Page ${page}\n\n${text}`).join('\n\n');
        ocrUsed = true;

        // Keep extracted text as primary when it already has readable content.
        // OCR is used as fallback/supplement, not a hard overwrite.
        if (mergedText.trim().length > 0) {
          mergedText = `${mergedText}\n\n${ocrText}`.trim();
          pageTexts = [...pageTexts, ...ocrPageTexts];
        } else {
          mergedText = ocrText;
          pageTexts = ocrPageTexts;
        }
      } else {
        ocrErrorMessage = ocrResult.errorMessages[0] || 'ocr_text_too_short';
      }
    } catch (error) {
      ocrErrorMessage = error instanceof Error ? error.message : 'unknown_ocr_error';
      ocrErrorMessages = [ocrErrorMessage];
    }
  }

  if (!mergedText) {
    mergedText = '该 PDF 未能提取到可读文本，已生成占位内容。建议上传可复制文本的 PDF 以获得更好结果。';
    pageTexts = [{ page: 1, heading: 'PDF Notice', text: mergedText }];

    const reasons: string[] = [];
    if (textIsGarbled) {
      reasons.push('文本提取结果为乱码（PDF 可能使用了嵌入字体子集且缺少 Unicode 映射）');
    } else if (extractionErrorMessage) {
      reasons.push(`文本提取失败: ${extractionErrorMessage}`);
    } else {
      reasons.push('文本提取结果为空');
    }

    if (!allowOCR) {
      reasons.push('OCR 已禁用 (ENABLE_PDF_OCR=false)');
    } else if (ocrErrorMessage) {
      reasons.push(`OCR 失败: ${ocrErrorMessage}`);
    } else {
      reasons.push('OCR 未提取到有效文本');
    }
    if (ocrAttemptedPages > 0) {
      reasons.push(`OCR 尝试页数: ${ocrAttemptedPages}`);
    }

    parseWarning = reasons.join('；');
  }

  const markdown = `# ${fileName}\n\n${mergedText}`;
  const sourceRef = createSourceRefFallback({
    type: 'pdf',
    page: 1,
    location: 'page:1',
    text: mergedText.slice(0, 240),
  });
  const chunks = pageTexts.flatMap(({ page, heading, text }) => {
    const pageSourceRef = createSourceRefFallback({
      type: 'pdf',
      page,
      location: `page:${page}`,
      text: text.slice(0, 240),
    });
    return chunkMarkdown(`# ${fileName}\n\n## ${heading || `Page ${page}`}\n\n${text}`, pageSourceRef);
  });

  return {
    markdown,
    chunks: chunks.length > 0 ? chunks : chunkMarkdown(markdown, sourceRef),
    sourceMeta: {
      type: 'pdf',
      title: fileName.replace(/\.pdf$/i, ''),
      sourceFileName: fileName,
      ocrUsed,
      ocrDebug: {
        enabled: allowOCR,
        attempted: allowOCR && (forceOcr || extracted.length < PDF_TEXT_MIN_LENGTH || textIsGarbled),
        provider: ocrProvider,
        model: ocrModel,
        attemptedPages: ocrAttemptedPages,
        acceptedPages: ocrPageDebugs.filter((item) => item.accepted).length,
        errorMessages: ocrErrorMessages,
        pages: ocrPageDebugs,
      },
      parseWarning,
    },
  };
}

export function encodeFileToBase64(fileBuffer: ArrayBuffer): string {
  return Buffer.from(fileBuffer).toString('base64');
}

export function getPdfStats(doc: NormalizedDocument): { pagesHint: number } {
  const matches = doc.markdown.match(/## Page /g);
  return { pagesHint: matches?.length ?? 1 };
}

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { chunkMarkdown } from '@/lib/utils/chunk';
import { createSourceRefFallback } from '@/lib/utils/tree';
import type { NormalizedDocument } from '@/lib/types/mindmap';

const PDF_TEXT_MIN_LENGTH = 200;
const PDF_OCR_MIN_LENGTH = 30;
const PDF_RENDER_SCALE = 2;
const PDF_OCR_MAX_PAGES_DEFAULT = 3;
const PDF_OCR_TIMEOUT_MS_DEFAULT = 45_000;
const PDF_SIPS_TIMEOUT_MS_DEFAULT = 20_000;
const execFileAsync = promisify(execFile);

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
  const workDir = await mkdtemp(path.join(tmpdir(), 'mindmap-pdf-'));
  const inputPdfPath = path.join(workDir, 'input.pdf');
  const outputPngPath = path.join(workDir, 'page-1.png');

  try {
    await writeFile(inputPdfPath, Buffer.from(buffer));
    await execFileAsync('sips', ['-s', 'format', 'png', inputPdfPath, '--out', outputPngPath], {
      timeout: getSipsTimeoutMs(),
    });
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

async function ocrPdfPages(
  buffer: Uint8Array,
  maxPages: number,
): Promise<{
  pageTexts: Array<{ page: number; text: string }>;
  attemptedPages: number;
  errorMessages: string[];
}> {
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
  const errorMessages: string[] = [];
  let attemptedPages = 0;

  try {
    for (let page = 1; page <= maxPages; page += 1) {
      attemptedPages += 1;
      try {
        const pageImage = await renderPdfPageToPng(buffer, page);
        const result = await worker.recognize(pageImage);
        const text = result.data.text?.replace(/\s+/g, ' ').trim() ?? '';

        if (text.length > PDF_OCR_MIN_LENGTH) {
          pageTexts.push({ page, text });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown_ocr_page_error';
        errorMessages.push(`page_${page}:${message}`);
      }
    }

    return { pageTexts, attemptedPages, errorMessages };
  } finally {
    await worker.terminate();
  }
}

export async function parsePdfInput(base64Data: string, fileName = 'document.pdf'): Promise<NormalizedDocument> {
  const raw = Buffer.from(base64Data, 'base64');
  const rawBytes = new Uint8Array(raw);
  let extracted = '';
  let pageTexts: Array<{ page: number; text: string; heading?: string }> = [];
  let parseWarning: string | undefined;
  let extractionErrorMessage: string | undefined;
  let ocrErrorMessage: string | undefined;
  let pdfPageCountHint = 1;
  let ocrAttemptedPages = 0;

  try {
    const { text, pages, pageTexts: extractedPageTexts } = await extractPdfText(rawBytes);
    extracted = text;
    pdfPageCountHint = pages;
    pageTexts = extractedPageTexts;
  } catch (error) {
    extracted = '';
    extractionErrorMessage = error instanceof Error ? error.message : 'unknown_error';
    pdfPageCountHint = (await getPdfPageCount(rawBytes)) ?? 1;
  }

  let mergedText = extracted;
  let ocrUsed = false;
  const allowOCR = process.env.ENABLE_PDF_OCR !== 'false';

  if (allowOCR && mergedText.length < PDF_TEXT_MIN_LENGTH) {
    try {
      const maxPages = Math.max(1, Math.min(getOcrMaxPages(), pdfPageCountHint));
      const ocrResult = await withTimeout(ocrPdfPages(rawBytes, maxPages), getOcrTimeoutMs(), 'pdf_ocr');
      ocrAttemptedPages = ocrResult.attemptedPages;

      if (ocrResult.pageTexts.length > 0) {
        ocrUsed = true;
        mergedText = ocrResult.pageTexts.map(({ page, text }) => `## OCR Page ${page}\n\n${text}`).join('\n\n');
        pageTexts = ocrResult.pageTexts.map(({ page, text }) => ({ page, heading: `OCR Page ${page}`, text }));
      } else {
        ocrErrorMessage = ocrResult.errorMessages[0] || 'ocr_text_too_short';
      }
    } catch (error) {
      ocrErrorMessage = error instanceof Error ? error.message : 'unknown_ocr_error';
    }
  }

  if (!mergedText) {
    mergedText = '该 PDF 未能提取到可读文本，已生成占位内容。建议上传可复制文本的 PDF 以获得更好结果。';
    pageTexts = [{ page: 1, heading: 'PDF Notice', text: mergedText }];

    const reasons: string[] = [];
    if (extractionErrorMessage) {
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

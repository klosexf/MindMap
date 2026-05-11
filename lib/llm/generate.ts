import { existsSync, readFileSync } from 'node:fs';

import { nanoid } from 'nanoid';
import { generateText, streamObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { Agent } from 'undici';

import {
  llmTreeSchema,
  mindMapTreeSchema,
  type LLMMindMapTree,
  type MindMapNode,
  type MindMapTree,
  type NormalizedDocument,
  type SourceReference,
  type TreePatch,
} from '@/lib/types/mindmap';
import {
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  applyTreePatch,
  clampTree,
  countNodes,
  createSourceRefFallback,
  flattenTree,
  getDefaultMindMapTree,
} from '@/lib/utils/tree';
import {
  isWeChatArticleUrl,
  generateWeChatMindMapViaZhipuWebSearch,
  generateWeChatMindMapViaHunyuan,
} from '@/lib/wechat/client';

export type GenerateStreamEvent =
  | { type: 'skeleton'; data: { tree: MindMapTree } }
  | { type: 'node'; data: { patch: TreePatch; node: MindMapNode } }
  | { type: 'complete'; data: { tree: MindMapTree } }
  | { type: 'error'; data: { message: string } };

interface IndexedNode {
  node: MindMapNode;
  parentId?: string;
  index: number;
}

type OpenAICompatibleProvider = 'openai' | 'zhipu' | 'kimi' | 'minimax' | 'qwen' | 'hunyuan' | 'deepseek';

interface OpenAICompatibleProviderConfig {
  keyEnv: string;
  baseEnv: string;
  defaultModel: string;
  defaultBaseUrl?: string;
}

const OPENAI_COMPATIBLE_PROVIDER_MAP: Record<OpenAICompatibleProvider, OpenAICompatibleProviderConfig> = {
  openai: {
    keyEnv: 'OPENAI_API_KEY',
    baseEnv: 'OPENAI_BASE_URL',
    defaultModel: 'gpt-4o-mini',
  },
  zhipu: {
    keyEnv: 'ZHIPU_API_KEY',
    baseEnv: 'ZHIPU_BASE_URL',
    defaultModel: 'glm-4',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  },
  hunyuan: {
    keyEnv: 'HUNYUAN_API_KEY',
    baseEnv: 'HUNYUAN_BASE_URL',
    defaultModel: 'hunyuan-turbos-latest',
    defaultBaseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
  },
  kimi: {
    keyEnv: 'MOONSHOT_API_KEY',
    baseEnv: 'MOONSHOT_BASE_URL',
    defaultModel: 'moonshot-v1-8k',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
  },
  minimax: {
    keyEnv: 'MINIMAX_API_KEY',
    baseEnv: 'MINIMAX_BASE_URL',
    defaultModel: 'abab6.5-chat',
    defaultBaseUrl: 'https://api.minimax.chat/v1',
  },
  qwen: {
    keyEnv: 'DASHSCOPE_API_KEY',
    baseEnv: 'DASHSCOPE_BASE_URL',
    defaultModel: 'qwen-plus',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  deepseek: {
    keyEnv: 'DEEPSEEK_API_KEY',
    baseEnv: 'DEEPSEEK_BASE_URL',
    defaultModel: 'deepseek-chat',
    defaultBaseUrl: 'https://api.deepseek.com',
  },
};

const PROVIDER_ALIAS_MAP: Record<string, OpenAICompatibleProvider> = {
  moonshot: 'kimi',
  dashscope: 'qwen',
};

interface ResolvedLLMConfig {
  provider: string;
  resolvedProvider?: OpenAICompatibleProvider;
  keyEnv?: string;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  supported: boolean;
}

interface LLMRequestConfig {
  maxRetries: number;
  timeoutMs?: number;
}

function isCompatTimingDebugEnabled(): boolean {
  return process.env.DEBUG_COMPAT_PROVIDER_TIMING === 'true';
}

function logCompatTiming(phase: string, payload: Record<string, unknown>): void {
  if (!isCompatTimingDebugEnabled()) return;
  console.log(`[Compat Timing] ${phase}`, payload);
}

export interface MarkdownPreviewResult {
  title: string;
  markdown: string;
  provider: string;
  model: string;
}

export interface MindMapJsonPreviewResult {
  tree: LLMMindMapTree;
  parsedJson: string;
  rawText: string;
  provider: string;
  model: string;
}

export interface AiSummaryResult {
  points: string[];
  provider: string;
  model: string;
  source: 'llm' | 'heuristic';
}

const CA_CERT_FALLBACK_PATHS = ['/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt'];
let cachedFetchWithLocalCA: FetchFunction | null | undefined;

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function resolveCaCertPath(): string | null {
  const explicitPath = process.env.LLM_CA_CERT_PATH?.trim();
  if (explicitPath) {
    return existsSync(explicitPath) ? explicitPath : null;
  }

  const nodeExtraCaPath = process.env.NODE_EXTRA_CA_CERTS?.trim();
  if (nodeExtraCaPath && existsSync(nodeExtraCaPath)) {
    return nodeExtraCaPath;
  }

  const fallbackPath = CA_CERT_FALLBACK_PATHS.find((path) => existsSync(path));
  return fallbackPath || null;
}

function getFetchWithLocalCA(): FetchFunction | undefined {
  if (cachedFetchWithLocalCA !== undefined) {
    return cachedFetchWithLocalCA || undefined;
  }

  const certPath = resolveCaCertPath();
  if (!certPath) {
    cachedFetchWithLocalCA = null;
    return undefined;
  }

  try {
    const ca = readFileSync(certPath, 'utf8');
    const dispatcher = new Agent({ connect: { ca } });

    cachedFetchWithLocalCA = ((input: RequestInfo | URL, init?: RequestInit) => {
      const nextInit = (init || {}) as RequestInit & { dispatcher?: unknown };
      if (nextInit.dispatcher) {
        return fetch(input, nextInit);
      }
      return fetch(input, { ...nextInit, dispatcher } as RequestInit & { dispatcher: Agent });
    }) as FetchFunction;
    return cachedFetchWithLocalCA;
  } catch {
    cachedFetchWithLocalCA = null;
    return undefined;
  }
}

function createProviderClient(llmConfig: ResolvedLLMConfig) {
  const customFetch = getFetchWithLocalCA();

  return createOpenAI({
    apiKey: llmConfig.apiKey,
    baseURL: llmConfig.baseUrl,
    name: llmConfig.resolvedProvider || 'openai',
    fetch: customFetch,
  });
}

function resolveLLMRequestConfig(provider?: OpenAICompatibleProvider): LLMRequestConfig {
  const fallbackRetries = provider === 'openai' ? 2 : 0;
  const maxRetries = parseNonNegativeInt(process.env.LLM_MAX_RETRIES, fallbackRetries);
  const timeoutSeconds = parseNonNegativeInt(process.env.LLM_TIMEOUT, 60);

  return {
    maxRetries,
    timeoutMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined,
  };
}

function resolveLLMConfig(): ResolvedLLMConfig {
  const requestedProvider = (process.env.LLM_PROVIDER || 'openai').trim().toLowerCase();
  const normalizedProvider = PROVIDER_ALIAS_MAP[requestedProvider] ?? requestedProvider;
  const providerConfig = OPENAI_COMPATIBLE_PROVIDER_MAP[normalizedProvider as OpenAICompatibleProvider];

  if (!providerConfig) {
    return {
      provider: requestedProvider,
      model: process.env.LLM_MODEL?.trim() || 'gpt-4o-mini',
      supported: false,
    };
  }

  const apiKey = process.env[providerConfig.keyEnv]?.trim();
  const baseUrl = process.env[providerConfig.baseEnv]?.trim() || providerConfig.defaultBaseUrl;

  return {
    provider: requestedProvider,
    resolvedProvider: normalizedProvider as OpenAICompatibleProvider,
    keyEnv: providerConfig.keyEnv,
    apiKey,
    baseUrl,
    model: process.env.LLM_MODEL?.trim() || providerConfig.defaultModel,
    supported: true,
  };
}

function makeDefaultSourceRef(doc: NormalizedDocument): SourceReference {
  return createSourceRefFallback({
    type: doc.sourceMeta.type,
    url: doc.sourceMeta.sourceUrl,
    location: doc.sourceMeta.sourceFileName,
    text: doc.chunks[0]?.text?.slice(0, 240),
    page: doc.sourceMeta.type === 'pdf' ? 1 : undefined,
  });
}

function createHeuristicNode(
  content: string,
  sourceRef: SourceReference,
  type: MindMapNode['meta']['type'] = 'detail',
  confidence = 0.65,
): MindMapNode {
  return {
    id: nanoid(),
    content: content.trim().slice(0, 120) || '未命名节点',
    collapsed: false,
    meta: {
      sourceRef,
      type,
      confidence,
      createdAt: Date.now(),
      createdBy: 'ai',
    },
    children: [],
  };
}

function cleanMarkdownText(text: string): string {
  return text
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clean markdown for LLM input: remove garbled/OCR-noise lines while
 * preserving readable content and document structure (headings, etc).
 *
 * Key design: instead of discarding entire noisy lines (which loses valid
 * CJK text mixed with OCR noise), we try to extract readable sub-segments.
 */
function cleanMarkdownForLLM(markdown: string): string {
  const lines = markdown.split('\n');
  const result: string[] = [];
  let totalContentLines = 0;
  let totalKeptLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Keep empty lines (paragraph separators)
    if (!trimmed) {
      result.push('');
      continue;
    }

    // Keep markdown headings
    if (/^#{1,6}\s+/.test(trimmed)) {
      const headingText = trimmed.replace(/^#{1,6}\s+/, '').trim();
      if (PAGE_LABEL_RE.test(headingText)) {
        continue;
      }
      if (/\.(pdf|doc|docx|txt|md|ppt|pptx|xlsx|xls|html)$/i.test(headingText)) {
        continue;
      }
      result.push(trimmed);
      continue;
    }

    if (/^---$/.test(trimmed) || /^\[(?:page|ocr-page):\d+\]$/.test(trimmed)) {
      continue;
    }

    if (/\.(pdf|doc|docx|txt|md|ppt|pptx|xlsx|xls|html)$/i.test(trimmed) || /[^\n]{8,60}\.(pdf|doc|docx)\b/i.test(trimmed)) {
      continue;
    }

    totalContentLines++;

    // Strip common punctuation for analysis
    const analysisText = trimmed
      .replace(/[,;:|.!?，。！？、：；|｜\-—–()（）\[\]【】{}\/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // If the line has enough CJK content (>=20%), it's likely readable — keep as-is
    const cjkChars = (analysisText.match(/[\u3400-\u9fff]/g) || []).length;
    const totalNonSpace = analysisText.replace(/\s/g, '').length;
    if (totalNonSpace > 0 && cjkChars / totalNonSpace >= 0.2) {
      const compacted = sanitizeSentence(trimmed);
      const candidate = compacted || trimmed;
      const candidateTokens = candidate.split(/\s+/).filter(Boolean);
      const noiseTokenCount = candidateTokens.filter((token) => isLikelyNoiseToken(token, true)).length;
      const hasHeavyNoise = candidateTokens.length >= 4 && noiseTokenCount / candidateTokens.length > 0.45;

      result.push(hasHeavyNoise ? compacted || trimmed : candidate);
      totalKeptLines++;
      continue;
    }

    // If the line is short and mostly numbers/dates/phones, keep it
    const digitAndPunct = (analysisText.match(/[\d\s\-/:.]/g) || []).length;
    if (totalNonSpace > 0 && digitAndPunct / analysisText.length >= 0.7 && analysisText.length < 80) {
      result.push(trimmed);
      totalKeptLines++;
      continue;
    }

    // Check if the line contains ANY meaningful CJK content mixed with noise.
    // If so, try to extract readable segments instead of discarding the whole line.
    if (cjkChars >= 3) {
      const extracted = extractReadableSegmentsFromLine(trimmed);
      if (extracted) {
        result.push(extracted);
        totalKeptLines++;
        continue;
      }
    }

    // Check for garbled text using existing detector
    if (isGarbledText(analysisText)) {
      continue; // Skip this line
    }

    // Filter out lines that are dominated by long numeric IDs / phone numbers
    // These are common in OCR noise from forms and PDF headers
    const tokens = analysisText.split(/\s+/).filter(Boolean);
    if (tokens.length >= 3) {
      const hasCjkContext = tokens.some((t) => CJK_CHAR_RE.test(t));
      const noiseTokens = tokens.filter((t) => isLikelyNoiseToken(t, hasCjkContext)).length;
      // Also count standalone long-number tokens as noise
      const longNumericTokens = tokens.filter((t) => /^\d{7,}$/.test(t)).length;
      const totalNoise = noiseTokens + longNumericTokens;
      // If more than 50% of tokens are noise (including long numbers), skip
      if (totalNoise / tokens.length > 0.5) {
        continue;
      }
    }

    result.push(trimmed);
    totalKeptLines++;
  }

  const cleaned = result.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // Safety net: if we filtered out too aggressively (>70% of content lines dropped),
  // fall back to a lighter cleaning that only removes clearly-garbled tokens
  if (totalContentLines > 2 && totalKeptLines / totalContentLines < 0.3) {
    return lightCleanMarkdown(markdown);
  }

  return cleaned;
}

/**
 * Attempt to extract readable sub-segments from a noisy OCR line that contains
 * both real CJK text and garbage. Splits on boundaries and keeps segments that
 * pass readability checks.
 */
function extractReadableSegmentsFromLine(line: string): string | null {
  // Split the line into segments on common delimiters that separate logical units
  // OCR often outputs: [garble] [real content] [garble] | [more content] [garble]
  const segments = line.split(/(\s*[|｜]\s*|\s{2,}|\s+(?=[\u3400-\u9fff])|(?<=[\u3400-\u9fff])\s+)/);

  const keptSegments: string[] = [];

  for (const seg of segments) {
    const trimmedSeg = seg.trim();
    if (!trimmedSeg || trimmedSeg.length < 2) continue;

    // Analyze segment quality
    const segAnalysis = trimmedSeg
      .replace(/[,;:|.!?，。！？、：；\-—–()（）\[\]【】{}\/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const segCJK = (segAnalysis.match(/[\u3400-\u9fff]/g) || []).length;
    const segTotal = segAnalysis.replace(/\s/g, '').length;

    // Keep segments with good CJK ratio or short clean segments
    if (segTotal > 0 && segCJK / segTotal >= 0.25) {
      keptSegments.push(trimmedSeg);
      continue;
    }

    // Short numeric/date-like segments
    if (trimmedSeg.length < 30 && /^[\d\s\-/:.+@]+$/.test(trimmedSeg.replace(/[()（）]/g, ''))) {
      keptSegments.push(trimmedSeg);
      continue;
    }

    // Extract numeric sub-segments from mixed segments (e.g. "REE 1993.07.04" → "1993.07.04")
    const numericParts = segAnalysis.split(/\s+/).filter((p) => isNumericToken(p));
    if (numericParts.length > 0) {
      keptSegments.push(...numericParts);
      // If segment has no CJK at all, numeric parts are all we can salvage
      if (segCJK === 0) continue;
    }

    // Segment with any CJK and not detected as garbled
    if (segCJK >= 1 && !isGarbledText(segAnalysis)) {
      keptSegments.push(trimmedSeg);
      continue;
    }

    // Pure ASCII segment: drop if every token looks like noise
    if (segCJK === 0) {
      const segTokens = segAnalysis.split(/\s+/).filter(Boolean);
      if (segTokens.length === 0) continue;
      const noiseCount = segTokens.filter((t) => isLikelyNoiseToken(t, false)).length;
      if (noiseCount === segTokens.length) {
        continue; // All tokens are noise — drop the segment
      }
      // Partially clean: keep conservatively
      keptSegments.push(trimmedSeg);
    }
  }

  if (keptSegments.length === 0) return null;
  if (keptSegments.length === 1) return keptSegments[0].length >= 4 ? keptSegments[0] : null;

  // Join kept segments with spaces
  const joined = keptSegments.join(' ');
  return joined.length >= 4 ? joined : null;
}

/**
 * Lighter cleaning pass used as fallback when aggressive filtering removed too much.
 * Only removes obviously garbled tokens/sentences, preserves most content.
 */
function lightCleanMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      result.push('');
      continue;
    }

    // Always keep headings (except page-label headings)
    if (/^#{1,6}\s+/.test(trimmed)) {
      const headingText = trimmed.replace(/^#{1,6}\s+/, '').trim();
      if (PAGE_LABEL_RE.test(headingText)) {
        continue;
      }
      result.push(trimmed);
      continue;
    }

    if (/^---$/.test(trimmed) || /^\[(?:page|ocr-page):\d+\]$/.test(trimmed)) {
      continue;
    }

    // Apply sanitizeSentence which does per-token cleaning
    const sanitized = sanitizeSentence(trimmed);
    if (sanitized && sanitized.length >= 2 && !isGarbledText(sanitized)) {
      result.push(sanitized);
    } else if (trimmed.length >= 2) {
      // Even if garbled, try keeping original for LLM to make sense of
      const hasAnyCJK = /[\u3400-\u9fff]/.test(trimmed);
      if (hasAnyCJK) {
        result.push(trimmed);
      }
    }
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const CJK_CHAR_RE = /[\u3400-\u9fff]/;
const ASCII_TOKEN_ALLOWLIST = new Set(['AI', 'AIGC', 'API', 'APP', 'B2B', 'B2C', 'KPI', 'OKR', 'PDF', 'SQL', 'UI', 'UX']);

function normalizeToken(token: string): string {
  return token.replace(/^[^\p{L}\p{N}\u3400-\u9fff]+|[^\p{L}\p{N}\u3400-\u9fff]+$/gu, '');
}

function isNumericToken(token: string): boolean {
  return /^[\d]+([./:\-][\d]+)*$/.test(token);
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

function isLikelyNoiseToken(token: string, hasCjkContext: boolean): boolean {
  if (!token) return true;
  if (token.length > 18) return true;
  if (/[A-Za-z]/.test(token) && /\d/.test(token) && token.length >= 8) return true;
  if (/[_@]/.test(token) && token.length >= 6) return true;
  if (/([A-Za-z])\1{4,}/.test(token)) return true;

  // Long numeric sequences (phone numbers, IDs, form codes) are noise
  // unless they look like plausible dates or short counts
  if (/^\d+$/.test(token) && token.length >= 7) {
    // Allow common date-like patterns: YYYY, YYYYMM, YYYYMMDD, MMDD
    if (/^(19|20)\d{2}([01]\d)?([0-3]\d)?$/.test(token)) return false;
    if (/^[0-3]?\d[0-3]?\d$/.test(token) && token.length <= 4) return false;
    // Everything else 7+ digits is likely an ID/phone/form code → noise
    return true;
  }

  const upper = token.toUpperCase();
  const allUpperAscii = /^[A-Z]{3,}$/.test(token);
  if (allUpperAscii && !ASCII_TOKEN_ALLOWLIST.has(upper)) return true;

  if (/^[A-Za-z]{2,}$/.test(token)) {
    const vowelCount = (token.match(/[aeiou]/gi) || []).length;
    const vowelRatio = vowelCount / token.length;
    // Extremely low vowel ratio → garbled regardless of CJK context
    if (vowelRatio < 0.15 && token.length >= 4) {
      return true;
    }
    // 4+ consecutive consonants → garbled regardless of CJK context
    const consonantClusters = token.match(/[bcdfghjklmnpqrstvwxyz]{4,}/gi) || [];
    if (consonantClusters.length > 0) {
      return true;
    }
    // Only apply strict upper-case check when there IS a CJK context
    if (hasCjkContext) {
      const upperChars = (token.match(/[A-Z]/g) || []).length;
      const upperRatio = upperChars / token.length;
      if (upperRatio >= 0.6 && !ASCII_TOKEN_ALLOWLIST.has(upper)) {
        return true;
      }
    }
  }

  if (/[A-Za-z]/.test(token) && /\d/.test(token) && token.length >= 5) {
    const letterCount = (token.match(/[A-Za-z]/g) || []).length;
    const digitCount = (token.match(/\d/g) || []).length;
    if (letterCount >= 3 && digitCount >= 2 && !/^[A-Za-z]+\d+$/.test(token) && !/^\d+[A-Za-z]+$/.test(token)) {
      return true;
    }
  }

  return false;
}

/**
 * Detect whether a CJK token looks like garbled/noisy text.
 * Garbled OCR output often produces CJK strings that don't contain any
 * recognizable words or meaningful patterns — just random characters mashed together.
 */
function isGarbledCjkToken(token: string): boolean {
  if (!CJK_CHAR_RE.test(token)) return false;
  if (token.length < 4) return false;

  // Very long CJK tokens without any common punctuation or structure are suspicious
  if (token.length >= 12) {
    // Check for common Chinese function words that indicate real text
    const hasFunctionWord = /的|是|在|和|了|有|不|这|为|与|对|以|到|从|及|等|中|上|下|人|大|小|好|用|进行|通过|可以|需要|应该|能够/.test(token);
    if (!hasFunctionWord) return true;
  }

  // CJK tokens with repeated characters are often OCR errors
  if (/(.)\1{2,}/.test(token)) return true;

  return false;
}

function shouldKeepAsciiTokenInCjkContext(token: string): boolean {
  const upper = token.toUpperCase();
  if (ASCII_TOKEN_ALLOWLIST.has(upper)) return true;
  if (isNumericToken(token)) return true;

  if (token.length < 5) return false;
  if (!/^[a-z]+$/.test(token)) return false;
  if (!/[aeiou]/.test(token)) return false;
  if (isLikelyNoiseToken(token, true)) return false;
  return true;
}

function isGarbledText(text: string): boolean {
  if (!text || text.length < 5) return false;

  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  let garbledCount = 0;
  for (const token of tokens) {
    if (/^[A-Za-z]+$/.test(token)) {
      const vowelCount = (token.match(/[aeiou]/gi) || []).length;
      const vowelRatio = vowelCount / token.length;
      if (vowelRatio < 0.15 && token.length >= 4) {
        garbledCount++;
        continue;
      }
      const consonantClusters = token.match(/[bcdfghjklmnpqrstvwxyz]{4,}/gi) || [];
      if (consonantClusters.length > 0) {
        garbledCount++;
        continue;
      }
    }
    if (/[A-Z]{3,}/.test(token) && /[a-z]/.test(token)) {
      const upperRatio = (token.match(/[A-Z]/g) || []).length / token.length;
      if (upperRatio > 0.5) {
        garbledCount++;
      }
    }
  }

  return garbledCount / tokens.length >= 0.4;
}

function sanitizeSentence(sentence: string): string {
  const normalizedTokens = sentence
    .split(/\s+/)
    .map((token) => normalizeToken(token))
    .filter(Boolean);

  const hasCjkContext = normalizedTokens.some((token) => CJK_CHAR_RE.test(token));
  const keptTokens = normalizedTokens.filter((token) => {
    // Preserve ALL CJK tokens in general sanitization — they're almost always
    // legitimate content. Garbled CJK detection should only happen at the
    // final tree-node level where we have more context.
    if (CJK_CHAR_RE.test(token)) return true;
    if (isLikelyNoiseToken(token, hasCjkContext)) return false;
    if (!hasCjkContext) {
      // Without CJK context, still filter: keep numbers, allowlist, and
      // normal-looking English words (have lowercase + vowels)
      if (isNumericToken(token)) return true;
      if (ASCII_TOKEN_ALLOWLIST.has(token.toUpperCase())) return true;
      const hasLowercase = /[a-z]/.test(token);
      const hasVowel = /[aeiou]/i.test(token);
      return hasLowercase && hasVowel;
    }
    return shouldKeepAsciiTokenInCjkContext(token);
  });

  const merged = collapseCjkSpacing(keptTokens.join(' '))
    .replace(/\s+([,.;:!?，。！？、：；）\]】])/g, '$1')
    .replace(/([（(\[【])\s+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return merged;
}

function isReadableSentence(sentence: string): boolean {
  if (!sentence) return false;
  
  if (isGarbledText(sentence)) return false;

  const cjkChars = sentence.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const totalChars = sentence.replace(/\s/g, '').length;
  if (cjkChars >= 2) {
    const cjkRatio = cjkChars / totalChars;
    if (cjkRatio >= 0.3) return true;
  }

  const tokens = sentence
    .split(/\s+/)
    .map((token) => normalizeToken(token))
    .filter(Boolean);

  const asciiAlphaTokens = tokens.filter((token) => /[A-Za-z]/.test(token));
  if (asciiAlphaTokens.length < 3) return false;

  const lowercaseChars = sentence.match(/[a-z]/g)?.length ?? 0;
  const uppercaseTokens = asciiAlphaTokens.filter((token) => /^[A-Z]{2,}$/.test(token)).length;
  const uppercaseRatio = uppercaseTokens / asciiAlphaTokens.length;
  const noVowelLongTokenRatio =
    asciiAlphaTokens.filter((token) => token.length >= 6 && !/[aeiou]/i.test(token)).length / asciiAlphaTokens.length;

  if (lowercaseChars < 3 && uppercaseRatio >= 0.5) return false;
  if (uppercaseRatio >= 0.75) return false;
  if (noVowelLongTokenRatio >= 0.4) return false;

  const asciiWords = sentence
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => /^[A-Za-z][A-Za-z-]*$/.test(token));
  return asciiWords.length >= 3;
}

function isLikelyNoisyMixedText(text: string): boolean {
  if (!text) return false;

  const tokens = text
    .split(/\s+/)
    .map((token) => normalizeToken(token))
    .filter(Boolean);
  if (tokens.length === 0) return false;

  const cjkTokenCount = tokens.filter((token) => CJK_CHAR_RE.test(token)).length;
  if (cjkTokenCount === 0) return false;

  const asciiTokens = tokens.filter((token) => /^[A-Za-z]+$/.test(token));
  if (asciiTokens.length < 4) return false;

  const suspiciousAscii = asciiTokens.filter((token) => {
    const upper = token.toUpperCase();
    if (ASCII_TOKEN_ALLOWLIST.has(upper)) return false;
    if (token.length <= 2) return true;
    if (isLikelyNoiseToken(token, true)) return true;
    if (token.length <= 4 && !/[aeiou]/i.test(token)) return true;
    return false;
  }).length;

  return suspiciousAscii / asciiTokens.length >= 0.5;
}

function sanitizeTreeNodeForOutput(node: MindMapNode): MindMapNode[] {
  const sanitizedChildren = (node.children || []).flatMap((child) => sanitizeTreeNodeForOutput(child));
  const content = sanitizeSentence(node.content) || node.content.trim();
  const trimmed = content.slice(0, 120).trim();

  if (!trimmed) {
    return sanitizedChildren;
  }

  if (isGarbledText(trimmed) || isLikelyNoisyMixedText(trimmed)) {
    return sanitizedChildren;
  }

  // Filter out nodes that are purely numeric (IDs, phone numbers, counts without context)
  if (/^\d+$/.test(trimmed) && trimmed.length >= 4) {
    return sanitizedChildren;
  }

  if (PAGE_LABEL_RE.test(trimmed)) {
    return sanitizedChildren;
  }

  // Filter out nodes that look like a mix of numbers and fragments with no coherent meaning
  // e.g. "04 13352824120 92188547600 求职目标产品经理自我评价 25 20007"
  if (/^\d{2,}\s/.test(trimmed) && trimmed.split(/\s+/).filter(t => /^\d{4,}$/.test(t)).length >= 2) {
    return sanitizedChildren;
  }

  return [{ ...node, content: trimmed, children: sanitizedChildren }];
}

function sanitizeMindMapTreeForOutput(tree: MindMapTree, fallbackTitle: string): MindMapTree {
  const rootContent = sanitizeSentence(tree.root.content) || tree.root.content.trim() || fallbackTitle || '思维导图';
  const root = {
    ...tree.root,
    content: rootContent.slice(0, 120).trim() || fallbackTitle || '思维导图',
    children: (tree.root.children || []).flatMap((child) => sanitizeTreeNodeForOutput(child)),
  };

  return {
    ...tree,
    root,
  };
}

const CATEGORY_LABEL_RE = /(经历|背景|评价|信息|技能|项目|职责|成果|总结|目标|方式|教育|工作|联系)/;

function isCategoryLikeLabel(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (CATEGORY_LABEL_RE.test(trimmed)) return true;
  // Very short pure-CJK labels are usually category headers.
  return /^[\u3400-\u9fff]{2,6}$/.test(trimmed);
}

function collectChunkSentences(doc: NormalizedDocument): Array<{ sentence: string; sourceRef: SourceReference }> {
  const collected: Array<{ sentence: string; sourceRef: SourceReference }> = [];
  for (const chunk of doc.chunks) {
    const chunkSourceRef = chunk.sourceRef || makeDefaultSourceRef(doc);
    const sentences = extractSentences(chunk.text, 8);
    for (const sentence of sentences) {
      const normalized = sentence.trim().slice(0, 90);
      if (!normalized) continue;
      if (isGarbledText(normalized) || isLikelyNoisyMixedText(normalized)) continue;
      collected.push({ sentence: normalized, sourceRef: chunkSourceRef });
    }

    for (const line of chunk.text.split(/\n+/)) {
      const normalized = sanitizeSentence(line.replace(/^#{1,6}\s+/, '')).trim().slice(0, 90);
      if (!normalized || PAGE_LABEL_RE.test(normalized)) continue;
      if (isGarbledText(normalized) || isLikelyNoisyMixedText(normalized)) continue;
      if (!isReadableSentence(normalized) && !/[\u3400-\u9fff]{4,}/.test(normalized)) continue;
      if (collected.some((item) => item.sentence === normalized)) continue;
      collected.push({ sentence: normalized, sourceRef: chunkSourceRef });
    }
  }
  return collected;
}

function getBranchKeywordHints(branchLabel: string): string[] {
  const hints: string[] = [];
  const hintGroups: Array<[RegExp, string[]]> = [
    [/能力|技能|专长|优势|核心/, ['产品', '规划', '需求', '商业化', '营收', '流量', '转化', '用户', '数据', '运营', '团队', '生态', '策略']],
    [/项目|经历|工作|经验/, ['负责', '主导', '参与', '产品', '运营', '项目', '系统', '业务', '平台', '直播', '游戏', '团队']],
    [/职责|责任|角色/, ['负责', '主导', '参与', '搭建', '设计', '规划', '管理', '推进']],
    [/成果|业绩|产出|结果/, ['提升', '增长', '转化', '营收', '数据', '成功', '实现', '完成']],
    [/教育|学历|学校/, ['大学', '本科', '硕士', '专业', '学院', '毕业']],
  ];

  for (const [pattern, words] of hintGroups) {
    if (pattern.test(branchLabel)) hints.push(...words);
  }

  return Array.from(new Set(hints));
}

function scoreSentenceForBranch(branchLabel: string, sentence: string): number {
  const branchKeywords = branchLabel.match(/[\u3400-\u9fff]{3,6}|[A-Za-z]{3,}/g) || [];
  let score = 0;

  if (branchKeywords.length === 0) {
    const shortKeywords = branchLabel.match(/[\u3400-\u9fff]{2}/g) || [];
    for (const kw of shortKeywords) {
      if (sentence.includes(kw)) score += 1;
    }
  } else {
    for (const keyword of branchKeywords) {
      if (sentence.includes(keyword)) {
        score += keyword.length >= 4 ? 3 : 2;
      }
    }
  }

  for (const hint of getBranchKeywordHints(branchLabel)) {
    if (sentence.includes(hint)) {
      score += 1;
    }
  }

  const conflictWords = [
    '运营指标', '项目成果', '营收增长', '转化率提升', '成本降低', '周期缩短', '团队规模', '活跃度', '留存率', '送礼',
    '交易结算', '结算', '对账', '清算', '报销', '审批', '付款', '收款', '发票', '税务',
    '采购', '库存', '物流', '客服', '工单', '招聘', '考勤', '绩效', '预算', '合同',
  ];
  for (const conflictWord of conflictWords) {
    if (sentence.includes(conflictWord)) {
      score -= 1;
    }
  }
  return Math.max(0, score);
}

function ensureFirstLayerDetails(tree: MindMapTree, doc: NormalizedDocument): MindMapTree {
  const topChildren = tree.root.children || [];
  if (topChildren.length === 0) return tree;

  const pool = collectChunkSentences(doc);
  if (pool.length === 0) return tree;
  const MIN_SCORE_THRESHOLD = 2;
  const MAX_DETAILS_PER_BRANCH = 3;

  function expandNode(node: MindMapNode, depth: number): MindMapNode {
    const expandedChildren = (node.children || []).map((child) => expandNode(child, depth + 1));
    const nodeWithChildren = { ...node, children: expandedChildren };
    const shouldTryExpand = depth >= 1 && depth <= 2 && expandedChildren.length === 0;
    if (!shouldTryExpand) return nodeWithChildren;

    const minimumScore = isCategoryLikeLabel(node.content) ? MIN_SCORE_THRESHOLD : 3;
    const ranked = pool
      .map((item) => ({
        ...item,
        score: scoreSentenceForBranch(node.content, item.sentence),
      }))
      .filter((item) => item.score >= minimumScore)
      .sort((a, b) => b.score - a.score);

    const selected = ranked
      .filter((item) => item.sentence !== node.content.trim())
      .slice(0, MAX_DETAILS_PER_BRANCH);

    if (selected.length === 0) return nodeWithChildren;

    const details = selected.map((item) =>
      createHeuristicNode(item.sentence, item.sourceRef, 'detail', 0.6),
    );

    return {
      ...nodeWithChildren,
      children: details,
    };
  }

  return {
    ...tree,
    root: {
      ...tree.root,
      children: topChildren.map((child) => expandNode(child, 1)),
    },
  };
}

export function repairSparseFirstLayerForDoc(tree: MindMapTree, doc: NormalizedDocument): MindMapTree {
  const fallbackTitle = tree.meta.title || doc.sourceMeta.title || '思维导图';
  const sanitized = sanitizeMindMapTreeForOutput(tree, fallbackTitle);
  const result = ensureFirstLayerDetails(sanitized, doc);
  const validated = validateSemanticHierarchy(result);
  const restructured = restructureOversizedBranches(validated);
  const deduped = deduplicateNodeTitles(restructured);
  const filtered = detectAndFilterLowQualityTitles(deduped);
  const expanded = ensureFirstLayerDetails(filtered, doc);
  return splitOversizedNodeContent(expanded);
}

export function validateSemanticHierarchy(tree: MindMapTree): MindMapTree {
  const topChildren = tree.root.children;
  if (!topChildren || topChildren.length === 0) return tree;

  const SKILL_PARENT_KEYWORDS = ['技能', '技术', '能力', '专长', '工具'];
  const NON_SKILL_CHILD_PATTERNS: Array<[RegExp, string]> = [
    [/结算|清算|对账|报销|付款|收款|发票|税务/, '财务操作'],
    [/审批|审核|流程|合规|监管|稽查|审计/, '审批/合规流程'],
    [/运营|拉新|促活|留存|转化|活跃|增长|DAU|MAU/, '运营指标'],
    [/采购|库存|物流|供应链|仓储|配送/, '供应链操作'],
    [/客服|投诉|售后|工单|咨询|热线/, '客服操作'],
    [/销售|拜访|签单|回款|客户开发|渠道/, '销售活动'],
    [/招聘|面试|入职|离职|考勤|绩效|薪酬|培训/, 'HR操作'],
    [/合同|法务|诉讼|仲裁|知识产权|商标/, '法务操作'],
    [/预算|成本|费用|利润|营收|亏损|毛利/, '财务指标'],
    [/市场|推广|投放|广告|品牌|PR|公关/, '市场活动'],
  ];

  const isSkillParent = (label: string): boolean => {
    return SKILL_PARENT_KEYWORDS.some((kw) => label.includes(kw));
  };

  const isStrictSkillParent = (label: string): boolean => {
    return /技能|技术|专长|工具/.test(label);
  };

  const isNonSkillChild = (childLabel: string, strict: boolean): boolean => {
    const broadAbilityBlocklist = /结算|清算|对账|报销|付款|收款|发票|税务|审批|审核|采购|库存|物流|客服|工单|招聘|考勤|绩效|合同|法务|诉讼|仲裁|知识产权/;
    if (!strict) {
      return broadAbilityBlocklist.test(childLabel);
    }

    for (const [pattern, category] of NON_SKILL_CHILD_PATTERNS) {
      if (pattern.test(childLabel)) return true;
    }
    return false;
  };

  const nextTopChildren = topChildren.map((parent) => {
    if (!isSkillParent(parent.content)) return parent;
    const parentChildren = parent.children;
    if (!parentChildren || parentChildren.length === 0) return parent;
    const strict = isStrictSkillParent(parent.content);

    const filteredChildren = parentChildren.filter((child) => {
      if (isNonSkillChild(child.content, strict)) {
        return false;
      }
      return true;
    });

    if (filteredChildren.length === parentChildren.length) return parent;

    return {
      ...parent,
      children: filteredChildren,
    };
  });

  const changed = nextTopChildren.some(
    (child, i) => (child.children?.length ?? 0) !== (topChildren[i]?.children?.length ?? 0),
  );

  if (!changed) return tree;

  return {
    ...tree,
    root: {
      ...tree.root,
      children: nextTopChildren,
    },
  };
}

const MAX_CHILDREN_PER_PARENT = 8;

export function restructureOversizedBranches(tree: MindMapTree): MindMapTree {
  let needsRestructure = false;

  function checkNeeded(node: { children?: MindMapNode[] }, depth: number): void {
    const children = node.children;
    if (!children) return;
    if (children.length > MAX_CHILDREN_PER_PARENT && depth < MAX_TREE_DEPTH - 1) {
      needsRestructure = true;
      return;
    }
    for (const child of children) {
      if (needsRestructure) return;
      checkNeeded(child, depth + 1);
    }
  }
  checkNeeded(tree.root, 0);
  if (!needsRestructure) return tree;

  function extractKeyword(text: string): string {
    const m = text.match(/[\u3400-\u9fff]{2,4}|[A-Za-z]{3,}/);
    return m ? m[0] : text.slice(0, 4);
  }

  function restructure(node: MindMapNode, depth: number): MindMapNode {
    const children = node.children;
    if (!children || children.length <= MAX_CHILDREN_PER_PARENT) {
      return {
        ...node,
        children: children?.map((c) => restructure(c, depth + 1)),
      };
    }

    if (depth >= MAX_TREE_DEPTH - 1) {
      const truncated = children.slice(0, MAX_CHILDREN_PER_PARENT).map((c) => restructure(c, depth + 1));
      return { ...node, children: truncated };
    }

    const keywordMap = new Map<string, MindMapNode[]>();
    for (const child of children) {
      const kw = extractKeyword(child.content);
      const existing = keywordMap.get(kw) || [];
      existing.push(child);
      keywordMap.set(kw, existing);
    }

    const groups: MindMapNode[][] = [];
    const merged = new Set<string>();
    for (const [kw, items] of keywordMap) {
      if (merged.has(kw)) continue;
      if (items.length === 1) {
        let bestMerge: string | null = null;
        for (const [otherKw, otherItems] of keywordMap) {
          if (otherKw === kw || merged.has(otherKw)) continue;
          if (otherItems.length === 1 && otherKw.slice(0, 1) === kw.slice(0, 1)) {
            bestMerge = otherKw;
            break;
          }
        }
        if (bestMerge) {
          const otherItems = keywordMap.get(bestMerge)!;
          groups.push([...items, ...otherItems]);
          merged.add(kw);
          merged.add(bestMerge);
        } else {
          groups.push(items);
          merged.add(kw);
        }
      } else {
        groups.push(items);
        merged.add(kw);
      }
    }

    groups.sort((a, b) => b.length - a.length);

    while (groups.length > MAX_CHILDREN_PER_PARENT) {
      const smallest = groups.pop()!;
      const secondSmallest = groups.pop()!;
      groups.push([...smallest, ...secondSmallest]);
      groups.sort((a, b) => b.length - a.length);
    }

    if (groups.length < 2) {
      const chunkSize = Math.ceil(children.length / Math.min(3, Math.ceil(children.length / MAX_CHILDREN_PER_PARENT)));
      const chunked: MindMapNode[][] = [];
      for (let i = 0; i < children.length; i += chunkSize) {
        chunked.push(children.slice(i, i + chunkSize));
      }
      groups.length = 0;
      groups.push(...chunked);
    }

    const sourceRef = children[0]?.meta.sourceRef || createSourceRefFallback({ type: 'text' });

    const newChildren = groups.map((group, idx) => {
      const keywords = group.map((c) => extractKeyword(c.content));
      const freq: Record<string, number> = {};
      for (const kw of keywords) {
        if (kw.length >= 2) freq[kw] = (freq[kw] || 0) + 1;
      }
      const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 2);
      const label = top.length > 0
        ? top.map(([w]) => w).join(' / ')
        : `分组 ${idx + 1}`;
      const finalLabel = label.length > 50 ? label.slice(0, 50) : label;

      const groupNode = createHeuristicNode(finalLabel, sourceRef, 'detail', 0.7);
      groupNode.children = group.map((c) => restructure(c, depth + 2));
      return groupNode;
    });

    return { ...node, children: newChildren };
  }

  return { ...tree, root: restructure(tree.root, 0) };
}

export function deduplicateNodeTitles(tree: MindMapTree): MindMapTree {
  function normalize(text: string): string {
    return text.replace(/\s+/g, '').replace(/[·\-\|\/\\]/g, '').toLowerCase();
  }

  function areSimilar(a: string, b: string): boolean {
    const na = normalize(a);
    const nb = normalize(b);
    if (na === nb) return true;
    if (na.length <= 4 && nb.length <= 4) return na === nb;
    if (na.includes(nb) || nb.includes(na)) {
      const shorter = na.length < nb.length ? na : nb;
      const longer = na.length < nb.length ? nb : na;
      return shorter.length >= Math.min(4, longer.length * 0.5);
    }
    return false;
  }

  function isRedundantChild(childContent: string, parentContent: string): boolean {
    const nc = normalize(childContent);
    const np = normalize(parentContent);
    if (nc === np) return true;
    if (nc.length <= np.length) return false;
    if (nc.includes(np)) {
      return nc.length - np.length <= 4;
    }
    return false;
  }

  function dedup(node: MindMapNode): MindMapNode {
    let children = node.children;
    if (!children || children.length === 0) {
      return { ...node, children };
    }

    const nonRedundant = children.filter(
      (child) => !isRedundantChild(child.content, node.content),
    );

    const allRedundant = nonRedundant.length === 0 && children.length > 0;
    const effectiveChildren = nonRedundant.length > 0 ? nonRedundant : children;

    const filtered: MindMapNode[] = [];
    let siblingCollisionCount = 0;

    for (let i = 0; i < effectiveChildren.length; i++) {
      const child = effectiveChildren[i];
      const dupIndex = filtered.findIndex((f) => areSimilar(f.content, child.content));
      if (dupIndex >= 0) {
        siblingCollisionCount += 1;
        const suffix = `(${siblingCollisionCount})`;
        filtered.push({ ...dedup(child), content: child.content + suffix });
        continue;
      }

      if (allRedundant) {
        siblingCollisionCount += 1;
        const suffix = `(${siblingCollisionCount})`;
        filtered.push({ ...dedup(child), content: child.content + suffix });
        continue;
      }

      filtered.push(dedup(child));
    }

    return {
      ...node,
      children: filtered,
    };
  }

  return { ...tree, root: dedup(tree.root) };
}

const FILENAME_PATTERN = /^[^\/\\]+\.(pdf|doc|docx|txt|md|ppt|pptx|xlsx|xls|html)\s*\(\d+\)$/i;
const NUMBERED_PATTERN = /^(主题|分块|部分|章节|段落|项目|内容|文档内容|Item|Part|Section|Chunk|Topic)\s*\d+$/i;
const MEANINGLESS_PATTERN = /^[\s\d()（）\-\._]+$/;
const FILE_EXTENSION_END_PATTERN = /\.(pdf|doc|docx|txt|md|ppt|pptx|xlsx|xls|html)$/i;
const FILE_WITH_NUMBER_PATTERN = /\.(pdf|doc|docx|txt|md|ppt|pptx|xlsx|xls)\s*\(\d+\)$/i;
const RESUME_FILENAME_PATTERN = /[^\n]{8,60}\.(pdf|doc|docx)\b/i;

function isFilenameOrNumberedTitle(content: string): boolean {
  const trimmed = content.trim();
  if (FILENAME_PATTERN.test(trimmed)) return true;
  if (NUMBERED_PATTERN.test(trimmed)) return true;
  if (MEANINGLESS_PATTERN.test(trimmed)) return true;
  if (/^\(\d+\)$/.test(trimmed)) return true;
  if (FILE_EXTENSION_END_PATTERN.test(trimmed)) return true;
  if (FILE_WITH_NUMBER_PATTERN.test(trimmed)) return true;
  if (RESUME_FILENAME_PATTERN.test(trimmed) && trimmed.length > 12 && /[\u4e00-\u9fff]/.test(trimmed)) return true;
  return false;
}

function isFilenameLikeTitle(content: string): boolean {
  const trimmed = content.trim();
  if (FILENAME_PATTERN.test(trimmed)) return true;
  if (FILE_EXTENSION_END_PATTERN.test(trimmed)) return true;
  if (FILE_WITH_NUMBER_PATTERN.test(trimmed)) return true;
  if (RESUME_FILENAME_PATTERN.test(trimmed) && trimmed.length > 12 && /[\u4e00-\u9fff]/.test(trimmed)) return true;
  return false;
}

function isFileOrDownloadTitle(content: string): boolean {
  const trimmed = content.trim().replace(/^#+\s*/, '');
  if (isFilenameOrNumberedTitle(trimmed)) return true;
  if (/【[^】]*[_＿][^】]*\d+\s*[-–]\s*\d+\s*K[^】]*】/.test(trimmed)) return true;
  if (/[_＿].*\d+\s*[-–]\s*\d+\s*K/i.test(trimmed)) return true;
  if (/】\s*[^，。；;]{1,12}\s*\d+\s*年以上/.test(trimmed)) return true;
  return false;
}

function isNumberedTitle(content: string): boolean {
  const trimmed = content.trim();
  if (NUMBERED_PATTERN.test(trimmed)) return true;
  if (MEANINGLESS_PATTERN.test(trimmed)) return true;
  if (/^\(\d+\)$/.test(trimmed)) return true;
  return false;
}

function calculateSimilarity(a: string, b: string): number {
  const na = a.replace(/\s+/g, '').toLowerCase();
  const nb = b.replace(/\s+/g, '').toLowerCase();
  if (na === nb) return 1.0;
  if (na.includes(nb)) return nb.length / na.length;
  if (nb.includes(na)) return na.length / nb.length;
  
  const longer = na.length > nb.length ? na : nb;
  const shorter = na.length > nb.length ? nb : na;
  let matches = 0;
  for (let i = 0; i <= shorter.length - 2; i++) {
    if (longer.includes(shorter.slice(i, i + 2))) {
      matches++;
    }
  }
  return matches / (longer.length - 1);
}

function detectAndFilterLowQualityTitles(tree: MindMapTree): MindMapTree {
  function processNode(node: MindMapNode, depth: number): MindMapNode {
    if (!node.children || node.children.length === 0) {
      return node;
    }

    const processedChildren = node.children
      .map((child) => processNode(child, depth + 1))
      .filter((child) => {
        if (isFilenameLikeTitle(child.content)) {
          return false;
        }
        if (isNumberedTitle(child.content)) {
          return false;
        }
        return true;
      });

    if (depth <= 1 && processedChildren.length >= 3) {
      const titles = processedChildren.map((c) => c.content);
      const toRemove = new Set<number>();
      
      for (let i = 0; i < titles.length; i++) {
        if (toRemove.has(i)) continue;
        let similarCount = 0;
        for (let j = i + 1; j < titles.length; j++) {
          if (toRemove.has(j)) continue;
          if (calculateSimilarity(titles[i], titles[j]) > 0.7) {
            similarCount++;
            if (similarCount >= 2) {
              toRemove.add(j);
            }
          }
        }
      }

      if (toRemove.size > 0) {
        return {
          ...node,
          children: processedChildren.filter((_, idx) => !toRemove.has(idx)),
        };
      }
    }

    return { ...node, children: processedChildren };
  }

  return { ...tree, root: processNode(tree.root, 0) };
}

const MAX_CONTENT_LENGTH = 40;

function splitOversizedNodeContent(tree: MindMapTree): MindMapTree {
  function splitText(text: string): string[] {
    if (text.length <= MAX_CONTENT_LENGTH) return [text];
    
    const sentenceParts = text.split(/(?<=[。！？.!?])/);
    if (sentenceParts.length >= 2 && sentenceParts[0].trim().length >= 4) {
      return sentenceParts.map((p) => p.trim()).filter(Boolean);
    }
    
    const commaParts = text.split(/(?<=[，,；;：:])/);
    if (commaParts.length >= 2 && commaParts[0].trim().length >= 4) {
      return commaParts.map((p) => p.trim()).filter(Boolean);
    }
    
    return [text];
  }

  function splitNode(node: MindMapNode, depth: number): MindMapNode {
    const existingChildren = (node.children || []).map((c) => splitNode(c, depth + 1));
    
    if (node.content.length <= MAX_CONTENT_LENGTH || depth >= MAX_TREE_DEPTH - 1) {
      return { ...node, children: existingChildren };
    }
    
    const parts = splitText(node.content);
    if (parts.length <= 1) {
      return { 
        ...node, 
        content: node.content.slice(0, MAX_CONTENT_LENGTH - 1) + '…', 
        children: existingChildren 
      };
    }
    
    const parentContent = parts[0].length > MAX_CONTENT_LENGTH
      ? parts[0].slice(0, MAX_CONTENT_LENGTH - 1) + '…'
      : parts[0];
    
    const sourceRef = node.meta.sourceRef || createSourceRefFallback({ type: 'text' });
    const splitChildren: MindMapNode[] = parts.slice(1).map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return null;
      if (trimmed.length > MAX_CONTENT_LENGTH) {
        const subParts = splitText(trimmed);
        if (subParts.length > 1) {
          return createHeuristicNode(
            subParts[0].slice(0, MAX_CONTENT_LENGTH),
            sourceRef,
            node.meta.type,
            node.meta.confidence,
          );
        }
        return createHeuristicNode(trimmed.slice(0, MAX_CONTENT_LENGTH), sourceRef, 'detail', 0.65);
      }
      return createHeuristicNode(trimmed, sourceRef, 'detail', 0.65);
    }).filter((n): n is MindMapNode => n !== null);
    
    return {
      ...node,
      content: parentContent,
      children: [...splitChildren, ...existingChildren],
    };
  }
  
  return { ...tree, root: splitNode(tree.root, 0) };
}

function extractSentences(text: string, limit: number): string[] {
  const cleaned = cleanMarkdownText(text);
  const separators = /[。！？.!?;；|｜]/;

  const sentences = cleaned
    .split(separators)
    .map((line) => sanitizeSentence(line))
    .filter((line) => isReadableSentence(line));

  const deduped = [...new Set(sentences)];
  if (deduped.length > 0) {
    return deduped.slice(0, limit);
  }

  const fallback = sanitizeSentence(cleaned);
  return fallback && isReadableSentence(fallback) ? [fallback.slice(0, 160)] : [];
}

function extractSmartTitle(markdown: string, fileName?: string): string {
  const lines = markdown.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  
  for (const line of lines.slice(0, 10)) {
    if (/^#\s+/.test(line)) {
      const title = line.replace(/^#\s+/, '').trim();
      if (title.length >= 2 && title.length <= 80 && !isGarbledText(title) && !PAGE_LABEL_RE.test(title) && !isFileOrDownloadTitle(title)) {
        return title;
      }
    }
  }
  
  for (const line of lines.slice(0, 15)) {
    if (/^#{2,6}\s+/.test(line)) {
      const title = line.replace(/^#{2,6}\s+/, '').trim();
      if (title.length >= 2 && title.length <= 80 && !isGarbledText(title) && !PAGE_LABEL_RE.test(title) && !isFileOrDownloadTitle(title)) {
        return title;
      }
    }
  }
  
  const resumePatterns = [
    /【([^】]+)】/,
    /([^\n]{2,30})[｜|]\s*[\u4e00-\u9fa5]{2,8}/,
    /^([^\n]{2,20})\s*[\u4e00-\u9fa5]*简历/,
    /姓名[：:]\s*([^\n]{2,10})/,
  ];
  
  for (const pattern of resumePatterns) {
    const match = markdown.match(pattern);
    if (match && match[1]) {
      const title = match[1].trim();
      if (title.length >= 2 && title.length <= 40 && !isGarbledText(title) && !isFileOrDownloadTitle(match[0]) && !isFileOrDownloadTitle(title)) {
        return title;
      }
    }
  }
  
  for (const line of lines.slice(0, 5)) {
    const cleaned = line.replace(/[【】\[\]（）()]/g, ' ').trim();
    if (cleaned.length >= 4 && cleaned.length <= 50 && !isFileOrDownloadTitle(line) && !isFileOrDownloadTitle(cleaned)) {
      const cjkCount = (cleaned.match(/[\u4e00-\u9fa5]/g) || []).length;
      const letterCount = (cleaned.match(/[A-Za-z]/g) || []).length;
      const totalChars = cleaned.replace(/\s/g, '').length;
      
      if (cjkCount / totalChars >= 0.5 && !isGarbledText(cleaned)) {
        return cleaned.slice(0, 50);
      }
      if (letterCount / totalChars >= 0.7 && !isGarbledText(cleaned)) {
        return cleaned.slice(0, 50);
      }
    }
  }

  for (const line of lines.slice(0, 15)) {
    if (isFileOrDownloadTitle(line) || PAGE_LABEL_RE.test(line)) continue;
    const candidate = sanitizeSentence(line.replace(/^#{1,6}\s+/, ''));
    if (candidate.length >= 6 && candidate.length <= 90 && isReadableSentence(candidate) && !isGarbledText(candidate)) {
      return candidate.slice(0, 80);
    }
  }
  
  if (fileName) {
    const cleanName = fileName.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
    if (cleanName.length >= 2 && cleanName.length <= 50 && !isFileOrDownloadTitle(fileName) && !isFileOrDownloadTitle(cleanName)) {
      return cleanName;
    }
  }
  
  return '思维导图';
}

function deriveRootTitleFromContent(markdown: string, branches: MindMapNode[]): string {
  const text = cleanMarkdownText(markdown);
  if (/产品经理/.test(text) && /游戏/.test(text) && /商业化|营收|运营/.test(text)) {
    return '产品经理具备游戏商业化与运营经验';
  }
  if (/游戏/.test(text) && /商业化|营收|运营/.test(text)) {
    return '游戏商业化与运营经验';
  }
  if (/产品经理/.test(text)) {
    return '产品经理履历与核心经验';
  }

  const firstMeaningfulBranch = branches.find((branch) => {
    const content = branch.content.trim();
    return content.length >= 4 && !isFileOrDownloadTitle(content) && !isGarbledText(content);
  });

  return firstMeaningfulBranch?.content.slice(0, 80) || '思维导图';
}

function isWeakRootTitle(title: string): boolean {
  if (!title || title === '思维导图') return true;
  return /基础信息|性别|电话|邮箱|手机/.test(title);
}

const PAGE_LABEL_RE = /^(Page\s+\d+|OCR\s+Page\s+\d+|OCR\s+第\d+页|page:\d+|ocr-page:\d+|第\d+页)$/i;

function titleFromChunk(text: string, index: number): string {
  const heading = text
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => /^#{2,6}\s+/.test(line));

  if (heading) {
    const title = heading.replace(/^#{2,6}\s+/, '').trim();
    if (title.length >= 2 && !isGarbledText(title) && !PAGE_LABEL_RE.test(title) && !isFilenameOrNumberedTitle(title)) {
      return title.slice(0, 80);
    }
  }

  const nonPageLines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !PAGE_LABEL_RE.test(line) && !/^---$/.test(line) && !/^\[.*:.*\]$/.test(line));

  for (const line of nonPageLines.slice(0, 5)) {
    const cleaned = line.replace(/^#{1,6}\s+/, '').trim();
    if (cleaned.length >= 4 && cleaned.length <= 80 && !isGarbledText(cleaned) && !PAGE_LABEL_RE.test(cleaned) && !isFilenameOrNumberedTitle(cleaned)) {
      return cleaned.slice(0, 80);
    }
  }

  const sentences = extractSentences(text, 3);
  for (const sentence of sentences) {
    if (sentence.length >= 4 && sentence.length <= 80 && !isGarbledText(sentence) && !isFilenameOrNumberedTitle(sentence)) {
      return sentence.slice(0, 80);
    }
  }

  const rawText = text.replace(/\n+/g, ' ').trim();
  if (rawText.length >= 4 && !isGarbledText(rawText)) {
    return rawText.slice(0, 80);
  }

  return `文档内容 ${index + 1}`;
}

function createNodeFromLLM(raw: { content: string; children?: { content: string; children?: any[] }[] }, sourceRef: SourceReference): MindMapNode {
  const now = Date.now();
  return {
    id: nanoid(),
    content: raw.content.trim(),
    collapsed: false,
    meta: {
      sourceRef,
      type: 'detail',
      confidence: 0.82,
      createdAt: now,
      createdBy: 'ai',
    },
    children: (raw.children || []).map((child) => createNodeFromLLM(child, sourceRef)),
  };
}

function sanitizePartialNode(raw: unknown): { content: string; children?: any[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as { content?: unknown; children?: unknown };
  if (typeof node.content !== 'string' || !node.content.trim()) return null;

  const normalized: { content: string; children?: any[] } = { content: node.content.trim() };
  if (Array.isArray(node.children)) {
    normalized.children = node.children
      .map((child) => sanitizePartialNode(child))
      .filter((item): item is { content: string; children?: any[] } => Boolean(item));
  }

  return normalized;
}

function llmTreeToMindMapTree(llmTree: LLMMindMapTree, doc: NormalizedDocument): MindMapTree {
  const sourceRef = makeDefaultSourceRef(doc);
  const root = createNodeFromLLM(llmTree.root, sourceRef);
  root.meta.type = 'main';

  const tree = {
    ...getDefaultMindMapTree(llmTree.title || doc.sourceMeta.title || '思维导图', sourceRef, doc.sourceMeta.type),
    root,
  };

  const clamped = clampTree(tree, MAX_TREE_DEPTH, MAX_TREE_NODES);
  const parsed = mindMapTreeSchema.parse(clamped);
  const sanitized = sanitizeMindMapTreeForOutput(parsed, doc.sourceMeta.title || '思维导图');
  const result = ensureFirstLayerDetails(sanitized, doc);
  const validated = validateSemanticHierarchy(result);
  const restructured = restructureOversizedBranches(validated);
  const deduped = deduplicateNodeTitles(restructured);
  const filtered = detectAndFilterLowQualityTitles(deduped);
  const expanded = ensureFirstLayerDetails(filtered, doc);
  return splitOversizedNodeContent(expanded);
}

function buildDiffPatches(prevTree: MindMapTree, nextTree: MindMapTree): TreePatch[] {
  const prevMap = new Map<string, IndexedNode>();
  const nextMap = new Map<string, IndexedNode>();

  flattenTree(prevTree.root).forEach((item) => {
    prevMap.set(item.node.id, item);
  });
  flattenTree(nextTree.root).forEach((item) => {
    nextMap.set(item.node.id, item);
  });

  const patches: TreePatch[] = [];

  for (const [id, current] of nextMap.entries()) {
    const previous = prevMap.get(id);

    if (!previous && current.parentId) {
      patches.push({
        type: 'add',
        nodeId: id,
        parentId: current.parentId,
        index: current.index,
        node: current.node,
        timestamp: Date.now(),
      });
      continue;
    }

    if (previous) {
      const contentChanged = previous.node.content !== current.node.content;
      const collapsedChanged = (previous.node.collapsed ?? false) !== (current.node.collapsed ?? false);
      if (contentChanged || collapsedChanged) {
        patches.push({
          type: 'update',
          nodeId: id,
          node: {
            content: current.node.content,
            collapsed: current.node.collapsed,
          },
          timestamp: Date.now(),
        });
      }
    }
  }

  for (const [id] of prevMap.entries()) {
    if (!nextMap.has(id) && id !== prevTree.root.id) {
      patches.push({
        type: 'delete',
        nodeId: id,
        timestamp: Date.now(),
      });
    }
  }

  return patches;
}

function extractKeywords(text: string, limit: number): string[] {
  const cjkWords = text.match(/[\u3400-\u9fff]{2,8}/g) || [];
  const freq: Record<string, number> = {};
  for (const word of cjkWords) {
    freq[word] = (freq[word] || 0) + 1;
  }
  const stopWords = new Set(['的', '是', '在', '和', '了', '有', '不', '这', '我', '他', '她', '它', '们', '与', '及', '等', '为', '对', '以', '到', '从', '被', '把', '让', '给', '向', '于', '而', '或', '但', '如', '若', '则', '因', '所', '也', '都', '就', '还', '又', '再', '很', '更', '最', '已', '正', '将', '要', '能', '可', '应', '该', '会', '需', '须', '得', '着', '过', '去', '来', '起', '开', '出', '入', '上', '下', '中', '内', '外', '前', '后', '左', '右', '东', '西', '南', '北', '年', '月', '日', '时', '分', '秒', '个', '只', '些', '那', '哪', '每', '各', '某', '此', '彼', '何', '谁', '什', '么', '怎', '样', '几', '多', '少', '大', '小', '长', '短', '高', '低', '好', '坏', '新', '旧', '真', '假', '对', '错', '是', '非', '有', '无', '生', '死', '成', '败', '得', '失', '进', '退', '上', '下', '左', '右', '前', '后', '里', '外', '内', '中', '间', '旁', '边', '侧', '面', '底', '顶', '头', '尾', '首', '末', '始', '终', '初', '末', '先', '后', '早', '晚', '快', '慢', '急', '缓', '轻', '重', '软', '硬', '冷', '热', '干', '湿', '明', '暗', '黑', '白', '红', '黄', '蓝', '绿', '紫', '灰', '金', '银', '铜', '铁', '钢', '木', '石', '水', '火', '土', '风', '云', '雨', '雪', '雷', '电', '光', '影', '声', '色', '味', '香', '臭', '美', '丑', '善', '恶', '爱', '恨', '情', '仇', '恩', '怨', '喜', '怒', '哀', '乐', '悲', '欢', '离', '合', '聚', '散', '生', '死', '病', '痛', '苦', '累', '饿', '渴', '困', '倦', '醒', '睡', '梦', '想', '思', '念', '忘', '记', '知', '识', '学', '习', '教', '育', '读', '写', '说', '听', '看', '闻', '摸', '尝', '做', '作', '造', '建', '设', '计', '划', '策', '谋', '略', '术', '法', '道', '理', '义', '利', '名', '实', '虚', '真', '假', '正', '邪', '善', '恶', '美', '丑', '好', '坏', '对', '错', '是', '非', '有', '无', '生', '死', '成', '败', '得', '失']);
  const sorted = Object.entries(freq)
    .filter(([word]) => !stopWords.has(word) && word.length >= 2)
    .sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, limit).map(([word]) => word);
}

export function buildHeuristicMindMapTree(doc: NormalizedDocument): MindMapTree {
  const sourceRef = makeDefaultSourceRef(doc);
  const metaTitle = doc.sourceMeta.title && !isFileOrDownloadTitle(doc.sourceMeta.title) ? doc.sourceMeta.title : undefined;
  let title = extractSmartTitle(doc.markdown, doc.sourceMeta.sourceFileName) || metaTitle || '思维导图';

  if (doc.chunks.length > 1) {
    const root = createHeuristicNode(title, sourceRef, 'main', 0.7);

    root.children = doc.chunks.slice(0, 24).map((chunk, index) => {
      const chunkSourceRef = chunk.sourceRef || sourceRef;
      const branch = createHeuristicNode(titleFromChunk(chunk.text, index), chunkSourceRef, 'detail', 0.68);
      branch.children = extractSentences(chunk.text, 4).map((sentence) =>
        createHeuristicNode(sentence, chunkSourceRef, 'detail', 0.62),
      );
      return branch;
    });

    if (isWeakRootTitle(title)) {
      title = deriveRootTitleFromContent(doc.markdown, root.children || []);
      root.content = title;
    }

    const tree: MindMapTree = {
      id: nanoid(),
      root,
      meta: {
        title,
        sourceType: doc.sourceMeta.type,
        sourceUrl: doc.sourceMeta.sourceUrl,
        sourceFileName: doc.sourceMeta.sourceFileName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
        truncated: false,
      },
    };

    const clamped = clampTree(tree, MAX_TREE_DEPTH, MAX_TREE_NODES);
    const sanitized = sanitizeMindMapTreeForOutput(clamped, title);
    const result = ensureFirstLayerDetails(sanitized, doc);
    const validated = validateSemanticHierarchy(result);
    const restructured = restructureOversizedBranches(validated);
    const deduped = deduplicateNodeTitles(restructured);
    const filtered = detectAndFilterLowQualityTitles(deduped);
    const expanded = ensureFirstLayerDetails(filtered, doc);
    return mindMapTreeSchema.parse(splitOversizedNodeContent(expanded));
  }

  const sentences = extractSentences(doc.markdown, 12);

  const root = createHeuristicNode(title, sourceRef, 'main', 0.7);

  const groupCount = Math.min(4, Math.max(3, Math.ceil(sentences.length / 3)));
  const itemsPerGroup = Math.ceil(sentences.length / groupCount);

  for (let i = 0; i < groupCount; i++) {
    const groupItems = sentences.slice(i * itemsPerGroup, (i + 1) * itemsPerGroup);
    if (groupItems.length === 0) continue;

    const groupText = groupItems.join(' ');
    const groupTitle = groupText.slice(0, 60).trim() || `内容 ${i + 1}`;

    const branch = createHeuristicNode(groupTitle, sourceRef, 'detail', 0.65);

    groupItems.forEach((item) => {
      branch.children?.push(
        createHeuristicNode(item, sourceRef, 'detail', 0.62),
      );
    });

    if ((branch.children?.length ?? 0) > 0) {
      root.children?.push(branch);
    }
  }

  if (isWeakRootTitle(title)) {
    title = deriveRootTitleFromContent(doc.markdown, root.children || []);
    root.content = title;
  }

  const tree: MindMapTree = {
    id: nanoid(),
    root,
    meta: {
      title,
      sourceType: doc.sourceMeta.type,
      sourceUrl: doc.sourceMeta.sourceUrl,
      sourceFileName: doc.sourceMeta.sourceFileName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      truncated: false,
    },
  };

  const clamped = clampTree(tree, MAX_TREE_DEPTH, MAX_TREE_NODES);
  const sanitized = sanitizeMindMapTreeForOutput(clamped, title);
  const result = ensureFirstLayerDetails(sanitized, doc);
  const validated = validateSemanticHierarchy(result);
  const restructured = restructureOversizedBranches(validated);
  const deduped = deduplicateNodeTitles(restructured);
  const filtered = detectAndFilterLowQualityTitles(deduped);
  const expanded = ensureFirstLayerDetails(filtered, doc);
  return mindMapTreeSchema.parse(splitOversizedNodeContent(expanded));
}

const ANTI_HALLUCINATION_SYSTEM = [
  '你是一名结构化信息提炼专家，不是创作助手。',
  '你的唯一工作是从用户提供的文档中精准提炼信息并组织为思维导图结构。',
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '## 核心方法论：金字塔原理（Pyramid Principle）',
  '你必须将文档内容组织为**总分结构**的思维导图，严格遵循以下四原则：',
  '',
  '### 原则一 · 结论先行（Conclusion First）',
  '- 根节点必须是全文的**核心结论/中心思想**，而非简单重复文档标题',
  '- 每个父节点都是其所有子节点的**概括性结论**——读者只看父节点就能理解该分支的核心要点',
  '- 禁止父节点仅为分类标签（如"概述""分析""总结""特点"），必须包含实质性结论信息',
  '- 示例：❌"技术架构"→ ✅"微服务+事件驱动架构支撑高并发场景"',
  '',
  '### 原则二 · 以上统下（Upper-Level Summarizes Lower-Level）',
  '- 上层节点是下层节点的**思想概括**，下层节点是上层节点的**具体支撑**',
  '- 每一层节点必须能回答上一层的"为什么"或"如何做到"',
  '- 自顶向下验证：任一父节点 → 能否自然涵盖所有子节点内容？',
  '- 自底向上验证：任一子节点 → 是否直接支撑/解释/例证其父节点的结论？',
  '- 禁止出现"父子脱节"——父节点说A、子节点说B的情况',
  '',
  '### 原则三 · 归类分组（MECE Categorization）',
  '- 同级节点之间必须**互斥且完全穷尽**（Mutually Exclusive, Collectively Exhaustive）',
  '- 分组依据必须是**同一逻辑维度**（时间顺序/结构组成/程度高低/类别属性）',
  '- 每组内的要素属于同一逻辑范畴，不同组之间不交叉、不重叠',
  '- 常见违规：将"方法"和"结果"混入同一父节点、将"原因"和"对策"混入同一分组',
  '',
  '### 原则四 · 逻辑递进（Logical Progression）',
  '- 同级节点的排列必须有**明确的逻辑顺序**，禁止随机排列',
  '- 可选递进模式（根据文档内容选择最合适的一种）：',
  '  ① 演绎顺序：大前提→小前提→结论（适用于推理论证类文档）',
  '  ② 时间顺序：第一步→第二步→第三步（适用于流程/操作/历史类文档）',
  '  ③ 结构顺序：按空间/组成/模块排列（适用于系统拆解/架构类文档）',
  '  ④ 程度顺序：最重要→次重要（适用于优先级/重要性排序）',
  '- 一级节点之间的排序必须体现所选递进模式',
  '',
  '## 总分结构生成范式',
  '- 根节点（总）：全文核心结论，1句话高度概括',
  '- 一级节点（分）：2-8个核心支撑论点，共同论证根节点结论',
  '- 二级节点（分）：对一级节点的具体展开，提供事实/数据/案例',
  '- 三级节点（细节）：必要时对二级节点的补充说明',
  '- 每一层都是上一层的"分述"，同时是下一层的"总括"',
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '绝对禁止编造、推测、补充、合理化任何文档中未明确出现的信息。',
  '遇到模糊或无法识别的内容，直接忽略，不要猜测。',
  '文档中没有的分类维度，不要创建节点。',
  '同一信息多次出现时只保留一次，归入最相关父节点。',
  '文末被截断时以最后一个完整段落为准，不补全断尾。',
  '每个子节点必须属于其父节点的语义范畴——禁止将不同类别的内容混入同一个父节点下（如"专业技能"下只能放技能相关内容，不能混入项目成果、运营指标、业务操作等）',
  '输出前必须逐条自检：每个子节点的关键词能否直接推导出它属于父节点定义的范畴？若不能，立即删除或移到正确父节点。',
  '任何父节点的直接子节点不得超过8个。当某节点下信息超过8条时，必须创建中间归纳节点（如"后端技术""前端技术"等分组名），将相关内容归入二级分组，核心信息作为三级节点。',
  '节点标题必须唯一：任何父节点与其直接子节点的 content 不能完全相同或高度相似。同一父节点下的同级节点之间 content 也不能重复——每个节点必须表达该层级下独特的信息维度。',
  '',
  '## 【核心约束】二级节点标题质量保障（最高优先级）',
  '',
  '### 1. 🚫 标题绝对禁止使用文件名（违反即失败）',
  '- 🚫 禁止：产品经理_深圳 15-20K】谭艳丽 9年.pdf  → 这是文件名，立即删除',
  '- 🚫 禁止：简历模板.docx(1)、论文最终版.pdf  → 文件格式统统禁止',
  '- 🚫 禁止：任何包含 .pdf .doc .docx .txt .md .html 的文本作为节点标题',
  '- 🚫 禁止：使用"主题1""主题2""分块1""分块2"等无意义编号作为标题',
  '- ✅ 正确："工作经历 · 9年产品经理，覆盖社交/电商/工具赛道"',
  '- ✅ 正确："教育背景 · 深圳大学 计算机科学 本科"',
  '- 规则：如果输入中包含文件名，必须忽略，只提练文档正文内容做标题',
  '',
  '### 2. 标题唯一性',
  '- 同一层级的所有节点标题必须互不相同',
  '- 禁止出现3个或以上相同或高度相似（相似度>70%）的标题',
  '- 如果多个段落讨论相似主题，必须用不同的角度或侧重点来区分标题',
  '- 示例：不能用"工作经历""工作经验""工作背景"三个相似标题，应合并为一个或用"前期经历""近期项目"等明确区分',
  '',
  '### 3. 内容相关性强制验证',
  '- 每个节点的content必须能在原文中找到对应的依据（允许同义改写）',
  '- 禁止生成与文档主题关联度低的泛化描述（如"提高效率""优化体验"等空话）',
  '- 禁止生成无法代表文档实质内容的概括性标题',
  '- 如果某部分内容无法提炼出有意义的标题，宁可删除该节点也不要用模糊标题填充',
  '',
  '### 4. 语义价值评估标准',
  '- 高价值节点：包含具体数据、专有名词、方法论、明确结论或可操作建议',
  '- 中价值节点：包含概括性但有意义的信息描述',
  '- 低价值节点（必须删除）：纯编号、纯文件名、重复内容、空话套话、与主题无关的内容',
  '- 每个节点必须通过"删除后是否损失关键信息"测试——如果删除后不影响理解，则说明该节点价值不足',
  '',
  '### 5. 📏 节点内容长度硬约束',
  '- 每个节点的 content 严格控制在 35 字以内（中文按字符计）',
  '- 当单个信息点超过 35 字时，必须拆为父子结构：提取 10-20 字作为父节点概要，详细内容拆为 1-3 个子节点',
  '- 示例：原文"负责从0到1搭建用户增长体系，通过裂变+投放组合拳实现6个月DAU从0到50万" → 正确拆分为：',
  '  父："用户增长体系搭建 · DAU从0到50万"',
  '  子1："裂变增长：设计邀请+拼团机制"',
  '  子2："付费投放：信息流+KOL组合策略"',
  '- 严禁为节省空间而截断关键信息，必须通过拆分保留全部信息',
].join('\n');

const MARKDOWN_SUMMARY_SYSTEM = [
  '你是一名 Markdown 文档总结助手，不是思维导图生成器。',
  '你的任务是基于用户提供的原文，输出一份结构化、可读、忠于原文的 Markdown 总结。',
  '你只能提炼、归纳、压缩原文，不得编造、推断、补充外部知识。',
  '除非原文明示，否则不要主动补充行动建议、风险判断或延伸分析。',
  '输出必须服务于“文档总结”本身，而不是为思维导图节点生成做准备。',
].join('\n');

const DOCUMENT_SUMMARY_SYSTEM = [
  '你是一名文档事实总结助手，不是思维导图生成器。',
  '你的任务是基于用户提供的原文片段输出简洁摘要点，严格忠于原文。',
  '只允许做压缩总结，不得编造、推断、补充外部知识。',
  '如果原文存在 OCR 噪声、截断或歧义，只能弱化表述或跳过，不能自行补完。',
  '除非原文明示，否则不要主动输出风险、建议、行动项。',
].join('\n');

const PYRAMID_DOCUMENT_SUMMARY_FRAMEWORK = [
  '## 文档总结与思维导图构建目标',
  '请先在内部形成一份符合金字塔原理的结构化总结，再据此生成思维导图结构：',
  '- 顶层：明确中心主题与中心思想，中心主题不得简单等同于文件名或标题',
  '- 中层：构建3-5个主要分支作为关键论点；信息不足时可少于3个，但必须忠实原文，不得凑数',
  '- 底层：每个关键论点必须由原文中的具体论据、数据、案例或事实支撑',
  '- 展开要求：所有二级节点必须至少展开一层，二级节点不得保持叶子状态；子节点必须来自原文',
  '- 逻辑关系：明确判断各层级之间是演绎、归纳、因果、并列或递进关系',
  '- 结构输出：思维导图节点应体现“中心主题→关键论点→支撑依据”的金字塔层级',
].join('\n');

const PYRAMID_SELF_CHECK_LOOP = [
  '## 智能自检测闭环（最终输出前必须执行）',
  '自检测是内容生成的最后验证环节，必须在最终输出前逐项完成：',
  '1. 结构完整性检查：验证金字塔结构是否完整，顶层中心主题/中心思想、中层关键论点、底层论据/数据/案例是否齐全',
  '2. 内容相关性检查：确认所有总结内容均来源于原文档，无无关信息、外部信息、主观解读或无依据推断',
  '3. 逻辑一致性检查：确保中心思想、关键论点与支撑依据之间存在合理的演绎/归纳/因果/并列/递进关系',
  '4. 表达准确性检查：验证关键术语使用准确，数据引用无误，人名、机构、时间、金额、比例与原文一致',
  '5. 二级节点展开检查：检查所有二级节点是否均已展开，且无重要内容节点被遗漏',
  '6. 自我提问环节：自动生成并回答“这是对文档内容最准确、最有效的总结方式吗？”',
  '自检测未通过：必须自动返回修改并重新生成，直至满足结构完整、内容相关、逻辑一致、表达准确后方可输出最终结果',
  '注意：JSON 思维导图生成场景中，自检测过程只作为内部质量保障，不要在 JSON 之外输出检测报告或解释文字',
].join('\n');

export function buildPrompt(doc: NormalizedDocument): string {
  const cleanedMarkdown = cleanMarkdownForLLM(doc.markdown).slice(0, 12000);
  return [
    '你是一名结构化信息提炼专家。任务：运用金字塔原理，从原文中精准提炼信息并组织为**总分结构**思维导图。',
    '',
    PYRAMID_DOCUMENT_SUMMARY_FRAMEWORK,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '## 金字塔原理 · 总分结构生成框架',
    '',
    '### 核心四原则（必须同时满足）',
    '',
    '**原则一 · 结论先行**：根节点 = 全文核心结论（不是标题复述），每个父节点 = 子节点的高度概括性结论。读者只看任一父节点，就能理解该分支的核心要点。禁止父节点仅写分类标签（如"概述""分析""特点"），必须包含实质性信息。',
    '',
    '**原则二 · 以上统下**：上层是下层的思想概括（总），下层是上层的具体支撑（分）。每一层都能回答上一层的"为什么"或"如何做到"。自顶向下能自然推导，自底向上能归纳收束。禁止父子脱节——父说A、子说B。',
    '',
    '**原则三 · 归类分组**：同级节点 MECE——互斥且完全穷尽。同一逻辑维度分组（时间/结构/程度/类别），不同组之间不交叉不重叠。',
    '',
    '**原则四 · 逻辑递进**：同级节点排列有明确逻辑顺序。演绎（大前提→小前提→结论）/ 时间（步骤顺序）/ 结构（空间/模块）/ 程度（最重要→次要），根据文档类型选择最合适模式。',
    '',
    '### 总分结构范式',
    '- 根节点【总】：全文核心结论，1句话高度概括',
    '- 一级节点【分】：2-8个支撑论点，共同论证根节点结论，按逻辑递进排列',
    '- 二级节点【分】：对一级节点的具体展开，提供事实/数据/案例/论证',
    '- 三级节点【细节】：必要时对二级节点的补充',
    '- 关键：每一层既是上层的"分述"，又是下层的"总括"',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '## 第一步 · 金字塔构建规划（不输出，只用于自检）',
    '1. **识别核心结论**：通读全文，提炼1句话核心结论作为根节点——不是文档标题的复述，而是文档真正要表达的中心思想',
    '2. **拆解支撑论点**：核心结论需要哪2-8个分论点来支撑？这些成为一级节点，每个分论点也是一个结论性陈述',
    '3. **MECE验证**：分论点是否互斥且穷尽？粒度是否一致？',
    '4. **确定递进逻辑**：一级节点之间按什么逻辑排序（演绎/时间/结构/程度）？标记排序依据',
    '5. **逐层展开**：每个分论点下需要哪些具体事实/数据/案例来支撑？展开为二级节点',
    '6. **上下统合自检**：抽任一子节点 → 能否回答父节点"为什么"或支撑其结论？不能→调整',
    '7. 完成自检后再开始输出，思考过程不写入最终结果',
    '',
    '## 绝对规则（违反任何一条即视为失败）',
    '1. 内容层须忠实：每个节点的字面信息必须源自原文',
    '   - 允许：同义压缩、合并相邻句、删去口语化修饰',
    '   - 禁止：新增任何原文未出现的事实、数据、人名、案例、术语',
    '2. 模糊、乱码、不完整的句子直接忽略，不要猜测含义',
    '3. 文档中没有对应内容的维度，不创建节点',
    '4. 文末若被截断，以最后一个完整段落为准，不补全断尾',
    '5. 同一信息在原文多次出现时，只保留一次，归入最相关父节点',
    '6. 分类边界不可逾越：每个父节点下的子节点必须属于同一语义类别',
    '   - 核心原则：先确定父节点定义的语义范畴，再判断每条信息是否属于该范畴',
    '   - 判定方法：抽取子节点关键词 → 问"这描述的是父节点范畴内的事吗？"→ 不是则不可放入',
    '   - 常见违规：将"结果/指标"放入"方法/手段"类父节点，将"背景/原因"放入"结论/建议"类父节点',
    '   - 如果某条信息无法归入任何已有父节点的语义范畴，不要强行放入——宁可减少节点也不污染分类',
    '7. 🚫 文件名禁令：任何节点的 content 禁止包含文件名或文件扩展名',
    '   - 禁止：产品经理_深圳.pdf、简历.pdf(1)、论文.docx 等任何含文件扩展名的文本',
    '   - 禁止：直接复制输入开头的文件名作为任何节点标题',
    '   - 遇到文件名时，从该文件对应的正文内容中提取有意义的标题',
    '8. 📏 内容长度约束：每个节点的 content 必须 ≤ 35 字',
    '   - 超过 35 字的信息必须拆分为父子结构',
    '   - 父节点用 10-20 字概括核心语义，子节点承载详细描述',
    '   - 严禁截断——必须通过拆分保留全部信息',
    '9. 🏛️ 结论先行约束：根节点和每个父节点必须是结论性陈述，不得仅为分类标签',
    '   - 禁止：根节点="思维导图"/"文档内容"/"文章概述"等无信息量标题',
    '   - 禁止：一级节点="概述"/"分析"/"总结"/"背景"/"方法"/"结果"等空洞分类名',
    '   - 正确：根节点应概括文档核心主张，一级节点应体现具体维度的结论',
    '10. 🔗 以上统下约束：每个子节点必须直接支撑/解释其父节点',
    '    - 自检：删除父节点后，子节点列表能否向上归纳为一个统一的结论？能→正确',
    '    - 自检：只看父节点文字，能否预见子节点的大致内容范围？不能→父节点概括不足',
    '',
    '## 语义归属判定规则（输出前必须逐条对照）',
    '下面定义每类父节点"只能"包含的子节点类型。请严格对照执行：',
    '- "技能"类父节点（含"专业技能""技术栈""能力"等）：只能放工具名、语言名、方法论、证书、能力名称，禁止放业务操作/运营指标/项目成果',
    '- "项目/经历"类父节点（含"工作经历""项目经验"等）：只能放具体项目名称、项目描述、担任角色',
    '- "成果/业绩"类父节点（含"工作成果""业绩"等）：只能放量化结果、关键产出',
    '- "职责"类父节点：只能放具体职责描述',
    '- "教育"类父节点：只能放学历、学校、专业',
    '判定口诀：读子节点内容 → 问"这句话描述的是父节点定义的范畴吗？"→ 不是则删除或移到正确位置',
    '',
    '## 结构层可优化',
    '1. 层级、归类、合并、顺序均可重组，目标是"读者一眼看懂结构"',
    '2. 关联紧密的信息合并为一个节点（如"概念名 · 核心定义"合一），细节作 children',
    '3. 重组的依据是语义关联与金字塔逻辑，而非原文章节顺序',
    '',
    '## 子节点数量管理（重要）',
    '- 任何节点的直接子节点数 ≤ 8 个，保持视觉清爽',
    '- 当某节点下信息 > 8 条时：在父节点与叶子之间插入归纳节点（二级分组）',
    '- 归纳方法：按语义相似度将子节点分为 2-4 组，每组用一个简洁词组命名（4-8 字）',
    '- 示例："专业技能"下有 Python、Java、Spring Boot、React、Vue、Node.js、Docker、K8s、MySQL、Redis 时 → 分为"后端技术"和"前端与运维"两个中间节点',
    '- 禁止为凑整而删除信息——信息多时用"增加层级"而非"减少节点"',
    '',
    '## 好导图的判定标准（输出前自检）',
    '- ✅ 结论先行：根节点是核心结论而非标题；每个父节点是子节点的概括性结论而非标签',
    '- ✅ 以上统下：上层概括下层，下层支撑上层，任何父子关系可双向验证',
    '- ✅ 归类分组：一级节点之间互斥不重叠（MECE），同层粒度一致',
    '- ✅ 逻辑递进：同级节点按明确逻辑排序（演绎/时间/结构/程度），非随机排列',
    '- ✅ 叶子节点自含（脱离上下文也能读懂）',
    '- ✅ 无空标签节点（禁止只写分类名而无实质内容，如"特点 / 优点 / 其他"）',
    '- ✅ 节点语言与原文一致（中文文档输出中文，英文文档输出英文）',
    '- ✅ 节点标题唯一：父节点与子节点 content 不能相同或高度相似；同级节点间 content 不可重复',
    '',
    PYRAMID_SELF_CHECK_LOOP,
    '',
    '## 【强制执行】生成后自测验证流程（必须逐项检查）',
    '',
    '### 验证步骤 1：结论先行检查（金字塔顶层验证）',
    '1. 检查根节点：是否表达了全文的核心结论/中心思想？（不是标题复述）',
    '2. 检查每个一级节点：是否包含实质性结论信息？（不是"概述""分析""总结"等空标签）',
    '3. 检查每个父节点：提取其关键词 → 看其子节点是否在围绕这个结论展开支撑？',
    '4. 不合格节点必须重写：将"标签式标题"改为"结论式标题"',
    '',
    '### 验证步骤 2：以上统下检查（金字塔纵向验证）',
    '1. 对每个父-子关系：父节点能否自然概括所有子节点内容？',
    '2. 对每个子-父关系：子节点是否直接支撑/解释父节点的结论？',
    '3. 检查组：是否存在"父说A、子说B"的脱节情况？→ 立即修复',
    '4. 检查组：是否存在子节点内容比父节点更宏观？（层级倒置）→ 交换或调整',
    '',
    '### 验证步骤 3：归类分组与逻辑递进检查（金字塔横向验证）',
    '1. 同级节点是否 MECE（互斥且穷尽）？',
    '2. 同级节点粒度是否一致？',
    '3. 同级节点排列是否有明确逻辑顺序（演绎/时间/结构/程度）？',
    '4. 节点标题唯一性：无重复，无高度相似（<3个相似）',
    '5. 特别检查：是否出现文件名、编号 → 立即替换',
    '',
    '### 验证步骤 4：内容质量与过滤',
    '逐个检查所有节点，标记以下类型并删除：',
    '- [ ] 纯文件名/路径/URL',
    '- [ ] 纯编号（如"(1)"、"主题 1"、"分块2"、"内容3"、"Chunk1"）',
    '- [ ] 空话套话（如"提高效率""优化体验"而无具体内容）',
    '- [ ] 重复内容（与其他节点信息重叠>80%）',
    '- [ ] 与文档主题无关的内容',
    '- [ ] 标签式标题（如"概述""分析""总结""方法""结果"等无信息量标签）',
    '过滤后如果某父节点下无子节点，考虑删除或合并',
    '',
    '### 验证步骤 5：总分结构完整性评估',
    '回答以下问题（任一答案为"否"则需调整）：',
    '- [ ] 根节点是否准确概括了全文核心结论？',
    '- [ ] 所有一级节点共同支撑根节点结论？（覆盖率≥80%）',
    '- [ ] 每个一级节点下的二级节点是否充分展开支撑？',
    '- [ ] 整体结构是否可以自顶向下顺畅阅读？（总→分→细节）',
    '- [ ] 整体结构是否可以自底向上归纳收束？（细节→分→总）',
    '- [ ] 节点层级深度是否合理？（3-4层为宜）',
    '- [ ] 信息分布是否均衡？',
    '',
    '### 验证通过标准',
    '✅ 结论先行：根节点和所有父节点均为结论性陈述，无空标签',
    '✅ 以上统下：所有父子关系可双向验证，无脱节',
    '✅ 归类分组：MECE成立，粒度一致',
    '✅ 逻辑递进：同级节点有明确排序逻辑',
    '✅ 内容质量：无意义内容已全部过滤',
    '✅ 总分结构：可自顶向下阅读、自底向上归纳',
    '✅ 如果任何一项不通过，必须返回重新规划，直到全部通过',
    '',
    '## 约束条件',
    `- 最大层级：${MAX_TREE_DEPTH}`,
    `- 最大节点数：${MAX_TREE_NODES}`,
    '- 节点文本目标 15-25 字，上限 35 字',
    '- 超过 35 字必须拆为父子结构，严禁截断意思',
    '- 一级节点 2-8 个，由内容决定，不凑数，不为美观补足',
    '- 每个节点的直接子节点数 ≤ 8 个，超过时自动创建中间归纳分组',
    '',
    '## 兜底规则',
    '- 原文 <100 字或无明显结构：输出"单根节点 + 1-2 个子节点"的最小合法结构，不强行拼凑',
    '- 原文全为乱码 / 无法识别：输出 {"content": "无法识别的内容","children": []}',
    '',
    '## Few-shot（注意：每个正例均展示结论先行 + 以上统下 + 归类分组 + 逻辑递进）',
    '',
    '✅ 正例 1 · 学术论文风（演绎递进 · 概念→原理→实现）：',
    '// 根=核心结论（非标签），一级=三大支撑维度（按概念→原理→实现递进）',
    '{"content":"Transformer通过自注意力机制取代循环结构，实现并行化序列建模","children":[',
    '  {"content":"核心机制：Scaled Dot-Product Attention实现全局依赖捕捉","children":[]},',
    '  {"content":"多头并行：8个attention head从不同子空间联合学习","children":[]},',
    '  {"content":"位置编码：正弦函数显式注入序列顺序信息","children":[]}',
    ']}',
    '点评：根节点是结论（"取代循环结构+并行化建模"）而非标签（"模型架构"），一级节点按概念→原理→实现递进',
    '',
    '✅ 正例 2 · 简历风（结构递进 · 按能力维度归类）：',
    '// 根=综合能力画像（结论），一级=技能→项目→成果（结构递进）',
    '{"content":"全栈工程师 · 后端为主/前端为辅，具备独立交付能力","children":[',
    '  {"content":"后端技术栈：Spring Boot微服务 + Python数据处理","children":[]},',
    '  {"content":"前端能力：React组件库开发 + Vue管理后台","children":[]},',
    '  {"content":"数据工程：SQL优化 + Redis缓存策略","children":[]}',
    ']}',
    '点评：根=结论（"全栈+独立交付"），一级=支撑根结论的技能方向（结构递进），所有子节点严格属于技能范畴',
    '',
    '✅ 正例 3 · 方法论文章风（程度递进 · 强信号→辅助信号→反信号）：',
    '// 根=核心判断结论，一级=按信号强度递进排列（强→中→反）',
    '{"content":"PMF达成的关键标志是用户主动留存与自发传播，而非付费增长","children":[',
    '  {"content":"核心信号：D30留存率>40%且自然增长占比>60%","children":[]},',
    '  {"content":"辅助信号：NPS>50，用户主动推荐行为频发","children":[]},',
    '  {"content":"伪信号识别：主要靠付费投放维持的增长不构成PMF","children":[]}',
    ']}',
    '点评：根=判断结论（"留存+传播>付费增长"），一级按信号强度递进（核心→辅助→反信号），每层上下统合',
    '',
    '❌ 反例 1（结论缺失 + 空标签 + 父子脱节）：',
    '{"content":"PMF","children":[',
    '  {"content":"信号","children":[{"content":"留存","children":[]}]},',
    '  {"content":"指标","children":[{"content":"NPS","children":[]}]},',
    '  {"content":"判断","children":[{"content":"自然增长","children":[]}]}',
    ']}',
    '反例错在：①根节点"PMF"是标签非结论 ②"信号/指标/判断"为空标签违反结论先行 ③子节点丢失阈值违反以上统下（"留存"不能支撑"信号"的判断）',
    '',
    '❌ 反例 2（分类边界污染 · 不同语义类别混入同一父节点）：',
    '{"content":"专业技能","children":[',
    '  {"content":"Python开发","children":[]},',
    '  {"content":"平台活跃度维持","children":[]},',
    '  {"content":"项目周期缩短30%","children":[]},',
    '  {"content":"送礼策略优化","children":[]},',
    '  {"content":"交易结算","children":[]}',
    ']}',
    '反例错在：①"平台活跃度维持"是运营指标 ②"项目周期缩短"是项目成果 ③"送礼策略优化"是业务手段 ④"交易结算"是业务操作——均不是技能，应分别归入"运营成果""项目成果""业务策略""工作职责"等对应父节点',
    '',
    '❌ 反例 3（子节点过度扁平 · 超过8个直接子节点未分组）：',
    '{"content":"专业技能 · Python/Java/Spring Boot/React/Vue/Node.js/Docker/K8s/MySQL/Redis","children":[',
    '  {"content":"Python","children":[]},',
    '  {"content":"Java","children":[]},',
    '  {"content":"Spring Boot","children":[]},',
    '  {"content":"React","children":[]},',
    '  {"content":"Vue","children":[]},',
    '  {"content":"Node.js","children":[]},',
    '  {"content":"Docker","children":[]},',
    '  {"content":"Kubernetes","children":[]},',
    '  {"content":"MySQL","children":[]},',
    '  {"content":"Redis","children":[]}',
    ']}',
    '反例错在：1个父节点下直接挂了10个叶子，视觉拥挤、难以扫描。✅ 正确做法：应插入中间归纳层——',
    '{"content":"专业技能 · Python/Java/.../Redis","children":[',
    '  {"content":"后端技术 · Java / Python / Spring Boot","children":[',
    '    {"content":"Java：Spring Boot微服务","children":[]},',
    '    {"content":"Python：数据处理与API","children":[]},',
    '    {"content":"Node.js：中间层服务","children":[]}',
    '  ]},',
    '  {"content":"前端技术 · React / Vue","children":[',
    '    {"content":"React：组件库与状态管理","children":[]},',
    '    {"content":"Vue：管理后台快速开发","children":[]}',
    '  ]},',
    '  {"content":"基础设施 · Docker / K8s / MySQL / Redis","children":[',
    '    {"content":"Docker + K8s：容器化部署","children":[]},',
    '    {"content":"MySQL：关系型数据存储","children":[]},',
    '    {"content":"Redis：缓存与消息队列","children":[]}',
    '  ]}',
    ']}',
    '',
    '❌ 反例 4（节点标题重复 · 父子内容相同/同级内容相同）：',
    '{"content":"专业技能","children":[',
    '  {"content":"专业技能","children":[]},',
    '  {"content":"Python开发","children":[]},',
    '  {"content":"Python开发","children":[]}',
    ']}',
    '反例错在：①子节点"专业技能"与父节点 content 完全相同 ②两个"Python开发"同级重复——✅ 正确：删除重复子节点，合并去重为 {"content":"专业技能","children":[{"content":"Python开发","children":[]}]}',
    '',
    '❌ 反例 5（文件名作为节点标题 · 最严重错误）：',
    '{"content":"思维导图","children":[',
    '  {"content":"产品经理_深圳 15-20K】谭艳丽 9年.pdf","children":[]},',
    '  {"content":"产品经理_深圳 15-20K】谭艳丽 9年.pdf(1)","children":[]},',
    '  {"content":"产品经理_深圳 15-20K】谭艳丽 9年.pdf(2)","children":[]}',
    ']}',
    '反例错在：所有二级节点用了原始文件名！完全无意义。✅ 正确做法：从PDF正文内容中提取实际章节标题，如 "工作经历 · 9年产品经理/社交电商赛道""专业技能 · Python/数据分析/SQL""教育背景 · 深圳大学 本科"',
    '',
    '❌ 反例 6（节点内容过长未拆分 · 违反35字约束）：',
    '{"content":"专业技能","children":[',
    '  {"content":"负责从0到1搭建用户增长体系通过裂变投放组合拳实现6个月DAU从0到50万同时搭建了AB实验平台和数据看板","children":[]}',
    ']}',
    '反例错在：子节点内容 60+ 字远超 35 字上限。✅ 正确：拆分为父子结构——',
    '{"content":"专业技能","children":[',
    '  {"content":"用户增长体系搭建 · DAU 0→50万/6个月","children":[',
    '    {"content":"裂变增长：邀请+拼团机制","children":[]},',
    '    {"content":"付费投放：信息流+KOL策略","children":[]},',
    '    {"content":"数据基建：AB实验平台+看板","children":[]}',
    '  ]}',
    ']}',
    '',
    '❌ 反例 7（结论先行违反 · 根节点和一级节点均为空标签）：',
    '{"content":"2024年Q4工作总结","children":[',
    '  {"content":"概述","children":[{"content":"本季度完成了A项目上线","children":[]}]},',
    '  {"content":"数据分析","children":[{"content":"用户增长20%","children":[]}]},',
    '  {"content":"问题与改进","children":[{"content":"服务器响应慢","children":[]}]}',
    ']}',
    '反例错在：①根节点仅重复标题无结论 ②一级节点"概述/数据分析/问题与改进"全是空标签。✅ 正确：根="Q4核心成果：A项目上线驱动用户增长20%，技术债务仍需解决"，一级含实质性结论。',
    '',
    `## 文档标题：${doc.sourceMeta.title || '自动生成思维导图'}`,
    '',
    '## 输入内容',
    cleanedMarkdown,
  ].join('\n');
}

export function buildCompatJsonPrompt(doc: NormalizedDocument): string {
  const cleanedMarkdown = cleanMarkdownForLLM(doc.markdown).slice(0, 8000);
  return [
    '你是一名结构化信息提炼专家。任务：运用金字塔原理，从原文中精准提炼信息并组织为**总分结构**思维导图 JSON。',
    '',
    PYRAMID_DOCUMENT_SUMMARY_FRAMEWORK,
    '',
    '## 核心四原则',
    '- 结论先行：根节点 = 全文核心结论；每个父节点都必须是结论性陈述，不得仅为分类标签。',
    '- 以上统下：上层是下层的思想概括，下层是上层的具体支撑；禁止父说A、子说B。',
    '- 归类分组：同级节点按同一逻辑维度分组，满足 MECE，互斥且完全穷尽。',
    '- 逻辑递进：同级节点必须按演绎、时间、结构或程度之一排序，不得随机排列。',
    '',
    '## 生成规则',
    '- 内容必须忠实原文；允许压缩改写，不允许新增事实、数据、人名、案例、术语。',
    '- 模糊、乱码、不完整句子直接忽略；文档没有的维度不要创建节点。',
    '- 同一信息多次出现时只保留一次，放到最相关父节点下。',
    '- 文件名禁令：任何节点 content 禁止包含文件名或文件扩展名。',
    '- 每个子节点必须属于其父节点语义范畴；如果不属于，就删除或移到正确位置。',
    '- 根节点和每个父节点都必须包含实质信息，不得使用“概述”“分析”“总结”“背景”“方法”等空标签。',
    '- 节点标题必须唯一；父子、同级之间不得重复或高度相似。',
    '',
    '## 约束条件',
    `- 最大层级：${MAX_TREE_DEPTH}`,
    `- 最大节点数：${MAX_TREE_NODES}`,
    '- 节点文本目标 15-25 字，上限 35 字。',
    '- 超过 35 字必须拆为父子结构，严禁截断意思。',
    '- 一级节点 2-8 个，由内容决定，不凑数。',
    '- 每个节点的直接子节点数 ≤ 8 个；超过时自动创建中间归纳分组。',
    '- 所有二级节点必须至少展开一层；二级节点不得保持叶子状态；子节点必须来自原文。',
    '',
    '## 输出要求',
    '- 只输出合法 JSON，不要输出 Markdown、解释、自检过程或额外文字。',
    '- JSON 结构：{"title":"...","root":{"content":"...","children":[...]}}。',
    '- 生成前先在内部完成规划与自检，再一次性输出最终 JSON。',
    '',
    PYRAMID_SELF_CHECK_LOOP,
    '',
    '## 兜底规则',
    '- 原文 <100 字或无明显结构：输出“单根节点 + 1-2 个子节点”的最小合法结构。',
    '- 原文全为乱码或无法识别：输出 {"content":"无法识别的内容","children":[]}。',
    '',
    `## 文档标题：${doc.sourceMeta.title || '自动生成思维导图'}`,
    '',
    '## 输入内容',
    cleanedMarkdown,
  ].join('\n');
}

function extractJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const candidates = new Set<string>([trimmed, withoutFence]);

  for (const source of [trimmed, withoutFence]) {
    const start = source.indexOf('{');
    if (start < 0) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.add(source.slice(start, i + 1).trim());
          break;
        }
      }
    }
  }

  return [...candidates].filter(Boolean);
}

function tryRepairTruncatedJson(text: string): string {
  let repaired = text.trim();

  // Strip markdown fences
  repaired = repaired.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  // Extract from first { to end
  const startIdx = repaired.indexOf('{');
  if (startIdx < 0) return text;
  repaired = repaired.slice(startIdx);

  // Try to close unclosed strings
  const inStringCount = (repaired.match(/(?<!\\)"/g) || []).length;
  if (inStringCount % 2 !== 0) {
    repaired += '"';
  }

  // Count unclosed brackets
  let braces = 0;
  let brackets = 0;
  let inStr = false;
  let esc = false;
  for (const ch of repaired) {
    if (inStr) {
      if (esc) { esc = false; } else if (ch === '\\') { esc = true; } else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }

  // Close unclosed brackets and braces
  while (brackets > 0) { repaired += ']'; brackets--; }
  while (braces > 0) { repaired += '}'; braces--; }

  return repaired;
}

function parseLLMTreeFromTextWithMeta(text: string): { tree: LLMMindMapTree; parsedJson: string } | null {
  const startedAt = Date.now();
  const candidates = extractJsonCandidates(text);
  logCompatTiming('parse.start', {
    textLength: text.length,
    candidateCount: candidates.length,
  });

  // First try: normal extraction
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const validated = llmTreeSchema.safeParse(parsed);
      if (validated.success) {
        logCompatTiming('parse.success', {
          mode: 'direct',
          candidateIndex: i,
          candidateLength: candidate.length,
          elapsedMs: Date.now() - startedAt,
        });
        return { tree: validated.data, parsedJson: candidate };
      }
    } catch {
      continue;
    }
  }

  // Second try: repair truncated JSON
  const repaired = tryRepairTruncatedJson(text);
  if (repaired !== text) {
    try {
      const parsed = JSON.parse(repaired) as unknown;
      const validated = llmTreeSchema.safeParse(parsed);
      if (validated.success) {
        logCompatTiming('parse.success', {
          mode: 'repair',
          candidateLength: repaired.length,
          elapsedMs: Date.now() - startedAt,
        });
        return { tree: validated.data, parsedJson: repaired };
      }
    } catch {
      // repair failed, fall through
    }
  }

  logCompatTiming('parse.failed', {
    elapsedMs: Date.now() - startedAt,
    candidateCount: candidates.length,
    repairAttempted: repaired !== text,
  });

  return null;
}

function parseLLMTreeFromText(text: string): LLMMindMapTree | null {
  return parseLLMTreeFromTextWithMeta(text)?.tree ?? null;
}

async function generateTreeWithCompatProvider(
  doc: NormalizedDocument,
  llmConfig: ResolvedLLMConfig,
  requestConfig: LLMRequestConfig,
  options: { abortSignal?: AbortSignal },
): Promise<MindMapTree> {
  const modelProvider = createProviderClient(llmConfig);
  const languageModel = modelProvider.chat(llmConfig.model as any);
  const jsonMaxTokens = parseNonNegativeInt(process.env.LLM_JSON_MAX_TOKENS, 7000);
  const prompt = buildCompatJsonPrompt(doc);

  logCompatTiming('request.start', {
    provider: llmConfig.resolvedProvider,
    model: llmConfig.model,
    promptLength: prompt.length,
    markdownLength: doc.markdown.length,
    timeoutMs: requestConfig.timeoutMs ?? null,
    maxRetries: requestConfig.maxRetries,
    maxOutputTokens: jsonMaxTokens,
  });

  const requestStartedAt = Date.now();
  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      model: languageModel,
      system: ANTI_HALLUCINATION_SYSTEM,
      prompt,
      maxRetries: requestConfig.maxRetries,
      timeout: requestConfig.timeoutMs,
      abortSignal: options.abortSignal,
      temperature: 0.1,
      maxOutputTokens: jsonMaxTokens,
    });
  } catch (error) {
    logCompatTiming('request.failed', {
      elapsedMs: Date.now() - requestStartedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  logCompatTiming('request.success', {
    elapsedMs: Date.now() - requestStartedAt,
    textLength: result.text.length,
  });

  const parseStartedAt = Date.now();
  const parsedTreeWithMeta = parseLLMTreeFromTextWithMeta(result.text);
  logCompatTiming('request.parse_complete', {
    elapsedMs: Date.now() - parseStartedAt,
    parsed: Boolean(parsedTreeWithMeta),
  });

  if (!parsedTreeWithMeta) {
    throw new Error('兼容模式无法解析智谱返回的导图 JSON');
  }

  const treeStartedAt = Date.now();
  const parsedTree = parsedTreeWithMeta.tree;
  const finalTree = llmTreeToMindMapTree(parsedTree, doc);
  logCompatTiming('request.transform_complete', {
    elapsedMs: Date.now() - treeStartedAt,
    totalElapsedMs: Date.now() - requestStartedAt,
  });

  return finalTree;
}

function normalizeSummaryPoint(text: string): string {
  return text
    .replace(/^\s*(?:[-*•]+|\d+[.)、])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function collectOutlineLines(tree: MindMapTree, maxLines = 40): string[] {
  const lines: string[] = [];
  const queue: Array<{ node: MindMapNode; depth: number }> = [{ node: tree.root, depth: 0 }];

  while (queue.length > 0 && lines.length < maxLines) {
    const current = queue.shift();
    if (!current) continue;

    const content = normalizeSummaryPoint(current.node.content);
    if (content) {
      const prefix = '  '.repeat(Math.min(current.depth, 3));
      lines.push(`${prefix}- ${content}`);
    }

    const children = current.node.children || [];
    for (const child of children) {
      queue.push({ node: child, depth: current.depth + 1 });
      if (lines.length + queue.length >= maxLines) {
        break;
      }
    }
  }

  return lines;
}

function formatSourceRefForSummary(sourceRef: SourceReference): string {
  if (sourceRef.page) return `page:${sourceRef.page}`;
  if (sourceRef.location) return sourceRef.location;
  if (sourceRef.timestamp) return sourceRef.timestamp;
  if (sourceRef.url) return sourceRef.url;
  return sourceRef.type;
}

function collectDocumentSummaryLines(doc: NormalizedDocument, maxLines = 24): string[] {
  return doc.chunks
    .map((chunk) => {
      const text = normalizeSummaryPoint(chunk.sourceRef.text || chunk.text);
      if (!text) return '';
      return `[${formatSourceRefForSummary(chunk.sourceRef)}] ${text.slice(0, 180)}`;
    })
    .filter(Boolean)
    .slice(0, maxLines);
}

function buildHeuristicDocumentSummaryPoints(doc: NormalizedDocument): string[] {
  const title = doc.sourceMeta.title || '当前文档';
  const lines = collectDocumentSummaryLines(doc, 6);

  if (lines.length === 0) {
    const warning = normalizeSummaryPoint(doc.sourceMeta.parseWarning || '');
    return [
      `${title} 的原文快照为空或不可读，当前无法提炼稳定摘要。`,
      warning ? `解析提示：${warning}` : '当前未提取到可直接引用的正文片段。',
    ];
  }

  const summaryPoints = lines.map((line) => line.replace(/^\[[^\]]+\]\s*/, ''));
  if (doc.sourceMeta.parseWarning) {
    summaryPoints.push(`解析提示：${normalizeSummaryPoint(doc.sourceMeta.parseWarning)}`);
  }
  return summaryPoints.slice(0, 8);
}

function parseSummaryPointsFromText(text: string): string[] {
  const cleanedText = text
    .replace(/```json/gi, '```')
    .replace(/```markdown/gi, '```')
    .trim();

  const jsonCandidate = cleanedText
    .replace(/^```/, '')
    .replace(/```$/, '')
    .trim();

  try {
    const parsed = JSON.parse(jsonCandidate) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((item) => normalizeSummaryPoint(String(item))).filter(Boolean).slice(0, 8);
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { points?: unknown[] }).points)) {
      return (parsed as { points: unknown[] }).points
        .map((item) => normalizeSummaryPoint(String(item)))
        .filter(Boolean)
        .slice(0, 8);
    }
  } catch {
    // Fallback to bullet parsing.
  }

  const bulletPoints = cleanedText
    .split('\n')
    .map((line) => normalizeSummaryPoint(line))
    .filter(Boolean)
    .slice(0, 8);

  return bulletPoints;
}

function buildDocumentSummaryPrompt(doc: NormalizedDocument): string {
  const title = doc.sourceMeta.title || '未命名文档';
  const outline = collectDocumentSummaryLines(doc, 28).join('\n');
  const parseWarning = normalizeSummaryPoint(doc.sourceMeta.parseWarning || '');

  return [
    '你是文档事实总结助手。请直接基于给定原文片段输出简洁中文摘要。',
    '输出要求：',
    '1. 输出 JSON：{"points":["..."]}，不要输出其它字段。',
    '2. points 数量 3-8 条；若原文信息有限，可少于 3 条。',
    '3. 只基于给定原文片段，不要编造外部事实，不要补充推断。',
    '4. 重点提炼：核心主题、关键事实、明确结论；仅当原文明示时才写风险、问题或建议。',
    '5. 优先保留原文中的术语、数据、专有名词与结论性表述。',
    '6. 若原文存在 OCR 噪声、截断或歧义，只能如实弱化表述，不得自行补完。',
    '',
    `文档标题：${title}`,
    `来源类型：${doc.sourceMeta.type}`,
    parseWarning ? `解析提示：${parseWarning}` : '',
    '原文片段：',
    outline,
  ].join('\n');
}

export function buildMarkdownPreviewPrompt(doc: NormalizedDocument): string {
  return [
    '你是资深文档分析助手。请基于输入内容，运用金字塔原理输出一份中文 Markdown 结构化总结。',
    '要求：',
    '1. 仅基于输入内容，不要编造事实。',
    '2. 直接输出 Markdown 文本，不要输出 JSON，不要代码块包裹。',
    '3. 结构必须包含：',
    '   - 一级标题：中心主题',
    '   - 二级标题：中心思想（1-3句话，结论先行）',
    '   - 二级标题：关键论点（3-5个主要分支；信息不足时说明原因，不凑数）',
    '   - 二级标题：支撑依据（每个论点列出原文事实、数据或案例）',
    '   - 二级标题：逻辑关系（说明归纳/演绎/因果/并列/递进关系）',
    '4. 每条 bullet 尽量 8~30 字。',
    '5. 输出语言：简体中文。',
    '',
    PYRAMID_DOCUMENT_SUMMARY_FRAMEWORK,
    '',
    '质量控制：',
    '- 确保每个节点内容完整且有意义',
    '- 避免重复内容',
    '- 保持层级逻辑清晰',
    '- 重要信息优先级更高',
    '',
    PYRAMID_SELF_CHECK_LOOP,
    '',
    `文档标题：${doc.sourceMeta.title || '未命名文档'}`,
    `来源类型：${doc.sourceMeta.type}`,
    '',
    '输入内容：',
    cleanMarkdownForLLM(doc.markdown).slice(0, 14000),
  ].join('\n');
}

function normalizeMarkdownPreview(rawText: string, fallbackTitle: string): { title: string; markdown: string } {
  const cleaned = rawText.trim();
  if (!cleaned) {
    throw new Error('LLM 返回空内容，无法生成 Markdown 解析。');
  }

  const markdown = cleaned.startsWith('#') ? cleaned : `# ${fallbackTitle}\n\n${cleaned}`;
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim() || fallbackTitle;
  return { title, markdown: markdown.endsWith('\n') ? markdown : `${markdown}\n` };
}

export async function generateMarkdownPreview(
  doc: NormalizedDocument,
  options: {
    abortSignal?: AbortSignal;
  } = {},
): Promise<MarkdownPreviewResult> {
  const llmConfig = resolveLLMConfig();
  const hasApiKey = Boolean(llmConfig.apiKey);

  if (!llmConfig.supported || !hasApiKey) {
    const keyHint = llmConfig.keyEnv || '对应 provider 的 API key';
    throw new Error(`LLM 未配置：请检查 ${keyHint}。`);
  }

  const requestConfig = resolveLLMRequestConfig(llmConfig.resolvedProvider);
  const markdownTimeoutSeconds = parseNonNegativeInt(process.env.LLM_MARKDOWN_TIMEOUT, 90);
  const markdownTimeoutMs = markdownTimeoutSeconds > 0 ? markdownTimeoutSeconds * 1000 : undefined;
  const markdownMaxRetries = parseNonNegativeInt(process.env.LLM_MARKDOWN_MAX_RETRIES, requestConfig.maxRetries);
  const modelProvider = createProviderClient(llmConfig);

  const languageModel =
    llmConfig.resolvedProvider === 'openai'
      ? modelProvider(llmConfig.model)
      : modelProvider.chat(llmConfig.model as any);

  const result = await generateText({
    model: languageModel,
    system: MARKDOWN_SUMMARY_SYSTEM,
    prompt: buildMarkdownPreviewPrompt(doc),
    maxRetries: markdownMaxRetries,
    timeout: markdownTimeoutMs ?? requestConfig.timeoutMs,
    abortSignal: options.abortSignal,
    temperature: 0.2,
    maxOutputTokens: 1800,
  });

  const normalized = normalizeMarkdownPreview(result.text, doc.sourceMeta.title || '文档解析');
  return {
    title: normalized.title,
    markdown: normalized.markdown,
    provider: llmConfig.resolvedProvider || llmConfig.provider,
    model: llmConfig.model,
  };
}

export async function generateDocumentSummary(
  doc: NormalizedDocument,
  options: {
    abortSignal?: AbortSignal;
  } = {},
): Promise<AiSummaryResult> {
  const llmConfig = resolveLLMConfig();
  const fallbackPoints = buildHeuristicDocumentSummaryPoints(doc);
  const hasApiKey = Boolean(llmConfig.apiKey);

  if (!llmConfig.supported || !hasApiKey) {
    return {
      points: fallbackPoints,
      provider: 'local',
      model: 'heuristic-v1',
      source: 'heuristic',
    };
  }

  const requestConfig = resolveLLMRequestConfig(llmConfig.resolvedProvider);
  const summaryTimeoutSeconds = parseNonNegativeInt(process.env.LLM_SUMMARY_TIMEOUT, 60);
  const summaryTimeoutMs = summaryTimeoutSeconds > 0 ? summaryTimeoutSeconds * 1000 : undefined;
  const summaryMaxRetries = parseNonNegativeInt(process.env.LLM_SUMMARY_MAX_RETRIES, requestConfig.maxRetries);
  const modelProvider = createProviderClient(llmConfig);

  const languageModel =
    llmConfig.resolvedProvider === 'openai'
      ? modelProvider(llmConfig.model)
      : modelProvider.chat(llmConfig.model as any);

  const result = await generateText({
    model: languageModel,
    system: DOCUMENT_SUMMARY_SYSTEM,
    prompt: buildDocumentSummaryPrompt(doc),
    maxRetries: summaryMaxRetries,
    timeout: summaryTimeoutMs ?? requestConfig.timeoutMs,
    abortSignal: options.abortSignal,
    temperature: 0.2,
    maxOutputTokens: 1000,
  });

  const points = parseSummaryPointsFromText(result.text);
  if (points.length === 0) {
    throw new Error('摘要结果为空，无法展示。');
  }

  return {
    points,
    provider: llmConfig.resolvedProvider || llmConfig.provider,
    model: llmConfig.model,
    source: 'llm',
  };
}

export async function generateMindMapJsonPreview(
  doc: NormalizedDocument,
  options: {
    abortSignal?: AbortSignal;
  } = {},
): Promise<MindMapJsonPreviewResult> {
  const llmConfig = resolveLLMConfig();
  const hasApiKey = Boolean(llmConfig.apiKey);

  if (!llmConfig.supported || !hasApiKey) {
    const keyHint = llmConfig.keyEnv || '对应 provider 的 API key';
    throw new Error(`LLM 未配置：请检查 ${keyHint}。`);
  }

  // ===== 微信文章 + 混元搜索增强：优先走混元联网生成路径 =====
  const isWeChatUrl = doc.sourceMeta.type === 'wechat' ||
    (doc.sourceMeta.sourceUrl && isWeChatArticleUrl(doc.sourceMeta.sourceUrl));

  // 优先尝试腾讯混元（元宝）搜索增强，微信生态独家资源
  if (isWeChatUrl) {
    const hunyuanApiKey = process.env.HUNYUAN_API_KEY?.trim();
    if (hunyuanApiKey) {
      try {
        const { json: rawJson } = await generateWeChatMindMapViaHunyuan(
          doc.sourceMeta.sourceUrl!,
        );

        const parsed = parseLLMTreeFromTextWithMeta(rawJson);
        if (parsed) {
          return {
            tree: parsed.tree,
            parsedJson: parsed.parsedJson,
            rawText: rawJson,
            provider: 'hunyuan-search-enhancement',
            model: process.env.HUNYUAN_MODEL?.trim() || 'hunyuan-turbos-latest',
          };
        }
      } catch (hunyuanError) {
        const errMsg = hunyuanError instanceof Error ? hunyuanError.message : '混元搜索增强失败';
        console.warn(`[MindMap] 腾讯混元搜索增强生成微信文章思维导图JSON预览失败，降级：${errMsg}`);
      }
    }
  }

  // 降级：智谱AI联网搜索
  if (isWeChatUrl && llmConfig.resolvedProvider === 'zhipu' && llmConfig.apiKey) {
    try {
      const { json: rawJson } = await generateWeChatMindMapViaZhipuWebSearch(
        doc.sourceMeta.sourceUrl!,
        { model: llmConfig.model },
      );

      const parsed = parseLLMTreeFromTextWithMeta(rawJson);
      if (parsed) {
        return {
          tree: parsed.tree,
          parsedJson: parsed.parsedJson,
          rawText: rawJson,
          provider: 'zhipu-web-search',
          model: llmConfig.model,
        };
      }
    } catch (zhipuWebSearchError) {
      // 联网生成失败，降级到普通流程
      const errMsg = zhipuWebSearchError instanceof Error ? zhipuWebSearchError.message : '智谱AI联网生成失败';
      console.warn(`[MindMap] 智谱AI联网生成微信文章思维导图JSON预览失败，降级到普通流程：${errMsg}`);
    }
  }

  const requestConfig = resolveLLMRequestConfig(llmConfig.resolvedProvider);
  const jsonTimeoutSeconds = parseNonNegativeInt(process.env.LLM_JSON_TIMEOUT, 90);
  const jsonTimeoutMs = jsonTimeoutSeconds > 0 ? jsonTimeoutSeconds * 1000 : undefined;
  const jsonMaxRetries = parseNonNegativeInt(process.env.LLM_JSON_MAX_RETRIES, requestConfig.maxRetries);
  const jsonMaxTokens = parseNonNegativeInt(process.env.LLM_JSON_MAX_TOKENS, 7000);
  const modelProvider = createProviderClient(llmConfig);

  const languageModel =
    llmConfig.resolvedProvider === 'openai'
      ? modelProvider(llmConfig.model)
      : modelProvider.chat(llmConfig.model as any);

  const result = await generateText({
    model: languageModel,
    system: ANTI_HALLUCINATION_SYSTEM,
    prompt: buildCompatJsonPrompt(doc),
    maxRetries: jsonMaxRetries,
    timeout: jsonTimeoutMs ?? requestConfig.timeoutMs,
    abortSignal: options.abortSignal,
    temperature: 0.2,
    maxOutputTokens: jsonMaxTokens,
  });

  const rawText = result.text;
  const parsed = parseLLMTreeFromTextWithMeta(rawText);
  if (!parsed) {
    const isTruncated = rawText.length > 100 && !rawText.trim().endsWith('}');
    const preview = rawText.length > 300 ? rawText.slice(0, 300) + '...' : rawText;
    const hint = isTruncated
      ? '（JSON 似乎被截断，可能是输出过长。可尝试在 .env 中设置 LLM_JSON_MAX_TOKENS=7000 后重试）'
      : `（LLM 返回内容前 300 字符：${preview}）`;
    throw new Error(`LLM 返回内容不是有效思维导图 JSON ${hint}`);
  }

  return {
    tree: parsed.tree,
    parsedJson: parsed.parsedJson,
    rawText: result.text,
    provider: llmConfig.resolvedProvider || llmConfig.provider,
    model: llmConfig.model,
  };
}

export async function* generateMindMapStream(
  doc: NormalizedDocument,
  options: {
    abortSignal?: AbortSignal;
  } = {},
): AsyncGenerator<GenerateStreamEvent> {
  const llmConfig = resolveLLMConfig();
  const hasApiKey = Boolean(llmConfig.apiKey);

  console.log('[MindMap Debug] LLM配置:', {
    provider: llmConfig.provider,
    resolvedProvider: llmConfig.resolvedProvider,
    supported: llmConfig.supported,
    hasApiKey,
    model: llmConfig.model,
  });

  if (!llmConfig.supported || !hasApiKey) {
    console.log('[MindMap Debug] 走路径1: 启发式生成（无API Key或provider不支持）');
    const fallback = buildHeuristicMindMapTree(doc);
    yield { type: 'skeleton', data: { tree: fallback } };

    const flattened = flattenTree(fallback.root);
    for (const item of flattened.slice(1)) {
      if (!item.parentId) continue;
      yield {
        type: 'node',
        data: {
          patch: {
            type: 'add',
            nodeId: item.node.id,
            parentId: item.parentId,
            index: item.index,
            node: item.node,
            timestamp: Date.now(),
          },
          node: item.node,
        },
      };
    }

    yield { type: 'complete', data: { tree: fallback } };
    return;
  }

  // ===== 微信文章 + 混元搜索增强：优先走混元联网生成路径 =====
  const isWeChatUrl = doc.sourceMeta.type === 'wechat' ||
    (doc.sourceMeta.sourceUrl && isWeChatArticleUrl(doc.sourceMeta.sourceUrl));

  if (isWeChatUrl) {
    const hunyuanApiKey = process.env.HUNYUAN_API_KEY?.trim();
    if (hunyuanApiKey) {
      let workingTree = buildHeuristicMindMapTree(doc);
      yield { type: 'skeleton', data: { tree: workingTree } };

      try {
        const { json: rawJson } = await generateWeChatMindMapViaHunyuan(
          doc.sourceMeta.sourceUrl!,
        );

        const parsedTree = parseLLMTreeFromText(rawJson);
        if (parsedTree) {
          const finalTree = llmTreeToMindMapTree(parsedTree, doc);
          const patches = buildDiffPatches(workingTree, finalTree);
          for (const patch of patches) {
            workingTree = applyTreePatch(workingTree, patch);
            if (patch.type === 'add') {
              yield { type: 'node', data: { patch, node: patch.node } };
            }
          }
          yield { type: 'complete', data: { tree: finalTree } };
          return;
        }
      } catch (hunyuanError) {
        const errMsg = hunyuanError instanceof Error ? hunyuanError.message : '混元搜索增强失败';
        console.warn(`[MindMap] 腾讯混元搜索增强生成微信文章思维导图失败，降级：${errMsg}`);
      }
    }
  }

  // 降级：智谱AI联网搜索
  if (isWeChatUrl && llmConfig.resolvedProvider === 'zhipu' && llmConfig.apiKey) {
    let workingTree = buildHeuristicMindMapTree(doc);
    yield { type: 'skeleton', data: { tree: workingTree } };

    try {
      const { json: rawJson } = await generateWeChatMindMapViaZhipuWebSearch(
        doc.sourceMeta.sourceUrl!,
        { model: llmConfig.model },
      );

      const parsedTree = parseLLMTreeFromText(rawJson);
      if (parsedTree) {
        const finalTree = llmTreeToMindMapTree(parsedTree, doc);

        // 发送增量补丁
        const patches = buildDiffPatches(workingTree, finalTree);
        for (const patch of patches) {
          workingTree = applyTreePatch(workingTree, patch);
          if (patch.type === 'add') {
            yield { type: 'node', data: { patch, node: patch.node } };
          }
        }

        yield { type: 'complete', data: { tree: finalTree } };
        return;
      }
      // JSON 解析失败，降级到普通流程
    } catch (zhipuWebSearchError) {
      // 联网生成失败，降级到普通流程
      const errMsg = zhipuWebSearchError instanceof Error ? zhipuWebSearchError.message : '智谱AI联网生成失败';
      // 不抛出错误，降级继续走普通流程
      console.warn(`[MindMap] 智谱AI联网生成微信文章思维导图失败，降级到普通流程：${errMsg}`);
    }
  }

  const model = llmConfig.model;
  const prompt = buildPrompt(doc);
  const requestConfig = resolveLLMRequestConfig(llmConfig.resolvedProvider);
  let workingTree = buildHeuristicMindMapTree(doc);
  let skeletonSent = false;
  let latestStableTree = workingTree;

  if (llmConfig.resolvedProvider && llmConfig.resolvedProvider !== 'openai') {
    console.log('[MindMap Debug] 走路径3: 非OpenAI Provider -', llmConfig.resolvedProvider);
    console.log('[MindMap Debug] 使用提示词: buildCompatJsonPrompt()');
    skeletonSent = true;
    yield {
      type: 'skeleton',
      data: {
        tree: workingTree,
      },
    };

    try {
      const finalTree = await generateTreeWithCompatProvider(doc, llmConfig, requestConfig, options);
      const patches = buildDiffPatches(latestStableTree, finalTree);
      for (const patch of patches) {
        workingTree = applyTreePatch(workingTree, patch);
        if (patch.type === 'add') {
          yield {
            type: 'node',
            data: {
              patch,
              node: patch.node,
            },
          };
        }
      }

      yield {
        type: 'complete',
        data: {
          tree: finalTree,
        },
      };
      return;
    } catch (error) {
      yield {
        type: 'error',
        data: {
          message:
            error instanceof Error
              ? `${error.message}. 已返回本地启发式结果（节点数 ${countNodes(workingTree.root)}）。`
              : '生成失败，已返回本地启发式结果。',
        },
      };
      yield {
        type: 'complete',
        data: {
          tree: workingTree,
        },
      };
      return;
    }
  }

  const modelProvider = createProviderClient(llmConfig);

  try {
    console.log('[MindMap Debug] 走路径2: OpenAI Provider');
    console.log('[MindMap Debug] 使用提示词: buildPrompt()');
    console.log('[MindMap Debug] 提示词长度:', prompt.length, '字符');
    
    // Most non-OpenAI providers expose Chat Completions compatible endpoints, not Responses API.
    const languageModel =
      llmConfig.resolvedProvider === 'openai'
        ? modelProvider(model)
        : modelProvider.chat(model as any);

    const result = streamObject({
      model: languageModel,
      schema: llmTreeSchema,
      system: ANTI_HALLUCINATION_SYSTEM,
      prompt,
      maxRetries: requestConfig.maxRetries,
      timeout: requestConfig.timeoutMs,
      abortSignal: options.abortSignal,
    });

    for await (const partial of result.partialObjectStream) {
      const candidateRoot = sanitizePartialNode((partial as { root?: unknown })?.root);
      const candidateTitle = (partial as { title?: unknown })?.title;

      if (!candidateRoot) {
        continue;
      }

      const parseResult = llmTreeSchema.safeParse({
        title: typeof candidateTitle === 'string' && candidateTitle.trim() ? candidateTitle.trim() : doc.sourceMeta.title || '自动生成导图',
        root: candidateRoot,
      });

      if (!parseResult.success) {
        continue;
      }

      const nextTree = llmTreeToMindMapTree(parseResult.data, doc);

      if (!skeletonSent) {
        skeletonSent = true;
        latestStableTree = nextTree;
        workingTree = nextTree;
        yield {
          type: 'skeleton',
          data: {
            tree: nextTree,
          },
        };
        continue;
      }

      const patches = buildDiffPatches(latestStableTree, nextTree);
      for (const patch of patches) {
        workingTree = applyTreePatch(workingTree, patch);

        if (patch.type === 'add') {
          yield {
            type: 'node',
            data: {
              patch,
              node: patch.node,
            },
          };
        }
      }

      latestStableTree = nextTree;
    }

    const finalObject = await result.object;
    const finalTree = llmTreeToMindMapTree(finalObject, doc);

    if (!skeletonSent) {
      yield { type: 'skeleton', data: { tree: finalTree } };
    }

    yield {
      type: 'complete',
      data: {
        tree: finalTree,
      },
    };
  } catch (error) {
    const fallback = latestStableTree;
    if (!skeletonSent) {
      yield { type: 'skeleton', data: { tree: fallback } };
    }

    yield {
      type: 'error',
      data: {
        message:
          error instanceof Error
            ? `${error.message}. 已返回本地启发式结果（节点数 ${countNodes(fallback.root)}）。`
            : '生成失败，已返回本地启发式结果。',
      },
    };

    yield {
      type: 'complete',
      data: {
        tree: fallback,
      },
    };
  }
}

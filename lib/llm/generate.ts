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

type OpenAICompatibleProvider = 'openai' | 'zhipu' | 'kimi' | 'minimax' | 'qwen' | 'hunyuan';

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
let cachedZhipuFetch: FetchFunction | null | undefined;

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

function getZhipuFetchWithLocalCA(): FetchFunction | undefined {
  if (cachedZhipuFetch !== undefined) {
    return cachedZhipuFetch || undefined;
  }

  const certPath = resolveCaCertPath();
  if (!certPath) {
    cachedZhipuFetch = null;
    return undefined;
  }

  try {
    const ca = readFileSync(certPath, 'utf8');
    const dispatcher = new Agent({ connect: { ca } });

    cachedZhipuFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const nextInit = (init || {}) as RequestInit & { dispatcher?: unknown };
      if (nextInit.dispatcher) {
        return fetch(input, nextInit);
      }
      return fetch(input, { ...nextInit, dispatcher } as RequestInit & { dispatcher: Agent });
    }) as FetchFunction;
    return cachedZhipuFetch;
  } catch {
    cachedZhipuFetch = null;
    return undefined;
  }
}

function createProviderClient(llmConfig: ResolvedLLMConfig) {
  const customFetch = llmConfig.resolvedProvider === 'zhipu' ? getZhipuFetchWithLocalCA() : undefined;

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
      result.push(trimmed);
      continue;
    }

    if (/^---$/.test(trimmed) || /^\[(?:page|ocr-page):\d+\]$/.test(trimmed)) {
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
  }
  return collected;
}

function scoreSentenceForBranch(branchLabel: string, sentence: string): number {
  const branchKeywords = branchLabel.match(/[\u3400-\u9fff]{3,6}|[A-Za-z]{3,}/g) || [];
  if (branchKeywords.length === 0) {
    const shortKeywords = branchLabel.match(/[\u3400-\u9fff]{2}/g) || [];
    if (shortKeywords.length === 0) return 0;
    let shortScore = 0;
    for (const kw of shortKeywords) {
      if (sentence.includes(kw)) shortScore += 1;
    }
    return shortScore;
  }
  let score = 0;
  for (const keyword of branchKeywords) {
    if (sentence.includes(keyword)) {
      score += keyword.length >= 4 ? 3 : 2;
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

  const emptyTopChildren = topChildren.filter((child) => (child.children?.length || 0) === 0);
  const emptyRatio = emptyTopChildren.length / topChildren.length;
  const shouldAugment = topChildren.length >= 3 && emptyRatio >= 0.6;
  if (!shouldAugment) return tree;

  const pool = collectChunkSentences(doc);
  if (pool.length === 0) return tree;
  const usedSentences = new Set<string>();

  const MIN_SCORE_THRESHOLD = 2;
  const MAX_DETAILS_PER_BRANCH = 3;

  const nextRootChildren = topChildren.map((child) => {
    if ((child.children?.length || 0) > 0) return child;
    if (!isCategoryLikeLabel(child.content)) return child;

    const ranked = pool
      .map((item) => ({
        ...item,
        score: scoreSentenceForBranch(child.content, item.sentence),
      }))
      .filter((item) => item.score >= MIN_SCORE_THRESHOLD)
      .sort((a, b) => b.score - a.score);

    const selected = ranked
      .filter((item) => !usedSentences.has(item.sentence))
      .slice(0, MAX_DETAILS_PER_BRANCH);

    if (selected.length === 0) return child;

    for (const item of selected) usedSentences.add(item.sentence);
    const details = selected.map((item) =>
      createHeuristicNode(item.sentence, item.sourceRef, 'detail', 0.6),
    );

    return {
      ...child,
      children: details,
    };
  });

  return {
    ...tree,
    root: {
      ...tree.root,
      children: nextRootChildren,
    },
  };
}

export function repairSparseFirstLayerForDoc(tree: MindMapTree, doc: NormalizedDocument): MindMapTree {
  const fallbackTitle = tree.meta.title || doc.sourceMeta.title || '思维导图';
  const sanitized = sanitizeMindMapTreeForOutput(tree, fallbackTitle);
  const result = ensureFirstLayerDetails(sanitized, doc);
  const validated = validateSemanticHierarchy(result);
  const restructured = restructureOversizedBranches(validated);
  return deduplicateNodeTitles(restructured);
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

  const isNonSkillChild = (childLabel: string): boolean => {
    for (const [pattern, category] of NON_SKILL_CHILD_PATTERNS) {
      if (pattern.test(childLabel)) return true;
    }
    return false;
  };

  const nextTopChildren = topChildren.map((parent) => {
    if (!isSkillParent(parent.content)) return parent;
    const parentChildren = parent.children;
    if (!parentChildren || parentChildren.length === 0) return parent;

    const filteredChildren = parentChildren.filter((child) => {
      if (isNonSkillChild(child.content)) {
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
      const finalLabel = label.length > 24 ? label.slice(0, 24) : label;

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
        const originalContent = child.content;
        const newContent = originalContent.length + suffix.length > 35
          ? originalContent.slice(0, 35 - suffix.length) + suffix
          : originalContent + suffix;
        filtered.push({ ...dedup(child), content: newContent });
        continue;
      }

      if (allRedundant) {
        siblingCollisionCount += 1;
        const suffix = `(${siblingCollisionCount})`;
        const newContent = child.content.length + suffix.length > 35
          ? child.content.slice(0, 35 - suffix.length) + suffix
          : child.content + suffix;
        filtered.push({ ...dedup(child), content: newContent });
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
      if (title.length >= 2 && title.length <= 80 && !isGarbledText(title) && !PAGE_LABEL_RE.test(title)) {
        return title;
      }
    }
  }
  
  for (const line of lines.slice(0, 15)) {
    if (/^#{2,6}\s+/.test(line)) {
      const title = line.replace(/^#{2,6}\s+/, '').trim();
      if (title.length >= 2 && title.length <= 80 && !isGarbledText(title) && !PAGE_LABEL_RE.test(title)) {
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
      if (title.length >= 2 && title.length <= 40 && !isGarbledText(title)) {
        return title;
      }
    }
  }
  
  for (const line of lines.slice(0, 5)) {
    const cleaned = line.replace(/[【】\[\]（）()]/g, ' ').trim();
    if (cleaned.length >= 4 && cleaned.length <= 50) {
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
  
  if (fileName) {
    const cleanName = fileName.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
    if (cleanName.length >= 2 && cleanName.length <= 50) {
      return cleanName;
    }
  }
  
  return '思维导图';
}

const PAGE_LABEL_RE = /^(Page\s+\d+|OCR\s+Page\s+\d+|OCR\s+第\d+页|page:\d+|ocr-page:\d+|第\d+页)$/i;

function titleFromChunk(text: string, index: number): string {
  const heading = text
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => /^#{2,6}\s+/.test(line));

  if (heading) {
    const title = heading.replace(/^#{2,6}\s+/, '').trim();
    if (title.length >= 2 && !isGarbledText(title) && !PAGE_LABEL_RE.test(title)) {
      return title.slice(0, 80);
    }
  }

  const nonPageLines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !PAGE_LABEL_RE.test(line) && !/^---$/.test(line) && !/^\[.*:.*\]$/.test(line));

  for (const line of nonPageLines.slice(0, 5)) {
    const cleaned = line.replace(/^#{1,6}\s+/, '').trim();
    if (cleaned.length >= 4 && cleaned.length <= 80 && !isGarbledText(cleaned) && !PAGE_LABEL_RE.test(cleaned)) {
      return cleaned.slice(0, 80);
    }
  }

  const sentences = extractSentences(text, 3);
  for (const sentence of sentences) {
    if (sentence.length >= 4 && sentence.length <= 80 && !isGarbledText(sentence)) {
      return sentence.slice(0, 80);
    }
  }

  return `分块 ${index + 1}`;
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
  return deduplicateNodeTitles(restructured);
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
  const title = extractSmartTitle(doc.markdown, doc.sourceMeta.sourceFileName) || doc.sourceMeta.title || '思维导图';

  if (doc.chunks.length > 1) {
    const root = createHeuristicNode(title, sourceRef, 'main', 0.7);

    root.children = doc.chunks.slice(0, 24).map((chunk, index) => {
      const chunkSourceRef = chunk.sourceRef || sourceRef;
      const branch = createHeuristicNode(titleFromChunk(chunk.text, index), chunkSourceRef, 'detail', 0.68);
      branch.children = extractSentences(chunk.text, 4).map((sentence) =>
        createHeuristicNode(sentence.slice(0, 80), chunkSourceRef, 'detail', 0.62),
      );
      return branch;
    });

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
    return mindMapTreeSchema.parse(deduped);
  }

  const sentences = extractSentences(doc.markdown, 12);

  const root = createHeuristicNode(title, sourceRef, 'main', 0.7);

  const groupCount = Math.min(4, Math.max(3, Math.ceil(sentences.length / 3)));
  const itemsPerGroup = Math.ceil(sentences.length / groupCount);

  for (let i = 0; i < groupCount; i++) {
    const groupItems = sentences.slice(i * itemsPerGroup, (i + 1) * itemsPerGroup);
    if (groupItems.length === 0) continue;

    const branch = createHeuristicNode(`主题 ${i + 1}`, sourceRef, 'detail', 0.65);

    groupItems.forEach((item) => {
      branch.children?.push(
        createHeuristicNode(item.slice(0, 80), sourceRef, 'detail', 0.62),
      );
    });

    if ((branch.children?.length ?? 0) > 0) {
      root.children?.push(branch);
    }
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
  return mindMapTreeSchema.parse(deduped);
}

const ANTI_HALLUCINATION_SYSTEM = [
  '你是一名结构化信息提炼专家，不是创作助手。',
  '你的唯一工作是从用户提供的文档中精准提炼信息并组织为思维导图结构。',
  '绝对禁止编造、推测、补充、合理化任何文档中未明确出现的信息。',
  '遇到模糊或无法识别的内容，直接忽略，不要猜测。',
  '文档中没有的分类维度，不要创建节点。',
  '同一信息多次出现时只保留一次，归入最相关父节点。',
  '文末被截断时以最后一个完整段落为准，不补全断尾。',
  '每个子节点必须属于其父节点的语义范畴——禁止将不同类别的内容混入同一个父节点下（如"专业技能"下只能放技能相关内容，不能混入项目成果、运营指标、业务操作等）',
  '输出前必须逐条自检：每个子节点的关键词能否直接推导出它属于父节点定义的范畴？若不能，立即删除或移到正确父节点。',
  '任何父节点的直接子节点不得超过8个。当某节点下信息超过8条时，必须创建中间归纳节点（如"后端技术""前端技术"等分组名），将相关内容归入二级分组，核心信息作为三级节点。',
  '节点标题必须唯一：任何父节点与其直接子节点的 content 不能完全相同或高度相似。同一父节点下的同级节点之间 content 也不能重复——每个节点必须表达该层级下独特的信息维度。',
].join('\n');

function buildPrompt(doc: NormalizedDocument): string {
  const cleanedMarkdown = cleanMarkdownForLLM(doc.markdown).slice(0, 12000);
  return [
    '你是一名结构化信息提炼专家。任务：从原文中精准提炼信息，组织为思维导图结构。',
    '',
    '## 第一步 · 内部规划（不输出，只用于自检）',
    '1. 判断文档类型（论文 / 文章 / 博客 / 会议纪要 / 教程 / 简历 / 其他）',
    '2. 扫描全文，识别 2-8 个互斥的核心维度',
    '3. 自检：维度是否 MECE？粒度是否一致？父节点能否概括所有子节点？',
    '4. 逐节点验证：每个子节点的语义范畴是否严格属于其父节点？',
    '   - 例：如果父节点是"专业技能"，子节点只能放技能名称/水平/证书等',
    '   - 反例：不可在"专业技能"下放"项目周期缩短""平台活跃度维持"等运营类内容',
    '5. 完成自检后再开始输出，思考过程不写入最终结果',
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
    '   - 禁止将操作指标（如"留存""转化率"）放入"技能"类节点',
    '   - 禁止将项目成果（如"周期缩短""成本降低"）放入"技能"类节点',
    '   - 禁止将业务操作（如"交易结算""对账""审批"）放入"技能"类节点',
    '   - 如果某条信息无法归入任何已有父节点的语义范畴，不要强行放入',
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
    '3. 重组的依据是语义关联，而非原文章节顺序',
    '',
    '## 子节点数量管理（重要）',
    '- 任何节点的直接子节点数 ≤ 8 个，保持视觉清爽',
    '- 当某节点下信息 > 8 条时：在父节点与叶子之间插入归纳节点（二级分组）',
    '- 归纳方法：按语义相似度将子节点分为 2-4 组，每组用一个简洁词组命名（4-8 字）',
    '- 示例："专业技能"下有 Python、Java、Spring Boot、React、Vue、Node.js、Docker、K8s、MySQL、Redis 时 → 分为"后端技术"和"前端与运维"两个中间节点',
    '- 禁止为凑整而删除信息——信息多时用"增加层级"而非"减少节点"',
    '',
    '## 好导图的判定标准（输出前自检）',
    '- 一级节点之间互斥不重叠（MECE）',
    '- 同层节点粒度一致（不能左边"模型架构"右边"某个超参的具体值"）',
    '- 父节点能概括所有子节点（父子语义闭包）：每个子节点抽取关键词后，能否直接回答"这属于父节点范畴吗？"',
    '- 叶子节点自含（脱离上下文也能读懂）',
    '- 无空标签节点（禁止只写分类名而无实质内容，如"特点 / 优点 / 其他"）',
    '- 节点语言与原文一致（中文文档输出中文，英文文档输出英文）',
    '- 节点标题唯一：父节点与子节点 content 不能相同或高度相似（如父=专业技能 子不能=专业技能）；同级节点间 content 不可重复',
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
    '## Few-shot',
    '',
    '✅ 正例 1 · 学术论文风（强结构）：',
    '{"content":"模型架构 · Transformer · 编码器-解码器堆叠","children":[',
    '  {"content":"核心：Scaled Dot-Product Attention","children":[]},',
    '  {"content":"多头并行：8 个 attention head","children":[]},',
    '  {"content":"位置编码：正弦函数显式注入","children":[]}',
    ']}',
    '',
    '✅ 正例 2 · 简历/技能风（分类边界清晰）：',
    '{"content":"专业技能 · Python / Java / React","children":[',
    '  {"content":"后端：Spring Boot微服务开发","children":[]},',
    '  {"content":"前端：React + TypeScript组件库","children":[]},',
    '  {"content":"数据：SQL优化与Redis缓存策略","children":[]}',
    ']}',
    '注意：此例中所有子节点都是技能名称/方向，不包含"项目周期""团队规模""营收增长"等非技能类信息',
    '',
    '✅ 正例 3 · 方法论文章风（松结构）：',
    '{"content":"PMF 验证信号 · 用户主动留存 + 自发传播","children":[',
    '  {"content":"留存：D30 留存率 >40%","children":[]},',
    '  {"content":"NPS >50 且自然增长占比 >60%","children":[]},',
    '  {"content":"反信号：主要靠付费投放维持增长","children":[]}',
    ']}',
    '',
    '❌ 反例 1（空标签 + 粒度散 + 信息密度坍塌）：',
    '{"content":"PMF","children":[',
    '  {"content":"信号","children":[{"content":"留存","children":[]}]},',
    '  {"content":"指标","children":[{"content":"NPS","children":[]}]},',
    '  {"content":"判断","children":[{"content":"自然增长","children":[]}]}',
    ']}',
    '反例错在：①"信号/指标/判断"语义重叠违反 MECE ②子节点丢失关键阈值 ③"留存/NPS"单独读不懂违反叶子自含',
    '',
    '❌ 反例 2（分类边界污染 · 不同语义类别的信息混入同一父节点）：',
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
    `## 文档标题：${doc.sourceMeta.title || '自动生成思维导图'}`,
    '',
    '## 输入内容',
    cleanedMarkdown,
  ].join('\n');
}

function buildCompatJsonPrompt(doc: NormalizedDocument): string {
  const cleanedMarkdown = cleanMarkdownForLLM(doc.markdown).slice(0, 12000);
  return [
    '你是一名结构化信息提炼专家。任务：从原文中精准提炼信息，组织为思维导图 JSON。',
    '',
    '## 第一步 · 内部规划（不输出，只用于自检）',
    '1. 判断文档类型（论文 / 文章 / 博客 / 会议纪要 / 教程 / 简历 / 其他）',
    '2. 扫描全文，识别 2-8 个互斥的核心维度',
    '3. 自检：维度是否 MECE？粒度是否一致？父节点能否概括所有子节点？',
    '4. 逐节点验证：每个子节点的语义范畴是否严格属于其父节点？',
    '   - 例：如果父节点是"专业技能"，子节点只能放技能名称/水平/证书等',
    '   - 反例：不可在"专业技能"下放"项目周期缩短""平台活跃度维持"等运营类内容',
    '5. 完成自检后再开始输出，思考过程不写入最终结果',
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
    '   - 禁止将操作指标（如"留存""转化率"）放入"技能"类节点',
    '   - 禁止将项目成果（如"周期缩短""成本降低"）放入"技能"类节点',
    '   - 禁止将业务操作（如"交易结算""对账""审批"）放入"技能"类节点',
    '   - 如果某条信息无法归入任何已有父节点的语义范畴，不要强行放入',
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
    '3. 重组的依据是语义关联，而非原文章节顺序',
    '',
    '## 子节点数量管理（重要）',
    '- 任何节点的直接子节点数 ≤ 8 个，保持视觉清爽',
    '- 当某节点下信息 > 8 条时：在父节点与叶子之间插入归纳节点（二级分组）',
    '- 归纳方法：按语义相似度将子节点分为 2-4 组，每组用一个简洁词组命名（4-8 字）',
    '- 示例："专业技能"下有 Python、Java、Spring Boot、React、Vue、Node.js、Docker、K8s、MySQL、Redis 时 → 分为"后端技术"和"前端与运维"两个中间节点',
    '- 禁止为凑整而删除信息——信息多时用"增加层级"而非"减少节点"',
    '',
    '## 好导图的判定标准（输出前自检）',
    '- 一级节点之间互斥不重叠（MECE）',
    '- 同层节点粒度一致（不能左边"模型架构"右边"某个超参的具体值"）',
    '- 父节点能概括所有子节点（父子语义闭包）：每个子节点抽取关键词后，能否直接回答"这属于父节点范畴吗？"',
    '- 叶子节点自含（脱离上下文也能读懂）',
    '- 无空标签节点（禁止只写分类名而无实质内容，如"特点 / 优点 / 其他"）',
    '- 节点语言与原文一致（中文文档输出中文，英文文档输出英文）',
    '- 节点标题唯一：父节点与子节点 content 不能相同或高度相似；同级节点间 content 不可重复',
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
    '## Few-shot',
    '',
    '✅ 正例 1 · 学术论文风（强结构）：',
    '{"content":"模型架构 · Transformer · 编码器-解码器堆叠","children":[',
    '  {"content":"核心：Scaled Dot-Product Attention","children":[]},',
    '  {"content":"多头并行：8 个 attention head","children":[]},',
    '  {"content":"位置编码：正弦函数显式注入","children":[]}',
    ']}',
    '',
    '✅ 正例 2 · 简历/技能风（分类边界清晰）：',
    '{"content":"专业技能 · Python / Java / React","children":[',
    '  {"content":"后端：Spring Boot微服务开发","children":[]},',
    '  {"content":"前端：React + TypeScript组件库","children":[]},',
    '  {"content":"数据：SQL优化与Redis缓存策略","children":[]}',
    ']}',
    '注意：此例中所有子节点都是技能名称/方向，不包含"项目周期""团队规模""营收增长"等非技能类信息',
    '',
    '✅ 正例 3 · 方法论文章风（松结构）：',
    '{"content":"PMF 验证信号 · 用户主动留存 + 自发传播","children":[',
    '  {"content":"留存：D30 留存率 >40%","children":[]},',
    '  {"content":"NPS >50 且自然增长占比 >60%","children":[]},',
    '  {"content":"反信号：主要靠付费投放维持增长","children":[]}',
    ']}',
    '',
    '❌ 反例 1（空标签 + 粒度散 + 信息密度坍塌）：',
    '{"content":"PMF","children":[',
    '  {"content":"信号","children":[{"content":"留存","children":[]}]},',
    '  {"content":"指标","children":[{"content":"NPS","children":[]}]},',
    '  {"content":"判断","children":[{"content":"自然增长","children":[]}]}',
    ']}',
    '反例错在：①"信号/指标/判断"语义重叠违反 MECE ②子节点丢失关键阈值 ③"留存/NPS"单独读不懂违反叶子自含',
    '',
    '❌ 反例 2（分类边界污染 · 不同语义类别的信息混入同一父节点）：',
    '{"content":"专业技能","children":[',
    '  {"content":"Python开发","children":[]},',
    '  {"content":"平台活跃度维持","children":[]},',
    '  {"content":"项目周期缩短30%","children":[]},',
    '  {"content":"送礼策略优化","children":[]},',
    '  {"content":"交易结算","children":[]}',
    ']}',
    '反例错在：①"平台活跃度维持"是运营指标 ②"项目周期缩短"是项目成果 ③"送礼策略优化"是业务手段 ④"交易结算"是业务操作——均不是技能，应分别归入"运营成果""项目成果""业务策略""工作职责"等对应父节点',
    '',
    '❌ 反例 3（子节点过度扁平 · 超过8个直接子节点未分组 · 应按语义分组为中间节点）：',
    '{"content":"专业技能","children":[{"content":"Python","children":[]},{"content":"Java","children":[]},{"content":"Spring Boot","children":[]},{"content":"React","children":[]},{"content":"Vue","children":[]},{"content":"Node.js","children":[]},{"content":"Docker","children":[]},{"content":"Kubernetes","children":[]},{"content":"MySQL","children":[]},{"content":"Redis","children":[]}]}',
    '✅ 正确做法应为：{"content":"专业技能","children":[',
    '  {"content":"后端技术","children":[{"content":"Java · Spring Boot","children":[]},{"content":"Python · 数据处理","children":[]},{"content":"Node.js · 中间层","children":[]}]},',
    '  {"content":"前端技术","children":[{"content":"React · 组件库","children":[]},{"content":"Vue · 管理后台","children":[]}]},',
    '  {"content":"基础设施","children":[{"content":"Docker · K8s","children":[]},{"content":"MySQL · Redis","children":[]}]}',
    ']}',
    '',
    '❌ 反例 4（节点标题重复 · 父子或同级 content 相同）：',
    '{"content":"专业技能","children":[{"content":"专业技能","children":[]},{"content":"Python","children":[]},{"content":"Python","children":[]}]}',
    '✅ 正确：删除与父同名的子节点，合并同级重复 → {"content":"专业技能","children":[{"content":"Python","children":[]}]}',
    '',
    '## 输出格式（JSON）',
    '1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要解释',
    '2. JSON 结构：{"title":"...","root":{"content":"...","children":[...]}}',
    '3. 每个节点只有 content（字符串）和 children（数组）',
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
  // First try: normal extraction
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const validated = llmTreeSchema.safeParse(parsed);
      if (validated.success) {
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
        return { tree: validated.data, parsedJson: repaired };
      }
    } catch {
      // repair failed, fall through
    }
  }

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
  const jsonMaxTokens = parseNonNegativeInt(process.env.LLM_JSON_MAX_TOKENS, 8000);
  const result = await generateText({
    model: languageModel,
    system: ANTI_HALLUCINATION_SYSTEM,
    prompt: buildCompatJsonPrompt(doc),
    maxRetries: requestConfig.maxRetries,
    timeout: requestConfig.timeoutMs,
    abortSignal: options.abortSignal,
    temperature: 0.2,
    maxOutputTokens: jsonMaxTokens,
  });

  const parsedTree = parseLLMTreeFromText(result.text);
  if (!parsedTree) {
    throw new Error('兼容模式无法解析智谱返回的导图 JSON');
  }

  return llmTreeToMindMapTree(parsedTree, doc);
}

function normalizeSummaryPoint(text: string): string {
  return text
    .replace(/^\s*[-*•\d.)\s]+/, '')
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

function buildHeuristicSummaryPoints(tree: MindMapTree): string[] {
  const rootTopic = normalizeSummaryPoint(tree.root.content) || '当前主题';
  const topBranches = (tree.root.children || [])
    .map((node) => ({
      title: normalizeSummaryPoint(node.content),
      details: (node.children || [])
        .map((child) => normalizeSummaryPoint(child.content))
        .filter(Boolean)
        .slice(0, 2),
    }))
    .filter((item) => item.title)
    .slice(0, 6);

  if (topBranches.length === 0) {
    return [
      `当前导图围绕「${rootTopic}」展开，建议补充 2-3 个关键分支以形成完整结构。`,
      '可先增加「核心观点」「支撑依据」「行动建议」三个方向，便于后续追问与扩展。',
      '节点内容越具体，摘要越稳定，建议在分支下补充事实、数据或案例描述。',
    ];
  }

  const summaryPoints = topBranches.map((branch) => {
    if (branch.details.length === 0) {
      return `${branch.title} 是当前导图的重要分支，可继续补充细节节点以完善论证。`;
    }
    return `${branch.title}：${branch.details.join('、')}。`;
  });

  if (summaryPoints.length < 3) {
    summaryPoints.push(`整体主题聚焦在「${rootTopic}」，当前结构可支撑快速回顾与二次编辑。`);
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

function buildSummaryPromptFromTree(tree: MindMapTree): string {
  const title = tree.meta.title || normalizeSummaryPoint(tree.root.content) || '未命名导图';
  const outline = collectOutlineLines(tree, 42).join('\n');

  return [
    '你是信息提炼助手。请基于导图结构输出简洁中文摘要。',
    '输出要求：',
    '1. 输出 JSON：{"points":["..."]}，不要输出其它字段。',
    '2. points 数量 3-8 条，每条 18-60 字。',
    '3. 只基于给定导图内容，不要编造外部事实。',
    '4. 重点提炼：核心主题、关键分支、行动/风险提示。',
    '',
    `导图标题：${title}`,
    '导图结构：',
    outline,
  ].join('\n');
}

function buildMarkdownPreviewPrompt(doc: NormalizedDocument): string {
  return [
    '你是资深文档分析助手。请基于输入内容，输出一份中文 Markdown 解析稿。',
    '要求：',
    '1. 仅基于输入内容，不要编造事实。',
    '2. 直接输出 Markdown 文本，不要输出 JSON，不要代码块包裹。',
    '3. 结构必须包含：',
    '   - 一级标题（文档主题）',
    '   - 二级标题：文档摘要',
    '   - 至少 2 个二级标题模块，每个模块含 bullet 列表',
    '   - 二级标题：关键结论（bullet 列表）',
    '4. 每条 bullet 尽量 8~30 字。',
    '5. 输出语言：简体中文。',
    '',
    '质量控制：',
    '- 确保每个节点内容完整且有意义',
    '- 避免重复内容',
    '- 保持层级逻辑清晰',
    '- 重要信息优先级更高',
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
    system: ANTI_HALLUCINATION_SYSTEM,
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

export async function generateAiSummary(
  tree: MindMapTree,
  options: {
    abortSignal?: AbortSignal;
  } = {},
): Promise<AiSummaryResult> {
  const llmConfig = resolveLLMConfig();
  const fallbackPoints = buildHeuristicSummaryPoints(tree);
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
    system: ANTI_HALLUCINATION_SYSTEM,
    prompt: buildSummaryPromptFromTree(tree),
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
  const jsonMaxTokens = parseNonNegativeInt(process.env.LLM_JSON_MAX_TOKENS, 8000);
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
      ? '（JSON 似乎被截断，可能是输出过长。可尝试在 .env 中设置 LLM_JSON_MAX_TOKENS=8000 后重试）'
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

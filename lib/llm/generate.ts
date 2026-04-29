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
      result.push(trimmed);
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

    // Always keep headings
    if (/^#{1,6}\s+/.test(trimmed)) {
      result.push(trimmed);
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
  const branchKeywords = branchLabel.match(/[\u3400-\u9fff]{2,6}|[A-Za-z]{3,}/g) || [];
  if (branchKeywords.length === 0) return 0;
  let score = 0;
  for (const keyword of branchKeywords) {
    if (sentence.includes(keyword)) score += 1;
  }
  return score;
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

  const nextRootChildren = topChildren.map((child) => {
    if ((child.children?.length || 0) > 0) return child;
    if (!isCategoryLikeLabel(child.content)) return child;

    const ranked = pool
      .map((item) => ({
        ...item,
        score: scoreSentenceForBranch(child.content, item.sentence),
      }))
      .sort((a, b) => b.score - a.score);

    const selected = ranked.filter((item) => item.score > 0 && !usedSentences.has(item.sentence)).slice(0, 2);
    if (selected.length === 0) {
      const fallback = ranked.find((item) => !usedSentences.has(item.sentence));
      if (fallback) selected.push(fallback);
    }
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
  return ensureFirstLayerDetails(sanitized, doc);
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
      if (title.length >= 2 && title.length <= 80 && !isGarbledText(title)) {
        return title;
      }
    }
  }
  
  for (const line of lines.slice(0, 15)) {
    if (/^#{2,6}\s+/.test(line)) {
      const title = line.replace(/^#{2,6}\s+/, '').trim();
      if (title.length >= 2 && title.length <= 80 && !isGarbledText(title)) {
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

function titleFromChunk(text: string, index: number): string {
  const heading = text
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => /^#{2,6}\s+/.test(line));

  if (heading) {
    const title = heading.replace(/^#{2,6}\s+/, '').trim();
    if (title.length >= 2 && !isGarbledText(title)) {
      return title.slice(0, 80);
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
  return ensureFirstLayerDetails(sanitized, doc);
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
    return ensureFirstLayerDetails(sanitized, doc);
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
  return ensureFirstLayerDetails(sanitized, doc);
}

const ANTI_HALLUCINATION_SYSTEM = [
  '你是一个严格的知识提取工具，不是创作助手。',
  '你的唯一工作是从用户提供的文档中提取信息并组织为结构化输出。',
  '绝对禁止编造、推测、补充、合理化任何文档中未明确出现的信息。',
  '遇到模糊或无法识别的内容，直接忽略，不要猜测。',
  '文档中没有的分类维度，不要创建节点。',
].join('\n');

function buildPrompt(doc: NormalizedDocument): string {
  const cleanedMarkdown = cleanMarkdownForLLM(doc.markdown).slice(0, 12000);
  return [
    '从下方文档原文中提取信息，组织为思维导图结构。',
    '',
    '## 绝对规则（违反任何一条即视为失败）',
    '1. 只输出文档中明确出现的信息。文档没写的，一个字也不许加',
    '2. 文档中模糊、乱码、无法识别的内容，直接忽略，不要猜测其含义',
    '3. 文档中不存在的分类/维度，不要创建对应节点',
    '4. 不许编造数据、案例、人名、公司名、技能、经历等任何原文未提及的细节',
    '',
    '## 核心原则',
    '- **忠实原文**：所有节点内容必须源自文档原文，可概括和重组，但绝不可添加原文没有的信息',
    '- **按需提取**：只创建文档中确实有内容的分类，2-8 个一级节点均可，没有内容的维度不创建',
    '- **语义聚合**：关联紧密的信息合并为一个节点（如"公司名 | 职位 | 时间段"合为一个节点）',
    '- **自然层级**：根据内容复杂度自适应深度——简单信息扁平，复杂信息展开',
    '',
    '## 约束条件',
    `- 最大层级：${MAX_TREE_DEPTH}`,
    `- 最大节点数：${MAX_TREE_NODES}`,
    '- 节点文本控制在 35 字以内',
    '- 一级节点数量由文档实际内容决定（2-8 个均可），不凑数',
    '',
    '## 节点组织原则',
    '1. 关联紧密的信息合并为一个节点，其 children 是具体细节',
    '2. 某类别下有多个独立子项时，每个子项作为独立节点',
    '3. 禁止空标签节点（仅写分类名称而无实质内容）',
    '4. 同一维度的信息归入同一父节点',
    '',
    '## 输出要求',
    '1. 基于文档核心内容重组结构，而非复述原文顺序',
    '2. 专业名词、人名、公司名、数据等原样保留',
    '3. 如果某个维度文档中没有相关信息，就不创建该节点',
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
    '从下方文档原文中提取信息，组织为思维导图 JSON。',
    '',
    '## 绝对规则（违反任何一条即视为失败）',
    '1. 只输出文档中明确出现的信息。文档没写的，一个字也不许加',
    '2. 文档中模糊、乱码、无法识别的内容，直接忽略，不要猜测其含义',
    '3. 文档中不存在的分类/维度，不要创建对应节点',
    '4. 不许编造数据、案例、人名、公司名、技能、经历等任何原文未提及的细节',
    '',
    '## 核心原则',
    '- 忠实原文：所有节点内容必须源自文档原文，可概括重组但绝不可添加原文没有的信息',
    '- 按需提取：只创建文档中确实有内容的分类，2-8 个一级节点均可，没有内容的维度不创建',
    '- 语义聚合：关联紧密的信息合并到同一节点下',
    '- 逻辑清晰：层级关系明确，形成完整知识脉络',
    '',
    '## 输出规则',
    '1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要解释',
    '2. JSON 结构：{"title":"...","root":{"content":"...","children":[...]}}',
    '3. 每个节点只有 content（字符串）和 children（数组）',
    '4. 一级主题数量由文档实际内容决定（2-8 个），不凑数',
    '5. 专业名词、人名、数据必须原样保留',
    '6. 如果某个维度文档中没有相关信息，就不创建该节点',
    '7. 禁止空标签节点（仅写分类名称而无实质内容）',
    '',
    `文档标题：${doc.sourceMeta.title || '自动生成思维导图'}`,
    '',
    '输入内容：',
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

  if (!llmConfig.supported || !hasApiKey) {
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

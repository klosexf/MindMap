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

type OpenAICompatibleProvider = 'openai' | 'zhipu' | 'kimi' | 'minimax' | 'qwen';

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
  if (token.length > 24) return true;
  if (/[A-Za-z]/.test(token) && /\d/.test(token) && token.length >= 8) return true;
  if (/[_@]/.test(token) && token.length >= 6) return true;
  if (/([A-Za-z])\1{4,}/.test(token)) return true;

  const upper = token.toUpperCase();
  const allUpperAscii = /^[A-Z]{4,}$/.test(token);
  if (allUpperAscii && !ASCII_TOKEN_ALLOWLIST.has(upper)) return true;

  if (!hasCjkContext) return false;

  if (/^[A-Za-z]{2,}$/.test(token)) {
    const upperChars = (token.match(/[A-Z]/g) || []).length;
    const lowerChars = (token.match(/[a-z]/g) || []).length;
    const upperRatio = upperChars / token.length;
    if (upperRatio >= 0.6 && !ASCII_TOKEN_ALLOWLIST.has(upper)) {
      return true;
    }
    const vowelCount = (token.match(/[aeiou]/gi) || []).length;
    const vowelRatio = vowelCount / token.length;
    if (vowelRatio < 0.15 && token.length >= 5) {
      return true;
    }
    const consonantClusters = token.match(/[bcdfghjklmnpqrstvwxyz]{4,}/gi) || [];
    if (consonantClusters.length > 0) {
      return true;
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

function shouldKeepAsciiTokenInCjkContext(token: string): boolean {
  const upper = token.toUpperCase();
  if (ASCII_TOKEN_ALLOWLIST.has(upper)) return true;
  if (isNumericToken(token)) return true;

  const hasLowercase = /[a-z]/.test(token);
  const hasVowel = /[aeiou]/i.test(token);
  return hasLowercase && hasVowel;
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
      if (vowelRatio < 0.1 && token.length >= 4) {
        garbledCount++;
        continue;
      }
      const consonantClusters = token.match(/[bcdfghjklmnpqrstvwxyz]{5,}/gi) || [];
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
    if (CJK_CHAR_RE.test(token)) return true;
    if (isLikelyNoiseToken(token, hasCjkContext)) return false;
    if (!hasCjkContext) return true;
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
  return mindMapTreeSchema.parse(clamped);
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

    return clampTree(tree, MAX_TREE_DEPTH, MAX_TREE_NODES);
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

  return clampTree(tree, MAX_TREE_DEPTH, MAX_TREE_NODES);
}

function buildPrompt(doc: NormalizedDocument): string {
  return [
    '你是资深知识整理专家，请对文档内容进行优化总结，生成思维导图。',
    '',
    '## 核心原则',
    '- **智能重组**：不拘泥于原文结构，基于核心内容重新组织，采用最清晰的方式呈现',
    '- **节点精炼**：避免节点过多和冗余，每个节点都应有独立价值',
    '- **逻辑清晰**：确保父子节点关系明确，层级递进合理',
    '- **信息完整**：在精简结构的同时，保留所有关键信息',
    '',
    '## 约束条件',
    `- 最大层级：${MAX_TREE_DEPTH}`,
    `- 最大节点数：${MAX_TREE_NODES}`,
    '- 每个节点文本简洁，控制在 20 字以内',
    '- 第一层节点数量控制在 3-6 个',
    '',
    '## 输出要求',
    '1. **智能重组**：基于文档核心内容重新组织结构，不必完全遵循原文章节顺序',
    '2. **内容精炼**：合并相似内容，去除冗余信息，确保每个节点都有独特价值',
    '3. **术语保留**：专业名词、人名、公司名、数据等关键信息必须原样保留',
    '4. **层级优化**：根节点为文档标题，第一层为核心主题，第二层为具体内容总结',
    '5. **避免重复**：同一信息只在一个节点出现，避免层级间的信息重复',
    '6. **内容详实**：第二层节点必须包含具体的内容总结，呈现核心信息和关键细节',
    '7. **可读性强**：优先考虑思维导图的可读性和实用性，而非完全复现原文结构',
    '',
    '## 质量控制',
    '- 确保每个节点内容完整且有意义',
    '- 重要信息优先展示在更高层级',
    '- 合并可以合并的内容，减少不必要的层级',
    '- 保持层级逻辑清晰，父子节点关系明确',
    '',
    `## 文档标题：${doc.sourceMeta.title || '自动生成思维导图'}`,
    '',
    '## 输入内容',
    doc.markdown.slice(0, 12000),
  ].join('\n');
}

function buildCompatJsonPrompt(doc: NormalizedDocument): string {
  return [
    '你是资深知识整理专家，请对文档内容进行优化总结，生成思维导图 JSON。',
    '',
    '## 核心原则',
    '- 智能重组：基于核心内容重新组织，不必完全遵循原文结构',
    '- 节点精炼：避免冗余，合并相似内容',
    '- 逻辑清晰：确保层级关系明确',
    '',
    '## 输出规则',
    '1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要解释',
    '2. JSON 结构：{"title":"...","root":{"content":"...","children":[...]}}',
    '3. 每个节点只有 content（字符串）和 children（数组）',
    '4. 第一层主题 3~6 个，基于核心内容重新组织，不必完全遵循原文结构',
    '5. 专业名词、人名、数据必须原样保留',
    '6. 合并相似内容，去除冗余信息',
    '7. 【重要】每个一级节点（root.children 中的节点）必须有 children 数组，包含 2~5 个具体内容节点',
    '8. 【重要】一级节点不能只有 content，必须展开为具体的子节点',
    '9. 优先考虑可读性和实用性，而非完全复现原文结构',
    '',
    '## 示例结构',
    '正确示例：',
    '{"title":"简历","root":{"content":"候选人概况","children":[{"content":"基本信息","children":[{"content":"姓名：张三"},{"content":"电话：138xxxx"}]}]}}',
    '',
    '错误示例（一级节点没有 children）：',
    '{"title":"简历","root":{"content":"候选人概况","children":[{"content":"基本信息"}]}}  // ❌ 缺少 children',
    '',
    `文档标题：${doc.sourceMeta.title || '自动生成思维导图'}`,
    '',
    '输入内容：',
    doc.markdown.slice(0, 12000),
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

function parseLLMTreeFromTextWithMeta(text: string): { tree: LLMMindMapTree; parsedJson: string } | null {
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
  const result = await generateText({
    model: languageModel,
    prompt: buildCompatJsonPrompt(doc),
    maxRetries: requestConfig.maxRetries,
    timeout: requestConfig.timeoutMs,
    abortSignal: options.abortSignal,
    temperature: 0.2,
    maxOutputTokens: 4000,
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
    doc.markdown.slice(0, 14000),
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

  const requestConfig = resolveLLMRequestConfig(llmConfig.resolvedProvider);
  const jsonTimeoutSeconds = parseNonNegativeInt(process.env.LLM_JSON_TIMEOUT, 90);
  const jsonTimeoutMs = jsonTimeoutSeconds > 0 ? jsonTimeoutSeconds * 1000 : undefined;
  const jsonMaxRetries = parseNonNegativeInt(process.env.LLM_JSON_MAX_RETRIES, requestConfig.maxRetries);
  const modelProvider = createProviderClient(llmConfig);

  const languageModel =
    llmConfig.resolvedProvider === 'openai'
      ? modelProvider(llmConfig.model)
      : modelProvider.chat(llmConfig.model as any);

  const result = await generateText({
    model: languageModel,
    prompt: buildCompatJsonPrompt(doc),
    maxRetries: jsonMaxRetries,
    timeout: jsonTimeoutMs ?? requestConfig.timeoutMs,
    abortSignal: options.abortSignal,
    temperature: 0.2,
    maxOutputTokens: 2200,
  });

  const parsed = parseLLMTreeFromTextWithMeta(result.text);
  if (!parsed) {
    throw new Error('LLM 返回内容不是有效思维导图 JSON');
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

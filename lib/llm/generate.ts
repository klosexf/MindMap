import { existsSync, readFileSync } from 'node:fs';

import { nanoid } from 'nanoid';
import { generateText, streamObject, streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { Agent } from 'undici';

import {
  ensureEnumerationRetention,
  repairCompositeOrdinalBranches,
  repairNumericUnitsTree,
} from '@/lib/llm/postprocess';

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
  clampTree,
  countNodes,
  createSourceRefFallback,
  dedupeSiblingSubtrees,
  getDefaultMindMapTree,
  progressiveTreePatches,
  repairUnclosedDateBracket,
  rootOnlyTree,
  sanitizeTreeContent,
  stripTrailingDanglingPunctuation,
  traverseTree,
} from '@/lib/utils/tree';
import {
  isWeChatArticleUrl,
  generateWeChatMindMapViaZhipuWebSearch,
  generateWeChatMindMapViaHunyuan,
} from '@/lib/wechat/client';
import {
  PAGE_LABEL_RE,
  cleanMarkdownForLLM,
  cleanMarkdownText,
  isGarbledText,
  isLikelyNoisyMixedText,
  isReadableSentence,
  sanitizeSentence,
} from '@/lib/llm/text-clean';
import {
  ANTI_HALLUCINATION_SYSTEM,
  BRANCH_EXPANSION_SYSTEM,
  DOCUMENT_SUMMARY_SYSTEM,
  MARKDOWN_SUMMARY_SYSTEM,
  NODE_ACTION_SYSTEM,
  TREE_OPTIMIZE_SYSTEM,
  buildBranchExpansionPrompt,
  buildCompatJsonPrompt,
  buildMarkdownPreviewPrompt,
  buildNodeActionPrompt,
  buildPrompt,
  buildTreeOptimizePrompt,
  resolveModelProfile,
  type BranchExpansionInput,
  type NodeActionInput,
  type TreeOptimizeMode,
  type TreeOptimizationInput,
} from '@/lib/llm/prompts';

// Prompt 资产的公共出口（测试与路由经 generate.ts 统一引用）
export { buildPrompt, buildCompatJsonPrompt, buildMarkdownPreviewPrompt };
export type { BranchExpansionInput, TreeOptimizeMode, TreeOptimizationInput };

export type GenerateStreamEvent =
  | { type: 'skeleton'; data: { tree: MindMapTree } }
  | { type: 'node'; data: { patch: TreePatch; node: MindMapNode } }
  | { type: 'complete'; data: { tree: MindMapTree } }
  | { type: 'error'; data: { message: string } };

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
    defaultModel: 'hy3-preview',
    defaultBaseUrl: 'https://tokenhub.tencentmaas.com/v1',
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

/**
 * 生成降级时给用户的失败原因摘要（供 error 事件文案使用）。
 * 不直接透出原始 error.message——像「The operation was aborted due to
 * timeout」这类英文技术报错对普通用户观感很差；按常见失败类别归一为
 * 简短中文描述，未识别的类别给通用文案。
 */
export function describeGenerationFailure(error: Error): string {
  const message = error.message || '';
  if (/timeout|timed out|aborted|abort/i.test(message)) return 'AI 响应超时，';
  if (/network|fetch|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(message)) return '网络连接异常，';
  if (/401|403|unauthorized|api key|invalid.*key/i.test(message)) return 'AI 服务鉴权失败，';
  if (/429|rate limit/i.test(message)) return 'AI 服务繁忙，';
  return 'AI 生成出现异常，';
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

function sanitizeTreeNodeForOutput(node: MindMapNode): MindMapNode[] {
  const sanitizedChildren = (node.children || []).flatMap((child) => sanitizeTreeNodeForOutput(child));
  const content = sanitizeSentence(node.content) || node.content.trim();
  // 机械清理（代码层兜底）：悬垂标点剥离 → 日期区间括号闭合（LLM 常见截断残留）
  const trimmed = repairUnclosedDateBracket(stripTrailingDanglingPunctuation(content.slice(0, 120).trim()));

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
    // 同父重复子树去重（保留首个）：修复 LLM 重复生成同一分支的问题
    root: dedupeSiblingSubtrees(root),
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

function normalizeExpansionSentenceKey(text: string): string {
  return sanitizeSentence(text)
    .replace(/\s+/g, '')
    .replace(/[，。！？!?,；;：:“”"'‘’、·\-\|\/\\()（）[\]【】{}]/g, '')
    .toLowerCase();
}

const GENERIC_CONTAINER_LABEL_RE = /^(明细|详情|细节|附录|补充|其他|说明|正文|内容|概要|要点|备注)/;

function isGenericContainerLabel(text: string): boolean {
  return GENERIC_CONTAINER_LABEL_RE.test(text.trim());
}

/**
 * 将容器型分支（如「明细」「详情」）下「标签：值」形式的子节点，
 * 迁移到与标签匹配的一级类别叶节点下，避免类别节点空心化。
 */
function redistributeContainerDetails(topChildren: MindMapNode[]): MindMapNode[] {
  const targets = topChildren.filter(
    (child) => (child.children || []).length === 0 && isCategoryLikeLabel(child.content),
  );
  if (targets.length === 0) return topChildren;

  const movedByTargetId = new Map<string, MindMapNode[]>();

  const nextChildren = topChildren.flatMap((branch): MindMapNode[] => {
    const grandChildren = branch.children || [];
    if (grandChildren.length === 0 || !isGenericContainerLabel(branch.content)) return [branch];

    const kept: MindMapNode[] = [];
    for (const child of grandChildren) {
      const childKey = normalizeExpansionSentenceKey(child.content);
      const target = childKey
        ? targets.find((item) => {
            const labelKey = normalizeExpansionSentenceKey(item.content);
            return Boolean(labelKey) && childKey !== labelKey && childKey.startsWith(labelKey);
          })
        : undefined;

      if (target) {
        const bucket = movedByTargetId.get(target.id) ?? [];
        bucket.push(child);
        movedByTargetId.set(target.id, bucket);
      } else {
        kept.push(child);
      }
    }

    if (kept.length === grandChildren.length) return [branch];
    if (kept.length === 0) return [];
    return [{ ...branch, children: kept }];
  });

  if (movedByTargetId.size === 0) return topChildren;

  return nextChildren.map((branch) => {
    const moved = movedByTargetId.get(branch.id);
    if (!moved || moved.length === 0) return branch;
    return { ...branch, children: [...(branch.children || []), ...moved] };
  });
}

function ensureFirstLayerDetails(tree: MindMapTree, doc: NormalizedDocument): MindMapTree {
  const initialChildren = redistributeContainerDetails(tree.root.children || []);
  if (initialChildren.length === 0) return tree;

  const treeWithRedistribution: MindMapTree = {
    ...tree,
    root: {
      ...tree.root,
      children: initialChildren,
    },
  };

  const topChildren = treeWithRedistribution.root.children || [];
  if (topChildren.length === 0) return tree;

  const pool = collectChunkSentences(doc);
  if (pool.length === 0) return tree;
  const MIN_SCORE_THRESHOLD = 2;
  const MAX_DETAILS_PER_BRANCH = 3;
  const usedSentenceKeys = new Set<string>();
  const assignedDetails = new Map<string, MindMapNode[]>();
  const expansionTargets: Array<{ id: string; content: string; depth: number }> = [];

  traverseTree(tree.root, (node) => {
    const normalized = normalizeExpansionSentenceKey(node.content);
    if (normalized) {
      usedSentenceKeys.add(normalized);
    }
  });

  function collectTargets(node: MindMapNode, depth: number): void {
    const children = node.children || [];
    children.forEach((child) => collectTargets(child, depth + 1));

    if (depth >= 1 && depth <= 2 && children.length === 0) {
      expansionTargets.push({ id: node.id, content: node.content, depth });
    }
  }

  topChildren.forEach((child) => collectTargets(child, 1));
  expansionTargets.sort((a, b) => {
    if (b.depth !== a.depth) return b.depth - a.depth;
    return b.content.length - a.content.length;
  });

  for (const target of expansionTargets) {
    const minimumScore = isCategoryLikeLabel(target.content) ? MIN_SCORE_THRESHOLD : 3;
    const ranked = pool
      .map((item) => ({
        ...item,
        score: scoreSentenceForBranch(target.content, item.sentence),
      }))
      .filter((item) => item.score >= minimumScore)
      .sort((a, b) => b.score - a.score);

    const selected = ranked
      .filter((item) => {
        if (item.sentence === target.content.trim()) return false;

        const sentenceKey = normalizeExpansionSentenceKey(item.sentence);
        if (!sentenceKey) return false;
        if (usedSentenceKeys.has(sentenceKey)) return false;

        return true;
      })
      .slice(0, MAX_DETAILS_PER_BRANCH);

    if (selected.length === 0) {
      continue;
    }

    selected.forEach((item) => {
      const sentenceKey = normalizeExpansionSentenceKey(item.sentence);
      if (sentenceKey) {
        usedSentenceKeys.add(sentenceKey);
      }
    });

    assignedDetails.set(
      target.id,
      selected.map((item) => createHeuristicNode(item.sentence, item.sourceRef, 'detail', 0.6)),
    );
  }

  function applyExpansion(node: MindMapNode): MindMapNode {
    const expandedChildren = (node.children || []).map((child) => applyExpansion(child));
    const assignedChildren = expandedChildren.length === 0 ? assignedDetails.get(node.id) : undefined;

    return {
      ...node,
      children: assignedChildren ?? expandedChildren,
    };
  }

  return {
    ...tree,
    root: {
      ...tree.root,
      children: topChildren.map((child) => applyExpansion(child)),
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

export function splitOversizedNodeContent(tree: MindMapTree): MindMapTree {
  function splitText(text: string): string[] {
    if (text.length <= MAX_CONTENT_LENGTH) return [text];

    // 保护日期/版本号中的数字间句点（如 2021.06、v1.2.3），
    // 避免被当作句末边界拆碎（历史 badcase：（2021 / 06-2022 / 07））
    const DOT_SENTINEL = '\u0000\u0001\u0000';
    const guarded = text.replace(/(?<=\d)\.(?=\d)/g, DOT_SENTINEL);
    const restore = (s: string) => s.split(DOT_SENTINEL).join('.');

    const sentenceParts = guarded.split(/(?<=[。！？.!?])/);
    if (sentenceParts.length >= 2 && sentenceParts[0].trim().length >= 4) {
      return sentenceParts.map((p) => restore(p.trim())).filter(Boolean);
    }

    const commaParts = guarded.split(/(?<=[，,；;：:])/);
    if (commaParts.length >= 2 && commaParts[0].trim().length >= 4) {
      return commaParts.map((p) => restore(p.trim())).filter(Boolean);
    }

    return [text];
  }

  function splitNode(node: MindMapNode, depth: number): MindMapNode {
    const existingChildren = (node.children || []).map((c) => splitNode(c, depth + 1));

    if (node.content.length <= MAX_CONTENT_LENGTH) {
      return { ...node, children: existingChildren };
    }

    const parts = splitText(node.content);
    // 深度不足（拆分会超出 clampTree 允许的层级上限）或文本无分隔点时，退化为截断兜底：
    // 叶层超长内容（如 OCR 原文段落）不允许原样保留
    if (parts.length <= 1 || depth >= MAX_TREE_DEPTH) {
      return {
        ...node,
        content: node.content.slice(0, MAX_CONTENT_LENGTH - 1) + '…',
        children: existingChildren,
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

/**
 * 泛化标签模式：以分类性名词结尾且整体较短，无法独立传达实质信息。
 * 仅匹配「XX的特征」「XX条件」类标签式标题；刻意排除 价值/意义/原因/目标/策略/挑战
 * 等可能出现在实质内容里的词，避免误删。
 */
const LEAF_LABEL_PATTERN = /(特征|条件|维度|因素|属性|要素|概述|背景|简介|介绍|现状|其他|相关|补充|附录|说明)$/;

/**
 * 清理二级层的"空标签叶子"节点：无子节点且标题为泛化标签（如"回报这些能力的岗位特征"），
 * 悬挂在分支下只会产生信息空洞。仅作用于二级层（depth 2），不动一级分支与深层叶子。
 */
export function removeLeafLabelNodes(tree: MindMapTree): MindMapTree {
  function processNode(node: MindMapNode, depth: number): MindMapNode {
    if (!node.children || node.children.length === 0) {
      return node;
    }
    const processedChildren = node.children
      .map((child) => processNode(child, depth + 1))
      .filter((child) => {
        if (depth + 1 !== 2) return true;
        if (child.children?.length) return true;
        const trimmed = child.content.trim();
        return !(trimmed.length <= 20 && LEAF_LABEL_PATTERN.test(trimmed));
      });
    return { ...node, children: processedChildren };
  }
  return { ...tree, root: processNode(tree.root, 0) };
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

function isGenericDocumentTitle(title: string): boolean {
  return /(PRD|技术方案|需求文档|规范文档|设计规范|设计系统|说明文档|文档)$/i.test(title.trim());
}

function shouldPreferDocumentTitleForRoot(title?: string): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (PAGE_LABEL_RE.test(trimmed)) return false;
  if (isFileOrDownloadTitle(trimmed)) return false;

  const sanitized = sanitizeSentence(trimmed) || trimmed;
  if (!sanitized.trim()) return false;
  if (isFileOrDownloadTitle(sanitized)) return false;

  return true;
}

export function preferDocumentTitleForRoot(tree: MindMapTree, documentTitle?: string): MindMapTree {
  if (!shouldPreferDocumentTitleForRoot(documentTitle)) return tree;

  const preferredRoot = (sanitizeSentence(documentTitle!) || documentTitle!.trim()).slice(0, 120).trim();
  if (!preferredRoot) return tree;
  const currentRoot = (sanitizeSentence(tree.root.content) || tree.root.content).trim();
  const titleLooksGeneric = isGenericDocumentTitle(preferredRoot);
  const currentRootLooksWeak =
    !currentRoot ||
    isWeakRootTitle(currentRoot) ||
    isFileOrDownloadTitle(currentRoot) ||
    currentRoot.length < 6;

  const shouldReplaceRoot =
    currentRootLooksWeak ||
    (!titleLooksGeneric && currentRoot.length <= 10 && preferredRoot.length >= currentRoot.length + 4);

  if (!shouldReplaceRoot && tree.meta.title === preferredRoot) {
    return tree;
  }

  return {
    ...tree,
    root: shouldReplaceRoot
      ? {
          ...tree.root,
          content: preferredRoot,
        }
      : tree.root,
    meta: {
      ...tree.meta,
      title: preferredRoot,
    },
  };
}

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

  // 流式 partial 节点同样做机械清理，保证逐节点流入的预览与终树一致
  const cleanedContent = repairUnclosedDateBracket(
    stripTrailingDanglingPunctuation(node.content.trim()),
  );
  if (!cleanedContent) return null;

  const normalized: { content: string; children?: any[] } = { content: cleanedContent };
  if (Array.isArray(node.children)) {
    normalized.children = node.children
      .map((child) => sanitizePartialNode(child))
      .filter((item): item is { content: string; children?: any[] } => Boolean(item));
  }

  return normalized;
}

function llmTreeToMindMapTree(llmTree: LLMMindMapTree, doc: NormalizedDocument, baseTreeId?: string): MindMapTree {
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
  const titleAligned = preferDocumentTitleForRoot(sanitized, doc.sourceMeta.title);
  const result = ensureFirstLayerDetails(titleAligned, doc);
  const validated = validateSemanticHierarchy(result);
  const restructured = restructureOversizedBranches(validated);
  const deduped = deduplicateNodeTitles(restructured);
  const filtered = detectAndFilterLowQualityTitles(deduped);
  const expanded = ensureFirstLayerDetails(filtered, doc);
  const split = splitOversizedNodeContent(expanded);
  const finalTree = removeLeafLabelNodes(split);
  // 机械清理收尾：截断兜底/超长再拆分可能在 sanitize 之后重新产生
  // 悬垂标点与未闭合日期括号，必须在管线末端再清理一次
  const cleanedTree = sanitizeTreeContent(finalTree);
  // 复合标签守卫：「策略一 / 策略二」式合并节点展平并聚合为主题父分支
  const compositesRepaired = repairCompositeOrdinalBranches(cleanedTree);
  // 原文回溯型修复：数字单位守卫（%缺失）+ 枚举清单回补（技能/工具等）
  const unitRepaired = repairNumericUnitsTree(compositesRepaired, doc.markdown);
  const enumBackfilled = ensureEnumerationRetention(unitRepaired, doc, sourceRef);
  // 会话级 tree.id：同一流式生成内 skeleton 与 complete 树共享 id，
  // 保证客户端 URL 与存储记录不错位
  return baseTreeId ? { ...enumBackfilled, id: baseTreeId } : enumBackfilled;
}

/**
 * 将终树根节点 id 替换为骨架根 id。
 * 实时生成的首个 skeleton 只含根节点（rootOnlyTree），后续 node 事件的
 * add patch 以终树根为 parent——id 不一致时客户端 applyTreePatch 找不到
 * 父节点会静默丢弃，故终树必须先 rebase 到骨架根上。
 */
function rebaseTreeRoot(tree: MindMapTree, rootId: string): MindMapTree {
  if (tree.root.id === rootId) return tree;
  return { ...tree, root: { ...tree.root, id: rootId } };
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

export function buildHeuristicMindMapTree(doc: NormalizedDocument, baseTreeId?: string): MindMapTree {
  const sourceRef = makeDefaultSourceRef(doc);
  const metaTitle = doc.sourceMeta.title && !isFileOrDownloadTitle(doc.sourceMeta.title) ? doc.sourceMeta.title : undefined;
  let title = extractSmartTitle(doc.markdown, doc.sourceMeta.sourceFileName) || metaTitle || '思维导图';

  if (doc.chunks.length > 1) {
    const root = createHeuristicNode(title, sourceRef, 'main', 0.7);

    root.children = doc.chunks.slice(0, 24).map((chunk, index) => {
      const chunkSourceRef = chunk.sourceRef || sourceRef;
      const branch = createHeuristicNode(titleFromChunk(chunk.text, index), chunkSourceRef, 'detail', 0.68);
      branch.children = extractSentences(chunk.text, 4)
        .filter((sentence) => normalizeExpansionSentenceKey(sentence) !== normalizeExpansionSentenceKey(branch.content))
        .map((sentence) => createHeuristicNode(sentence, chunkSourceRef, 'detail', 0.62));
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
    const heuristicTree = mindMapTreeSchema.parse(splitOversizedNodeContent(expanded));
    return baseTreeId ? { ...heuristicTree, id: baseTreeId } : heuristicTree;
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
  const heuristicTree = mindMapTreeSchema.parse(splitOversizedNodeContent(expanded));
  // 会话级 tree.id：与 llmTreeToMindMapTree 保持一致的复用语义
  return baseTreeId ? { ...heuristicTree, id: baseTreeId } : heuristicTree;
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
  options: { abortSignal?: AbortSignal; baseTreeId?: string },
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
    const finishReason = (result as { finishReason?: unknown }).finishReason;
    const providerLabel = `${llmConfig.resolvedProvider || llmConfig.provider}/${llmConfig.model}`;
    if (!result.text.trim() && finishReason === 'length') {
      throw new Error(
        `兼容模式输出为空：${providerLabel} 在 maxOutputTokens=${jsonMaxTokens} 内耗尽 token（疑似推理模型把额度用于 reasoning 未产出正文，或长文超出上限）。请更换非推理模型或调高 LLM_JSON_MAX_TOKENS`,
      );
    }
    throw new Error(
      `兼容模式无法解析导图 JSON（provider=${providerLabel} textLength=${result.text.length} finishReason=${String(finishReason)}）`,
    );
  }

  const treeStartedAt = Date.now();
  const parsedTree = parsedTreeWithMeta.tree;
  const finalTree = llmTreeToMindMapTree(parsedTree, doc, options.baseTreeId);
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
  const lines = collectDocumentSummaryLines(doc, 5);

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
  return summaryPoints.slice(0, 5);
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
      return parsed.map((item) => normalizeSummaryPoint(String(item))).filter(Boolean).slice(0, 5);
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { points?: unknown[] }).points)) {
      return (parsed as { points: unknown[] }).points
        .map((item) => normalizeSummaryPoint(String(item)))
        .filter(Boolean)
        .slice(0, 5);
    }
  } catch {
    // Fallback to bullet parsing.
  }

  const bulletPoints = cleanedText
    .split('\n')
    .map((line) => normalizeSummaryPoint(line))
    .filter(Boolean)
    .slice(0, 5);

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
    '2. points 数量 3-5 条；若原文信息有限，可少于 3 条。',
    '3. 只基于给定原文片段，不要编造外部事实，不要补充推断。',
    '4. 重点提炼：核心主题、关键事实、明确结论；仅当原文明示时才写风险、问题或建议。',
    '5. 优先保留高信息密度内容：结论、数字、因果、步骤、差异、限制条件、案例证据。',
    '6. 每条摘要必须让读者单独阅读时也能理解，避免“优化体验”“提升效率”这类泛化空话。',
    '7. 如果原文中同时出现“问题/原因/做法/结果”，优先覆盖这些关键维度，不要只摘章节名。',
    '8. 优先保留原文中的术语、数据、专有名词与结论性表述。',
    '9. 若原文存在 OCR 噪声、截断或歧义，只能如实弱化表述，不得自行补完。',
    '',
    `文档标题：${title}`,
    `来源类型：${doc.sourceMeta.type}`,
    parseWarning ? `解析提示：${parseWarning}` : '',
    '原文片段：',
    outline,
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
            model: process.env.HUNYUAN_MODEL?.trim() || 'hy3-preview',
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
  // 会话级 tree.id：本次生成的所有树（skeleton/complete/降级）共享同一 id，
  // 客户端可据此在首个 skeleton 到达时即跳转 /g/{id} 并保证落盘记录不错位
  const sessionTreeId = nanoid();

  console.log('[MindMap Debug] LLM配置:', {
    provider: llmConfig.provider,
    resolvedProvider: llmConfig.resolvedProvider,
    supported: llmConfig.supported,
    hasApiKey,
    model: llmConfig.model,
  });

  if (!llmConfig.supported || !hasApiKey) {
    console.log('[MindMap Debug] 走路径1: 启发式生成（无API Key或provider不支持）');
    const fallback = buildHeuristicMindMapTree(doc, sessionTreeId);
    // 最小骨架：仅根节点。客户端秒级进入编辑器时只看到根，
    // 其余节点经下方 node 事件逐个回放（一个一个生长），
    // 避免启发式全树预览与最终结果不符的观感。
    yield { type: 'skeleton', data: { tree: rootOnlyTree(fallback) } };
    for (const { patch, node } of progressiveTreePatches(fallback)) {
      yield { type: 'node', data: { patch, node } };
    }
    yield { type: 'complete', data: { tree: fallback } };
    return;
  }

  // ===== 会话共享启发式树：rootOnly 骨架的根来源 + 各路径失败时的降级终树 =====
  const heuristicTree = buildHeuristicMindMapTree(doc, sessionTreeId);
  const skeletonRootId = heuristicTree.root.id;

  /** 终树逐个下发（DFS 先序、先父后子）：配合客户端节拍调度实现逐个生长 */
  function* emitProgressiveNodes(tree: MindMapTree): Generator<GenerateStreamEvent> {
    for (const { patch, node } of progressiveTreePatches(tree)) {
      yield { type: 'node', data: { patch, node } };
    }
  }

  /** 根内容对齐事件：skeleton 根是启发式标题，终树根不同则先下发 update 让根尽早变成最终标题 */
  function rootContentUpdateEvent(currentContent: string, nextRoot: MindMapNode): GenerateStreamEvent | null {
    if (currentContent === nextRoot.content) return null;
    return {
      type: 'node',
      data: {
        patch: {
          type: 'update',
          nodeId: skeletonRootId,
          node: { content: nextRoot.content },
          timestamp: Date.now(),
        },
        node: { ...nextRoot, children: [] },
      },
    };
  }

  // ===== 微信文章 + 混元搜索增强：优先走混元联网生成路径 =====
  const isWeChatUrl = doc.sourceMeta.type === 'wechat' ||
    (doc.sourceMeta.sourceUrl && isWeChatArticleUrl(doc.sourceMeta.sourceUrl));

  if (isWeChatUrl) {
    const hunyuanApiKey = process.env.HUNYUAN_API_KEY?.trim();
    if (hunyuanApiKey) {
      yield { type: 'skeleton', data: { tree: rootOnlyTree(heuristicTree) } };

      try {
        const { json: rawJson } = await generateWeChatMindMapViaHunyuan(
          doc.sourceMeta.sourceUrl!,
        );

        const parsedTree = parseLLMTreeFromText(rawJson);
        if (parsedTree) {
          const finalTree = rebaseTreeRoot(
            llmTreeToMindMapTree(parsedTree, doc, sessionTreeId),
            skeletonRootId,
          );
          const rootEvent = rootContentUpdateEvent(heuristicTree.root.content, finalTree.root);
          if (rootEvent) yield rootEvent;
          yield* emitProgressiveNodes(finalTree);
          yield { type: 'complete', data: { tree: finalTree } };
          return;
        }
      } catch (hunyuanError) {
        const errMsg = hunyuanError instanceof Error ? hunyuanError.message : '混元搜索增强失败';
        console.warn(`[MindMap] 腾讯混元搜索增强生成微信文章思维导图失败，降级：${errMsg}`);
      }
      // 解析失败/异常：降级继续走后续路径（会再发 rootOnly 骨架，客户端按树替换处理）
    }
  }

  // 降级：智谱AI联网搜索
  if (isWeChatUrl && llmConfig.resolvedProvider === 'zhipu' && llmConfig.apiKey) {
    yield { type: 'skeleton', data: { tree: rootOnlyTree(heuristicTree) } };

    try {
      const { json: rawJson } = await generateWeChatMindMapViaZhipuWebSearch(
        doc.sourceMeta.sourceUrl!,
        { model: llmConfig.model },
      );

      const parsedTree = parseLLMTreeFromText(rawJson);
      if (parsedTree) {
        const finalTree = rebaseTreeRoot(
          llmTreeToMindMapTree(parsedTree, doc, sessionTreeId),
          skeletonRootId,
        );
        const rootEvent = rootContentUpdateEvent(heuristicTree.root.content, finalTree.root);
        if (rootEvent) yield rootEvent;
        yield* emitProgressiveNodes(finalTree);
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
  // 模型能力画像决定输出通道（stream-object / text-json）与 prompt 密度（lean / full），
  // 新增 provider 只需在 profiles.ts 登记画像，不改生成链路
  const modelProfile = resolveModelProfile(llmConfig.resolvedProvider);
  const prompt = buildPrompt(doc, { density: modelProfile.density });
  const requestConfig = resolveLLMRequestConfig(llmConfig.resolvedProvider);

  if (modelProfile.outputMode === 'text-json') {
    console.log('[MindMap Debug] 走路径3: 非OpenAI Provider -', llmConfig.resolvedProvider);
    console.log('[MindMap Debug] 使用提示词: buildCompatJsonPrompt()');
    yield { type: 'skeleton', data: { tree: rootOnlyTree(heuristicTree) } };

    try {
      const finalTree = await generateTreeWithCompatProvider(doc, llmConfig, requestConfig, {
        ...options,
        baseTreeId: sessionTreeId,
      });
      const rebased = rebaseTreeRoot(finalTree, skeletonRootId);
      const rootEvent = rootContentUpdateEvent(heuristicTree.root.content, rebased.root);
      if (rootEvent) yield rootEvent;
      yield* emitProgressiveNodes(rebased);
      yield { type: 'complete', data: { tree: rebased } };
      return;
    } catch (error) {
      // 降级终树也逐个回放，避免 rootOnly 骨架瞬间跳到全树
      yield* emitProgressiveNodes(heuristicTree);
      yield {
        type: 'error',
        data: {
          message:
            error instanceof Error
              ? `${describeGenerationFailure(error)}已自动生成本地大纲结果（${countNodes(heuristicTree.root)} 个节点）。`
              : '生成失败，已自动生成本地大纲结果。',
        },
      };
      yield { type: 'complete', data: { tree: heuristicTree } };
      return;
    }
  }

  const modelProvider = createProviderClient(llmConfig);

  // ===== 路径2: OpenAI Provider（streamObject 流式）=====
  // partial 期间用轻量预览树（无重后处理，结构即 LLM 输出，跨 partial 槽位稳定），
  // 以「父id:索引 → 稳定节点id」映射实现节点逐个下发；complete 走全量后处理，
  // 由客户端以终树自愈覆盖（见 generation-session 的 complete 处理）。
  const stableIdBySlot = new Map<string, string>();
  const emittedContentById = new Map<string, string>();
  let emittedRootContent: string = heuristicTree.root.content;
  let lastPreviewTree: MindMapTree | null = null;

  const buildPreviewTree = (llmTree: LLMMindMapTree): MindMapTree => {
    const sourceRef = makeDefaultSourceRef(doc);
    const rawRoot = createNodeFromLLM(llmTree.root, sourceRef);
    rawRoot.meta.type = 'main';
    const tree: MindMapTree = {
      ...getDefaultMindMapTree(
        llmTree.title || doc.sourceMeta.title || '思维导图',
        sourceRef,
        doc.sourceMeta.type,
      ),
      id: sessionTreeId,
      root: rawRoot,
    };
    return clampTree(tree, MAX_TREE_DEPTH, MAX_TREE_NODES);
  };

  /** 跨 partial 稳定 id：同槽位（父id:索引）复用 id */
  const restabilizeIds = (node: MindMapNode, parentStableId: string, index: number): MindMapNode => {
    const slot = `${parentStableId}:${index}`;
    let id = stableIdBySlot.get(slot);
    if (!id) {
      id = node.id;
      stableIdBySlot.set(slot, id);
    }
    const children = (node.children || []).map((child, i) => restabilizeIds(child, id, i));
    return { ...node, id, children };
  };

  /** 对预览树做增量下发：新节点 add（DFS 先序、先父后子），内容变化 update（逐字生长） */
  function* emitGrowthEvents(tree: MindMapTree): Generator<GenerateStreamEvent> {
    if (tree.root.content !== emittedRootContent) {
      emittedRootContent = tree.root.content;
      yield {
        type: 'node',
        data: {
          patch: {
            type: 'update',
            nodeId: skeletonRootId,
            node: { content: tree.root.content },
            timestamp: Date.now(),
          },
          node: { ...tree.root, children: [] },
        },
      };
    }

    function* walk(parent: MindMapNode): Generator<GenerateStreamEvent> {
      const children = parent.children || [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const prev = emittedContentById.get(child.id);
        if (prev === undefined) {
          emittedContentById.set(child.id, child.content);
          yield {
            type: 'node',
            data: {
              patch: {
                type: 'add',
                nodeId: child.id,
                parentId: parent.id,
                index: i,
                node: { ...child, children: [] },
                timestamp: Date.now(),
              },
              node: child,
            },
          };
        } else if (prev !== child.content) {
          emittedContentById.set(child.id, child.content);
          yield {
            type: 'node',
            data: {
              patch: {
                type: 'update',
                nodeId: child.id,
                node: { content: child.content },
                timestamp: Date.now(),
              },
              node: { ...child, children: [] },
            },
          };
        }
        yield* walk(child);
      }
    }

    yield* walk(tree.root);
  }

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

    // 立即下发最小骨架：客户端秒级进入编辑器，其余节点随 partial 逐个流入
    yield { type: 'skeleton', data: { tree: rootOnlyTree(heuristicTree) } };

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

      const preview = buildPreviewTree(parseResult.data);
      const stabilizedRoot: MindMapNode = {
        ...preview.root,
        id: skeletonRootId,
        children: (preview.root.children || []).map((child, i) => restabilizeIds(child, skeletonRootId, i)),
      };
      lastPreviewTree = { ...preview, root: stabilizedRoot };
      yield* emitGrowthEvents(lastPreviewTree);
    }

    const finalObject = await result.object;
    const finalTree = rebaseTreeRoot(llmTreeToMindMapTree(finalObject, doc, sessionTreeId), skeletonRootId);
    yield { type: 'complete', data: { tree: finalTree } };
  } catch (error) {
    if (lastPreviewTree) {
      // 已有流式预览：直接以预览树收尾（避免异 id 启发式回放造成重复节点）
      yield {
        type: 'error',
        data: {
          message:
            error instanceof Error
              ? `${describeGenerationFailure(error)}已保留已生成的部分结果（${countNodes(lastPreviewTree.root)} 个节点）。`
              : '生成失败，已保留已生成的部分结果。',
        },
      };
      yield { type: 'complete', data: { tree: lastPreviewTree } };
    } else {
      // 尚无任何 partial：降级启发式树逐个回放（与其他路径降级一致）
      yield* emitProgressiveNodes(heuristicTree);
      yield {
        type: 'error',
        data: {
          message:
            error instanceof Error
              ? `${describeGenerationFailure(error)}已自动生成本地大纲结果（${countNodes(heuristicTree.root)} 个节点）。`
              : '生成失败，已自动生成本地大纲结果。',
        },
      };
      yield { type: 'complete', data: { tree: heuristicTree } };
    }
  }
}

export interface BranchExpansionStreamEvent {
  type: 'child' | 'done';
  /** child 事件：新完成的子主题内容 */
  content?: string;
  /** done 事件：服务端权威子主题列表（终态对账用） */
  children?: string[];
  /** done 事件：生成来源证明 */
  proof?: { provider: string; model: string; source: 'llm' | 'heuristic' };
}

/**
 * 从流式增量缓冲中提取「已完成」的子主题字符串。
 *
 * 只处理 happy path：首个 `[` 后的顶层数组元素——字符串元素（含转义）
 * 与 {content} 对象元素整体跳读；未闭合的尾部元素忽略（等后续增量）。
 * 数组闭合（`]`）后停止扫描，避免误收尾部散文中的引号。
 * 返回全量已完成列表，调用方按自身已消费偏移增量取用。
 */
export function extractCompletedArrayStrings(buffer: string): string[] {
  const start = buffer.indexOf('[');
  if (start === -1) return [];

  const out: string[] = [];
  let i = start + 1;
  while (i < buffer.length) {
    const ch = buffer[i];

    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < buffer.length) {
        if (buffer[j] === '\\') {
          j += 2;
          continue;
        }
        if (buffer[j] === '"') {
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) break;
      try {
        const value = JSON.parse(buffer.slice(i, j + 1));
        if (typeof value === 'string') out.push(value);
      } catch {
        // 非法转义序列：跳过该元素
      }
      i = j + 1;
      continue;
    }

    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      let closed = false;
      while (j < buffer.length) {
        if (buffer[j] === '{') depth += 1;
        else if (buffer[j] === '}') {
          depth -= 1;
          if (depth === 0) {
            closed = true;
            break;
          }
        }
        j += 1;
      }
      if (!closed) break;
      try {
        const obj = JSON.parse(buffer.slice(i, j + 1)) as { content?: unknown };
        if (typeof obj?.content === 'string') out.push(obj.content);
      } catch {
        // 非法对象：跳过
      }
      i = j + 1;
      continue;
    }

    if (ch === ']') break; // 数组已闭合，不再扫描
    i += 1;
  }
  return out;
}

function parseBranchExpansionChildren(rawText: string): string[] {
  const cleaned = rawText.trim();
  if (!cleaned) return [];

  const candidates: string[] = [];
  try {
    const direct = JSON.parse(cleaned);
    candidates.push(cleaned, JSON.stringify(direct));
  } catch {
    candidates.push(cleaned);
  }

  for (const candidate of extractJsonCandidates(cleaned)) {
    candidates.push(candidate);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.children)
          ? parsed.children
          : null;
      if (!list) continue;

      const children = list
        .map((item: unknown) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && typeof (item as { content?: unknown }).content === 'string') {
            return (item as { content: string }).content;
          }
          return '';
        })
        .map((content: string) => content.trim().slice(0, 120))
        .filter((content: string) => content.length > 0);

      if (children.length > 0) return children.slice(0, 8);
    } catch {
      // try next candidate
    }
  }

  // Lenient fallback: one phrase per non-empty line.
  return cleaned
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.\s"{}\[\]]+/, '').replace(/["\[\]{},]$/, '').trim())
    .filter((line) => line.length > 0 && line.length <= 120)
    .slice(0, 8);
}

function buildHeuristicBranchExpansion(input: BranchExpansionInput): string[] {
  if (!input.documentMarkdown || !input.documentMarkdown.trim()) return [];

  const sentences = input.documentMarkdown
    .split(/(?<=[。！？.!?\n])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 8 && sentence.length <= 160);

  const focusLabel = input.focusContent;
  const existing = new Set(
    [...input.existingChildren, ...input.siblingTitles, focusLabel].map((title) =>
      normalizeExpansionSentenceKey(title),
    ),
  );

  const scored = sentences
    .map((sentence) => ({ sentence, score: scoreSentenceForBranch(focusLabel, sentence) }))
    .filter((item) => item.score > 0 && !existing.has(normalizeExpansionSentenceKey(item.sentence)))
    .sort((a, b) => b.score - a.score);

  const children: string[] = [];
  for (const item of scored) {
    if (children.length >= 5) break;
    if (children.some((child) => normalizeExpansionSentenceKey(child) === normalizeExpansionSentenceKey(item.sentence))) {
      continue;
    }
    children.push(item.sentence.slice(0, 120));
  }

  return children;
}

/**
 * 分支扩展（智能生成子主题）：流式产出。
 * LLM 增量输出经 extractCompletedArrayStrings 提取，每完成一个子主题
 * 立即 yield child 事件（供前端打字机回放）；流结束后以终态解析结果
 * yield done 事件（服务端权威列表，供前端对账）。
 * LLM 未配置时走启发式兜底：children 直接逐个 yield。
 */
export async function* streamBranchExpansion(
  input: BranchExpansionInput,
  options: {
    abortSignal?: AbortSignal;
  } = {},
): AsyncGenerator<BranchExpansionStreamEvent, void, unknown> {
  const focus = input.focusContent.trim();
  if (!focus) {
    throw new Error('选中节点内容为空，无法扩展。');
  }

  const llmConfig = resolveLLMConfig();
  const heuristicChildren = buildHeuristicBranchExpansion(input);
  const hasApiKey = Boolean(llmConfig.apiKey);

  if (!llmConfig.supported || !hasApiKey) {
    if (heuristicChildren.length === 0) {
      const keyHint = llmConfig.keyEnv || '对应 provider 的 API key';
      throw new Error(`LLM 未配置且原文中无可提炼的相关内容：请配置 ${keyHint} 后重试。`);
    }
    for (const content of heuristicChildren) {
      yield { type: 'child', content };
    }
    yield {
      type: 'done',
      children: heuristicChildren,
      proof: { provider: 'local', model: 'heuristic-v1', source: 'heuristic' },
    };
    return;
  }

  const requestConfig = resolveLLMRequestConfig(llmConfig.resolvedProvider);
  const expandTimeoutSeconds = parseNonNegativeInt(process.env.LLM_EXPAND_TIMEOUT, 45);
  const expandTimeoutMs = expandTimeoutSeconds > 0 ? expandTimeoutSeconds * 1000 : undefined;
  const expandMaxRetries = parseNonNegativeInt(process.env.LLM_EXPAND_MAX_RETRIES, requestConfig.maxRetries);
  const modelProvider = createProviderClient(llmConfig);

  const languageModel =
    llmConfig.resolvedProvider === 'openai'
      ? modelProvider(llmConfig.model)
      : modelProvider.chat(llmConfig.model as any);

  const result = streamText({
    model: languageModel,
    system: BRANCH_EXPANSION_SYSTEM,
    prompt: buildBranchExpansionPrompt(input),
    maxRetries: expandMaxRetries,
    timeout: expandTimeoutMs ?? requestConfig.timeoutMs,
    abortSignal: options.abortSignal,
    temperature: 0.4,
    maxOutputTokens: 800,
  });

  let full = '';
  let emitted = 0;
  for await (const delta of result.textStream) {
    if (!delta) continue;
    full += delta;
    const found = extractCompletedArrayStrings(full);
    if (found.length > emitted) {
      for (let k = emitted; k < found.length; k += 1) {
        const content = found[k].trim().slice(0, 120);
        if (content) yield { type: 'child', content };
      }
      emitted = found.length;
    }
  }

  let children = parseBranchExpansionChildren(full);
  if (children.length === 0 && heuristicChildren.length > 0) {
    children = heuristicChildren;
  }
  if (children.length === 0) {
    throw new Error('AI 扩展结果为空，请重试或换个节点。');
  }

  yield {
    type: 'done',
    children,
    proof: {
      provider: llmConfig.resolvedProvider || llmConfig.provider,
      model: llmConfig.model,
      source: 'llm',
    },
  };
}

/**
 * 节点文本 AI 操作（润色/拓展/简化/提问）：流式产出结果文本增量。
 * LLM 未配置时直接抛错（文本处理无可靠的本地降级路径）。
 */
export async function* streamNodeActionText(
  input: NodeActionInput,
  options: { abortSignal?: AbortSignal } = {},
): AsyncGenerator<string, void, unknown> {
  const nodeContent = input.nodeContent.trim();
  if (!nodeContent) {
    throw new Error('选中节点内容为空，无法处理。');
  }

  const llmConfig = resolveLLMConfig();
  if (!llmConfig.supported || !llmConfig.apiKey) {
    const keyHint = llmConfig.keyEnv || '对应 provider 的 API key';
    throw new Error(`LLM 未配置：请配置 ${keyHint} 后重试。`);
  }

  const requestConfig = resolveLLMRequestConfig(llmConfig.resolvedProvider);
  const modelProvider = createProviderClient(llmConfig);
  const languageModel =
    llmConfig.resolvedProvider === 'openai'
      ? modelProvider(llmConfig.model)
      : modelProvider.chat(llmConfig.model as any);

  const result = streamText({
    model: languageModel,
    system: NODE_ACTION_SYSTEM,
    prompt: buildNodeActionPrompt({ ...input, nodeContent }),
    temperature: 0.4,
    maxOutputTokens: 1200,
    abortSignal: options.abortSignal,
    maxRetries: requestConfig.maxRetries,
  });

  for await (const delta of result.textStream) {
    if (delta) yield delta;
  }
}

export interface TreeOptimizationResult {
  tree: LLMMindMapTree;
  provider: string;
  model: string;
  source: 'llm' | 'local';
}

function pruneTreeToDepth(node: LLMMindMapTree['root'], maxDepth: number): LLMMindMapTree['root'] {
  const next: LLMMindMapTree['root'] = { content: node.content };
  if (maxDepth > 0 && node.children && node.children.length > 0) {
    next.children = node.children.map((child) => pruneTreeToDepth(child, maxDepth - 1));
    if (next.children.length === 1 && next.children[0].children && next.children[0].children.length > 0) {
      // Collapse single-child chains to keep the simplified outline tight.
      const only = next.children[0];
      return { content: `${next.content}：${only.content}`, children: only.children };
    }
  }
  return next;
}

function llmTreeFromMindMapTree(tree: MindMapTree): LLMMindMapTree {
  const convert = (node: MindMapNode): LLMMindMapTree['root'] => ({
    content: node.content,
    children: (node.children || []).map((child) => convert(child)),
  });

  return {
    title: tree.meta.title || tree.root.content,
    root: convert(tree.root),
  };
}

function applyLocalTreeOptimization(
  tree: MindMapTree,
  mode: TreeOptimizeMode,
): TreeOptimizationResult {
  const llmTree = llmTreeFromMindMapTree(tree);
  let nextTree = llmTree;

  if (mode === 'simplify') {
    nextTree = { title: llmTree.title, root: pruneTreeToDepth(llmTree.root, 2) };
  } else {
    const restructured = restructureOversizedBranches(
      deduplicateNodeTitles(llmTreeToMindMapTreeForOptimize(llmTree, tree)),
    );
    nextTree = llmTreeFromMindMapTree(restructured);
  }

  return {
    tree: nextTree,
    provider: 'local',
    model: mode === 'simplify' ? 'prune-v1' : 'restructure-v1',
    source: 'local',
  };
}

function llmTreeToMindMapTreeForOptimize(llmTree: LLMMindMapTree, reference: MindMapTree): MindMapTree {
  const now = Date.now();
  const sourceRef = reference.root.meta.sourceRef;

  const convert = (node: LLMMindMapTree['root']): MindMapNode => ({
    id: nanoid(),
    content: node.content.trim().slice(0, 120) || '未命名节点',
    collapsed: false,
    children: (node.children || []).map((child) => convert(child)),
    meta: {
      sourceRef,
      type: 'detail',
      confidence: 0.7,
      createdAt: now,
      createdBy: 'ai',
    },
  });

  return {
    id: reference.id,
    root: convert(llmTree.root),
    meta: {
      ...reference.meta,
      updatedAt: now,
      version: reference.meta.version + 1,
    },
  };
}

export async function generateTreeOptimization(
  tree: MindMapTree,
  input: Omit<TreeOptimizationInput, 'outline' | 'rootTitle'>,
  options: {
    abortSignal?: AbortSignal;
  } = {},
): Promise<TreeOptimizationResult> {
  const outline = collectOutlineLines(tree, 80).join('\n');
  if (!outline.trim()) {
    throw new Error('导图为空，无法优化。');
  }

  const fullInput: TreeOptimizationInput = {
    ...input,
    outline,
    rootTitle: tree.meta.title || tree.root.content,
  };

  const llmConfig = resolveLLMConfig();
  const hasApiKey = Boolean(llmConfig.apiKey);

  if (!llmConfig.supported || !hasApiKey) {
    return applyLocalTreeOptimization(tree, input.mode);
  }

  const requestConfig = resolveLLMRequestConfig(llmConfig.resolvedProvider);
  const optimizeTimeoutSeconds = parseNonNegativeInt(process.env.LLM_OPTIMIZE_TIMEOUT, 90);
  const optimizeTimeoutMs = optimizeTimeoutSeconds > 0 ? optimizeTimeoutSeconds * 1000 : undefined;
  const optimizeMaxRetries = parseNonNegativeInt(process.env.LLM_OPTIMIZE_MAX_RETRIES, requestConfig.maxRetries);
  const modelProvider = createProviderClient(llmConfig);

  const languageModel =
    llmConfig.resolvedProvider === 'openai'
      ? modelProvider(llmConfig.model)
      : modelProvider.chat(llmConfig.model as any);

  const result = await generateText({
    model: languageModel,
    system: TREE_OPTIMIZE_SYSTEM,
    prompt: buildTreeOptimizePrompt(fullInput),
    maxRetries: optimizeMaxRetries,
    timeout: optimizeTimeoutMs ?? requestConfig.timeoutMs,
    abortSignal: options.abortSignal,
    temperature: 0.3,
    maxOutputTokens: 4000,
  });

  const parsed = parseLLMTreeFromText(result.text);
  if (!parsed) {
    const localFallback = applyLocalTreeOptimization(tree, input.mode);
    if (localFallback.tree.root.children && localFallback.tree.root.children.length > 0) {
      return localFallback;
    }
    throw new Error('AI 优化返回内容不是有效思维导图 JSON，请重试。');
  }

  return {
    tree: parsed,
    provider: llmConfig.resolvedProvider || llmConfig.provider,
    model: llmConfig.model,
    source: 'llm',
  };
}

export function convertOptimizedTreeToMindMapTree(
  llmTree: LLMMindMapTree,
  reference: MindMapTree,
): MindMapTree {
  return llmTreeToMindMapTreeForOptimize(llmTree, reference);
}

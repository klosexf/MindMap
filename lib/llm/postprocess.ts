/**
 * 思维导图后处理增强（代码层兜底，不依赖模型遵从度）。
 *
 * 职责（均为「原文回溯」型修复，输入必须携带原文）：
 * - repairNumericUnitsTree：节点尾部「动词+数字」且原文存在同组合的 `数字%` 时补单位
 * - ensureEnumerationRetention：原文枚举清单在树中命中率不足时机械回补缺失项
 * - repairCompositeOrdinalBranches：「策略一 / 策略二」式复合标签展平并聚合为单一主题父分支
 *
 * 设计原则：所有修复动作都必须能在原文中找到直接证据，找不到证据就不动
 * （零幻觉：宁可保留不完美输出，不允许代码引入新错误）。
 */

import type { MindMapNode, MindMapTree, NormalizedDocument, SourceReference } from '@/lib/types/mindmap';
import { nanoid } from 'nanoid';

/**
 * 数字单位守卫：节点以「中文词+数字」结尾且无 %，
 * 且原文存在完全相同的「词+数字%」组合时，补齐 %。
 * 例：节点「订单转化率提升10」+ 原文「订单转化率提升10%」→「订单转化率提升10%」
 */
const TRAILING_WORD_NUMBER_RE = /([\u4e00-\u9fa5]{1,6})(\d{1,4})$/;
const RATIO_CONTEXT_RE = /(提升|增长|上涨|提高|下降|降低|优化|占比|率|留存|复购|转化|参与|流失)/;

export function repairNumericUnits(content: string, sourceMarkdown: string): string {
  const match = content.match(TRAILING_WORD_NUMBER_RE);
  if (!match) return content;

  const [, tailWord, number] = match;
  if (!RATIO_CONTEXT_RE.test(tailWord)) return content;
  // 原文必须存在「数字%」的直接证据（词与数字间允许原文有间隔，
  // 如节点「转化率10」↔ 原文「转化率提升10%」），否则不动
  if (!sourceMarkdown.includes(`${number}%`)) return content;

  return `${content}%`;
}

export function repairNumericUnitsTree(tree: MindMapTree, sourceMarkdown: string): MindMapTree {
  if (!sourceMarkdown) return tree;
  const walk = (node: MindMapNode): MindMapNode => ({
    ...node,
    content: repairNumericUnits(node.content, sourceMarkdown),
    children: (node.children ?? []).map(walk),
  });
  return { ...tree, root: walk(tree.root) };
}

/** 枚举清单型标签备选（跨文体通用：简历技能/招聘要求/教程工具均命中） */
const ENUM_LABELS = '专业技能|技术技能|技能|技术栈|工具|证书|语言能力|兴趣爱好|特长';
/** 枚举段的下一标签（用于行内文本中界定枚举段结束） */
const NEXT_SECTION_LABELS = `${ENUM_LABELS}|个人总结|教育背景|教育经历|工作经历|项目经历|获奖|自我评价`;

interface EnumerationBlock {
  label: string;
  items: string[];
}

/** 分隔符一致的并列项（｜、/、·），至少 3 项 */
function splitEnumerationItems(raw: string): string[] | null {
  const items = raw
    .split(/[｜|、·]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length < 3) return null;
  // 单项长度约束：排除把整段句子误当枚举
  if (items.some((item) => item.length > 20)) return null;
  return items;
}

/**
 * 从原文提取「标签：A｜B｜C」型枚举清单。
 * 兼容行内文本（PDF 提取常把整段压成一行）：枚举段以下一个清单标签或句界结束。
 */
export function extractEnumerations(markdown: string): EnumerationBlock[] {
  const blocks: EnumerationBlock[] = [];
  const re = new RegExp(
    `(${ENUM_LABELS})[：:]\\s*([^。；\\n]{4,200}?)(?=\\s*(?:${NEXT_SECTION_LABELS})[：:]|\\s{2,}|$|。|；)`,
    'g',
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const label = match[1];
    const items = splitEnumerationItems(match[2]);
    if (items) {
      blocks.push({ label, items });
    }
  }
  return blocks;
}

function collectTreeText(root: MindMapNode): string {
  const parts: string[] = [];
  const walk = (node: MindMapNode): void => {
    parts.push(node.content);
    (node.children ?? []).forEach(walk);
  };
  walk(root);
  return parts.join('\n');
}

/**
 * 枚举回补：清单项在树中缺失时，把缺失项以单节点形式挂回。
 * 挂载点优先选择语义匹配的既有节点（含技能/工具/证书等关键词），否则挂根。
 */
export function ensureEnumerationRetention(
  tree: MindMapTree,
  doc: NormalizedDocument,
  sourceRef: SourceReference,
): MindMapTree {
  const blocks = extractEnumerations(doc.markdown);
  if (blocks.length === 0) return tree;

  const treeText = collectTreeText(tree.root);
  const additions: MindMapNode[] = [];

  for (const { label, items } of blocks) {
    const missing = items.filter((item) => !treeText.includes(item));
    if (missing.length === 0) continue;
    additions.push({
      id: `enum-${nanoid(10)}`,
      content: `${label}：${missing.join('、')}`,
      collapsed: false,
      meta: {
        sourceRef,
        type: 'detail',
        confidence: 0.9,
        createdAt: Date.now(),
        createdBy: 'ai',
      },
      children: [],
    });
  }

  if (additions.length === 0) return tree;

  // 逐个挂载：优先找语义匹配的锚点节点（深度 ≤ 2），找不到挂根
  const anchorRe = /(技能|工具|证书|爱好|特长|教育|其他|背景)/;
  let root = structuredClone(tree.root);
  for (const addition of additions) {
    // 用容器绕开闭包 narrowing（anchor 在 walk 内赋值）
    const anchorBox: MindMapNode[] = [];
    const walk = (node: MindMapNode, depth: number): void => {
      if (anchorBox.length === 0 && depth <= 2 && anchorRe.test(node.content)) {
        anchorBox.push(node);
      }
      (node.children ?? []).forEach((child) => walk(child, depth + 1));
    };
    walk(root, 0);

    const anchor = anchorBox[0];
    const labelMatch = addition.content.match(anchorRe);
    if (anchor && labelMatch && anchor.content.includes(labelMatch[0].slice(0, 2))) {
      anchor.children = [...(anchor.children ?? []), addition];
    } else {
      root = { ...root, children: [...(root.children ?? []), addition] };
    }
  }

  return { ...tree, root };
}

/** 序数实体段：「策略一：xxx」「方法二、zzz」——前缀词 + 序数 + 分隔 + 正文 */
const ORDINAL_NUM = '(?:[一二三四五六七八九十]{1,3}|\\d{1,2})';
const ENTITY_SEGMENT_RE = new RegExp(`^([\\u4e00-\\u9fa5]{1,6}?)${ORDINAL_NUM}[：:，、]+(.+)$`);
/** 复合标签分隔符：半角/全角斜杠、竖线（两侧可有空格） */
const COMPOSITE_SEP_RE = /\s*[/／|｜]\s*/;

interface OrdinalEntity {
  /** 实体统称（前缀词，如「策略」「第章」），null = 非序数实体 */
  term: string | null;
  node: MindMapNode;
  /** 展平来源（复合标签原节点 id），用于「成对来自同一复合节点」判定 */
  compositeId?: string;
}

/** 单段序数实体解析：命中返回 { term, body }，否则 null */
function parseOrdinalSegment(content: string): { term: string; body: string } | null {
  const match = content.match(ENTITY_SEGMENT_RE);
  if (!match) return null;
  const body = match[2].trim();
  // 正文过短（<2 字）视为误判（如「A/B」式缩写、孤立编号）
  if (body.length < 2) return null;
  return { term: match[1], body };
}

/**
 * 识别「策略一：xxx / 策略二：yyy」式复合标签：
 * 2 段以上、每段都是「同一前缀词 + 序数」开头的实体。
 * 命中返回分段数组，否则返回 null。
 */
export function splitCompositeOrdinalLabel(content: string): string[] | null {
  if (!COMPOSITE_SEP_RE.test(content)) return null;
  const segments = content
    .split(COMPOSITE_SEP_RE)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length < 2) return null;
  let term: string | null = null;
  for (const segment of segments) {
    const parsed = parseOrdinalSegment(segment);
    if (!parsed) return null;
    if (term === null) term = parsed.term;
    else if (term !== parsed.term) return null; // 前缀词不一致，不是同类实体
  }
  return term ? segments : null;
}

/**
 * 复合标签守卫：把「策略一 / 策略二」两两合并的复合父节点展平为
 * 独立实体节点，并将同一父节点下同前缀的实体聚合进单一主题父分支
 * （以统称命名，如「策略」），兑现系统指令 §8 并列实体聚合。
 *
 * 聚合触发条件（保守，避免误伤自由组织）：
 * - 同 term 实体 ≥ 3 个（§8 硬规则），或
 * - 恰好 2 个且全部来自同一个复合节点（保持原占位数量）
 */
export function repairCompositeOrdinalBranches(tree: MindMapTree): MindMapTree {
  const walk = (node: MindMapNode): MindMapNode => {
    const children = node.children ?? [];

    // 1. 分类：复合标签展平为实体段；独立序数实体标记 term；其余递归
    const classified: OrdinalEntity[] = [];
    for (const child of children) {
      const segments = splitCompositeOrdinalLabel(child.content);
      if (segments) {
        const term = parseOrdinalSegment(segments[0])?.term ?? null;
        segments.forEach((segment, i) => {
          classified.push({
            term,
            compositeId: child.id,
            node: {
              ...child,
              id: i === 0 ? child.id : `cmp-${nanoid(10)}`,
              content: segment,
              // 复合节点原有子树归首个实体，避免丢信息
              children: i === 0 ? (child.children ?? []).map(walk) : [],
            },
          });
        });
        continue;
      }
      const single = parseOrdinalSegment(child.content);
      if (single) {
        classified.push({ term: single.term, node: walk(child) });
      } else {
        classified.push({ term: null, node: walk(child) });
      }
    }

    // 2. 聚合：同 term 实体满足触发条件时收进单一主题父分支
    const counts = new Map<string, { total: number; sources: Set<string> }>();
    for (const entry of classified) {
      if (!entry.term) continue;
      const bucket = counts.get(entry.term) ?? { total: 0, sources: new Set<string>() };
      bucket.total += 1;
      if (entry.compositeId) bucket.sources.add(entry.compositeId);
      counts.set(entry.term, bucket);
    }

    const grouped: MindMapNode[] = [];
    const slotByTerm = new Map<string, number>();
    for (const entry of classified) {
      const term = entry.term;
      const bucket = term ? counts.get(term) : undefined;
      const shouldAggregate =
        !!term &&
        !!bucket &&
        !node.content.includes(term) && // 已在同名主题父分支下则不再套娃
        (bucket.total >= 3 || (bucket.total === 2 && bucket.sources.size === 1));
      if (!term || !shouldAggregate) {
        grouped.push(entry.node);
        continue;
      }
      const slot = slotByTerm.get(term);
      if (slot === undefined) {
        slotByTerm.set(term, grouped.length);
        grouped.push({
          ...entry.node,
          id: `agg-${nanoid(10)}`,
          content: term,
          children: [entry.node],
        });
      } else {
        const parent = grouped[slot];
        parent.children = [...(parent.children ?? []), entry.node];
      }
    }

    return { ...node, children: grouped };
  };

  return { ...tree, root: walk(tree.root) };
}

/**
 * 结构承诺检测（纯函数，代码侧实现，零文体假设）。
 *
 * 与 genre.ts 同一分层模式：System §8 只定义「结构承诺必须兑现」的通用原则，
 * 本模块在代码侧做廉价的承诺检测，命中时向 User 层注入 soft hint（仅供参考），
 * 未命中时不注入任何内容。
 *
 * 三类承诺形态（对应 system.ts §8）：
 * 1. 显式计数：「七项独特效率策略」「以下十二条」→ 树中该组节点数量必须为 N
 * 2. 显式编号序列：行首 1. 2. 3. / 一、二、三、连续递增 ≥3 → 逐项独立且保序
 * 3. 重复段落模式：同前缀标题（案例一/案例二/案例三…）≥3 次 → 同构展开
 */

import type { NormalizedDocument } from '@/lib/types/mindmap';

export interface StructurePromise {
  kind: 'count' | 'numbered' | 'repeated';
  /** 承诺的实体数量 */
  count: number;
  /** 承诺短语/前缀样例（注入 hint 时引用，帮助模型定位原文） */
  sample: string;
}

const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 中文数字（一~九十九）或阿拉伯数字转数值；无法解析返回 null */
export function cnToInt(token: string): number | null {
  if (/^\d{1,2}$/.test(token)) return Number.parseInt(token, 10);
  if (token === '十') return 10;
  if (token.length === 2 && token[0] === '十') return 10 + (CN_DIGITS[token[1]] ?? 0);
  if (token.length === 2 && token[1] === '十') return (CN_DIGITS[token[0]] ?? 0) * 10;
  if (token.length === 3 && token[1] === '十') return (CN_DIGITS[token[0]] ?? 0) * 10 + (CN_DIGITS[token[2]] ?? 0);
  if (token.length === 1) return CN_DIGITS[token] ?? null;
  return null;
}

const NUM_TOKEN = '[一二三四五六七八九十]{1,3}|\\d{1,2}';

/** 承诺数量合理区间：小于 2 无承诺意义，大于 40 多为误报（如页码/日期） */
const MIN_PROMISE_COUNT = 2;
const MAX_PROMISE_COUNT = 40;

/**
 * 显式计数：「N项/N大/N类 + 名词」。量词白名单刻意排除「个」等高误报词，
 * 且要求量词后紧跟 1-10 个汉字（名词），否则视为普通数量短语。
 */
function detectCountPromises(text: string): StructurePromise[] {
  const re = new RegExp(`(${NUM_TOKEN})([项大种类条章篇节步])([\\u4e00-\\u9fff]{1,10})`, 'g');
  const out: StructurePromise[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(re)) {
    const count = cnToInt(match[1]);
    if (count === null || count < MIN_PROMISE_COUNT || count > MAX_PROMISE_COUNT) continue;
    const sample = match[0];
    if (seen.has(sample)) continue;
    seen.add(sample);
    out.push({ kind: 'count', count, sample });
  }
  // 只保留数值最大的一条（「七项策略」与「三个方法」并存时优先覆盖全文的计数）
  return out.sort((a, b) => b.count - a.count).slice(0, 1);
}

/**
 * 显式编号序列：行首「N、/N./N)」连续递增 ≥3 视为承诺。
 * 支持中文数字与阿拉伯数字两种风格，同风格才构成序列。
 */
function detectNumberedPromises(text: string): StructurePromise[] {
  const lineRe = new RegExp(`^\\s*(?:#{1,4}\\s*)?(?:第)?(${NUM_TOKEN})[、.．)）]\\s*\\S`, 'gm');
  const seq: number[] = [];
  for (const match of text.matchAll(lineRe)) {
    const n = cnToInt(match[1]);
    if (n !== null) seq.push(n);
  }
  if (seq.length < 3) return [];
  // 最长连续递增子序列（允许从 1 或 2 开始）
  let best = 1;
  let run = 1;
  for (let i = 1; i < seq.length; i += 1) {
    run = seq[i] === seq[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  if (best < 3) return [];
  return [{ kind: 'numbered', count: best, sample: `行首编号序列（共 ${best} 级连续递增）` }];
}

/**
 * 重复段落模式：同一前缀 + 编号的标题（案例一/案例二…）出现 ≥3 次。
 */
function detectRepeatedPromises(text: string): StructurePromise[] {
  const re = new RegExp(`([\\u4e00-\\u9fff]{2,6})(?:${NUM_TOKEN})[：:、\\s]`, 'g');
  const counter = new Map<string, number>();
  for (const match of text.matchAll(re)) {
    counter.set(match[1], (counter.get(match[1]) ?? 0) + 1);
  }
  const out: StructurePromise[] = [];
  for (const [prefix, times] of counter) {
    if (times >= 3) {
      out.push({ kind: 'repeated', count: times, sample: `「${prefix}+编号」重复标题 ${times} 次` });
    }
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 1);
}

/** 检测取样上限：承诺短语通常在正文前部或通篇分布，12000 与 prompt 注入上限一致 */
const SAMPLE_LIMIT = 12000;

export function detectStructurePromises(doc: NormalizedDocument): StructurePromise[] {
  const text = doc.markdown.slice(0, SAMPLE_LIMIT);
  return [
    ...detectCountPromises(text),
    ...detectNumberedPromises(text),
    ...detectRepeatedPromises(text),
  ];
}

/**
 * 生成注入 User 层的结构承诺提示（未检出时返回空数组）。
 * 声明「仅供参考」，与体裁提示同一机制，避免误检硬性约束模型。
 */
export function buildStructurePromiseHintLines(doc: NormalizedDocument): string[] {
  const promises = detectStructurePromises(doc);
  if (promises.length === 0) {
    return [];
  }
  const lines = promises.map((p) => {
    if (p.kind === 'count') {
      return `原文出现显式计数「${p.sample}」：该组内容在树中必须对应 ${p.count} 个逐项独立的节点，数量与顺序不得增删合并。`;
    }
    if (p.kind === 'numbered') {
      return `原文存在${p.sample}：每个编号条目必须逐项独立成节点并保持原顺序。`;
    }
    return `原文存在${p.sample}：该组实体必须同构展开（复用同一套子节点槽位）。`;
  });
  return ['## 结构承诺提示（系统检测注入，仅供参考）', ...lines];
}

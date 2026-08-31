import type { NormalizedDocument } from '@/lib/types/mindmap';

/**
 * OCR 输出归一化（零文体假设，所有中文 PDF 受益）。
 *
 * 两类 OCR 污染的修复：
 * 1. 兼容部首字符：部分 OCR 引擎把「方/工/己/日」输出为康熙部首 ⽅⼯日（U+2F00 区段），
 *    导致模型只能猜读、专名与标题识别失败。逐字符选择性 NFKC 转回正常汉字。
 *    注意：禁止对全文整体 normalize('NFKC')——它会把全角标点（，：（））转成 ASCII，破坏中文排版。
 * 2. CJK 字符间空格：PDF 字间距被 OCR 还原成空格（"贡 献 者"），折叠之。
 *    仅折叠「CJK 与 CJK/CJK标点之间」的空格，不影响中英文混排的正常空格（"PM 的" 保留）。
 */

/** CJK 表意文字 + 兼容部首/兼容表意（OCR 污染字符视同汉字参与空格折叠） */
const CJK_CHARS = '\\u2e80-\\u2fdf\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const CJK_PUNCTUATION = '\\u3000-\\u303f\\uff01-\\uff5e';

/** 康熙部首（U+2E80-U+2FDF，含 Radicals Supplement）与 CJK 兼容表意文字（U+F900-U+FAFF）逐字符转正常形式 */
export function normalizeCompatRadicalChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x2e80 && cp <= 0x2fdf) || (cp >= 0xf900 && cp <= 0xfaff)) {
      out += ch.normalize('NFKC');
    } else {
      out += ch;
    }
  }
  return out;
}

const CJK_SPACE_AFTER_RE = new RegExp(`([${CJK_CHARS}])[ \\t\\u00a0]+(?=[${CJK_CHARS}${CJK_PUNCTUATION}])`, 'g');
const CJK_SPACE_BEFORE_RE = new RegExp(`([${CJK_PUNCTUATION}])[ \\t\\u00a0]+(?=[${CJK_CHARS}${CJK_PUNCTUATION}])`, 'g');

/** 折叠 CJK 之间 / CJK 与中文标点之间的 OCR 空格 */
export function collapseCjkSpacing(text: string): string {
  return text.replace(CJK_SPACE_AFTER_RE, '$1').replace(CJK_SPACE_BEFORE_RE, '$1');
}

export function normalizeOcrText(text: string): string {
  return collapseCjkSpacing(normalizeCompatRadicalChars(text));
}

/** 对整份解析结果做 OCR 归一化（markdown 与 chunks 同步，保证后处理原文回溯命中率） */
export function normalizeOcrDocument(doc: NormalizedDocument): NormalizedDocument {
  return {
    ...doc,
    markdown: normalizeOcrText(doc.markdown),
    chunks: doc.chunks.map((chunk) => ({ ...chunk, text: normalizeOcrText(chunk.text) })),
  };
}

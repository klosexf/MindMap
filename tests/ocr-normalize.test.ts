import { describe, expect, it } from 'vitest';

import {
  collapseCjkSpacing,
  normalizeCompatRadicalChars,
  normalizeOcrDocument,
  normalizeOcrText,
} from '@/lib/parsers/normalize';
import type { NormalizedDocument } from '@/lib/types/mindmap';

describe('OCR 输出归一化（P0-A）', () => {
  describe('normalizeCompatRadicalChars', () => {
    it('康熙部首字符还原为正常汉字（Tal PDF badcase）', () => {
      // ⽅(U+2F45)→方、⽇(U+2F47)→日、⽉(U+2F49)→月、⼈(U+2F08)→人
      expect(normalizeCompatRadicalChars('⽅⽇⽉⼈')).toBe('方日月人');
      expect(normalizeCompatRadicalChars('⼰')).toBe('己');
    });

    it('全角标点不被转换（禁止整体 NFKC 的原因）', () => {
      const text = '策略一：当场解决，不当场则用异步工具';
      expect(normalizeCompatRadicalChars(text)).toBe(text);
    });

    it('正常 CJK 与英文数字不受影响', () => {
      expect(normalizeCompatRadicalChars('超级个人贡献者 59秒 Loom')).toBe(
        '超级个人贡献者 59秒 Loom',
      );
    });
  });

  describe('collapseCjkSpacing', () => {
    it('折叠 CJK 字符之间的 OCR 空格', () => {
      expect(collapseCjkSpacing('贡 献 者')).toBe('贡献者');
      expect(collapseCjkSpacing('个 人')).toBe('个人');
    });

    it('保留中英文之间的正常空格', () => {
      expect(collapseCjkSpacing('PM 的产品经理')).toBe('PM 的产品经理');
      expect(collapseCjkSpacing('用 Slack 工具')).toBe('用 Slack 工具');
    });

    it('折叠 CJK 与中文标点之间的空格', () => {
      expect(collapseCjkSpacing('显得 ： 自私')).toBe('显得：自私');
      expect(collapseCjkSpacing('策略一 ： 解决')).toBe('策略一：解决');
    });
  });

  describe('normalizeOcrText 组合', () => {
    it('部首还原 + 空格折叠同时生效', () => {
      expect(normalizeOcrText('超 级个 ⼈ 贡献者')).toBe('超级个人贡献者');
    });
  });

  describe('normalizeOcrDocument', () => {
    it('markdown 与 chunks 同步归一化', () => {
      const doc: NormalizedDocument = {
        markdown: '贡 献 者使⽤',
        chunks: [
          {
            id: 'c1',
            text: '贡 献 者使⽤',
            tokenEstimate: 4,
            sourceRef: { type: 'pdf', page: 1 },
          },
        ],
        sourceMeta: { type: 'pdf', title: 't' },
      };
      const out = normalizeOcrDocument(doc);
      expect(out.markdown).toBe('贡献者使用');
      expect(out.chunks[0].text).toBe('贡献者使用');
      // 原对象不被修改
      expect(doc.markdown).toBe('贡 献 者使⽤');
    });
  });
});

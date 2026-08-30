import { describe, expect, it } from 'vitest';

import {
  ANTI_HALLUCINATION_SYSTEM,
  PROMPT_VERSION,
  buildCompatJsonPrompt,
  buildPrompt,
  resolveModelProfile,
} from '../lib/llm/prompts';
import type { NormalizedDocument } from '../lib/types/mindmap';

const testDoc: NormalizedDocument = {
  markdown: '# Test Document\n\nThis is a test.',
  chunks: [],
  sourceMeta: {
    type: 'text',
    title: 'Test Document',
  },
};

// 空 markdown 使正文占比最小，预算门禁只测“指令部分”的规模
const minimalDoc: NormalizedDocument = {
  markdown: '',
  chunks: [],
  sourceMeta: {
    type: 'text',
    title: 'T',
  },
};

/**
 * Prompt 资产工程门禁。
 *
 * 与 prompt-generation.test.ts 的分工：
 * - 本文件：工程不变量（版本号 / token 预算 / 快照 / 单一来源 / 模型画像）
 * - prompt-generation.test.ts：语义内容（规则必须出现且指向正确的层）
 *
 * 快照测试的意义：任何 prompt 改动都会使快照失败，强制走“评审 diff → 更新版本号 →
 * 更新快照”的受控流程，防止 prompt 被无意识漂移。
 */
describe('Prompt 资产 · 工程门禁', () => {
  describe('版本管理', () => {
    it('PROMPT_VERSION 必须是语义化版本（prompt 变更时必须同步更新）', () => {
      expect(PROMPT_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    });
  });

  describe('模型能力画像（profiles）', () => {
    it('openai：原生 streamObject 通道 + lean 密度', () => {
      expect(resolveModelProfile('openai')).toEqual({ outputMode: 'stream-object', density: 'lean' });
    });

    it('国内兼容通道：text-json + full 密度', () => {
      const compatProviders = ['zhipu', 'kimi', 'minimax', 'qwen', 'hunyuan', 'deepseek'];
      for (const provider of compatProviders) {
        expect(resolveModelProfile(provider)).toEqual({ outputMode: 'text-json', density: 'full' });
      }
    });

    it('未知/未提供 provider 回退到安全默认画像（text-json + full）', () => {
      const fallback = { outputMode: 'text-json', density: 'full' };
      expect(resolveModelProfile('unknown-provider')).toEqual(fallback);
      expect(resolveModelProfile(undefined)).toEqual(fallback);
      expect(resolveModelProfile(null)).toEqual(fallback);
    });
  });

  describe('density 档位（prompt 密度随模型能力伸缩）', () => {
    it('默认不传参 = full 档（向后兼容）', () => {
      expect(buildPrompt(testDoc)).toBe(buildPrompt(testDoc, { density: 'full' }));
    });

    it('lean 档省略 few-shot 教学示例', () => {
      const lean = buildPrompt(testDoc, { density: 'lean' });
      expect(lean).not.toContain('## Few-shot');
    });

    it('lean 档不丢失规则红线（绝对规则/自检/兜底必须保留）', () => {
      const lean = buildPrompt(testDoc, { density: 'lean' });
      expect(lean).toContain('## 绝对规则');
      expect(lean).toContain('智能自检测闭环');
      expect(lean).toContain('## 兜底规则');
      expect(lean).toContain('文件名禁令');
    });

    it('lean 档带来可观的 token 收益（>500 字符）', () => {
      const lean = buildPrompt(minimalDoc, { density: 'lean' });
      const full = buildPrompt(minimalDoc, { density: 'full' });
      expect(full.length - lean.length).toBeGreaterThan(500);
    });
  });

  describe('单一来源断言（System/User 分层不双写）', () => {
    it('金字塔四原则的完整定义只存在于 System 层', () => {
      const principleDefinitions = [
        '结论先行（Conclusion First）',
        '以上统下（Upper-Level Summarizes Lower-Level）',
        '归类分组（MECE Categorization）',
        '逻辑递进（Logical Progression）',
      ];
      for (const def of principleDefinitions) {
        expect(ANTI_HALLUCINATION_SYSTEM).toContain(def);
      }
    });

    it('User 层只引用方法论、不重述定义（防止 System/User 冗余回归）', () => {
      const userPrompts = [
        buildPrompt(testDoc, { density: 'full' }),
        buildPrompt(testDoc, { density: 'lean' }),
        buildCompatJsonPrompt(testDoc),
      ];
      // 这些是 System 层的定义性文本，User 层出现即视为双写回归
      const systemOnlyDefinitions = [
        '每个父节点都是其所有子节点的**概括性结论**',
        '上层节点是下层节点的**思想概括**',
        '互斥且完全穷尽（Mutually Exclusive, Collectively Exhaustive）',
        '分组依据必须是**同一逻辑维度**',
      ];
      for (const prompt of userPrompts) {
        for (const def of systemOnlyDefinitions) {
          expect(prompt).not.toContain(def);
        }
      }
    });

    it('User prompt 必须引用 System 层契约（引用而非内联）', () => {
      expect(buildPrompt(testDoc, { density: 'lean' })).toContain('严格遵循系统指令中的金字塔原理四原则');
      expect(buildCompatJsonPrompt(testDoc)).toContain('严格遵循系统指令中的金字塔原理四原则');
    });
  });

  describe('token 预算门禁（以字符数为工程代理指标）', () => {
    it('System prompt 预算：跨请求稳定层，受益于 prompt cache', () => {
      expect(ANTI_HALLUCINATION_SYSTEM.length).toBeLessThan(3600);
    });

    it('流式 user prompt（full 档）指令部分预算', () => {
      expect(buildPrompt(minimalDoc, { density: 'full' }).length).toBeLessThan(5200);
    });

    it('流式 user prompt（lean 档）指令部分预算', () => {
      expect(buildPrompt(minimalDoc, { density: 'lean' }).length).toBeLessThan(4400);
    });

    it('兼容模式 user prompt 指令部分预算', () => {
      expect(buildCompatJsonPrompt(minimalDoc).length).toBeLessThan(4200);
    });
  });

  describe('快照（任何 prompt 改动必须显式评审 diff 并更新快照）', () => {
    it('System prompt 快照', () => {
      expect(ANTI_HALLUCINATION_SYSTEM).toMatchSnapshot();
    });

    it('流式 user prompt（full / lean 两档）快照', () => {
      expect(buildPrompt(testDoc, { density: 'full' })).toMatchSnapshot();
      expect(buildPrompt(testDoc, { density: 'lean' })).toMatchSnapshot();
    });

    it('兼容模式 user prompt 快照', () => {
      expect(buildCompatJsonPrompt(testDoc)).toMatchSnapshot();
    });
  });
});

import { describe, expect, it } from 'vitest';

import {
  ANTI_HALLUCINATION_SYSTEM,
  buildCompatJsonPrompt,
  buildMarkdownPreviewPrompt,
  buildPrompt,
  PROMPT_MARKDOWN_LIMIT,
} from '../lib/llm/prompts';
import type { NormalizedDocument } from '../lib/types/mindmap';
import { MAX_TREE_DEPTH, MAX_TREE_NODES } from '../lib/utils/tree';

const testDoc: NormalizedDocument = {
  markdown: '# Test Document\n\nThis is a test.',
  chunks: [],
  sourceMeta: {
    type: 'text',
    title: 'Test Document',
  },
};

/**
 * Prompt 语义内容测试（分层后的职责划分）：
 * - System 层（ANTI_HALLUCINATION_SYSTEM）：金字塔方法论 + 反幻觉红线的单一来源
 * - User 层（buildPrompt / buildCompatJsonPrompt / buildMarkdownPreviewPrompt）：
 *   任务声明、语义红线、约束值、兜底规则，引用而不重述 System 方法论
 *
 * 工程不变量（版本/预算/快照/单一来源/画像）见 llm-prompts.test.ts。
 */
describe('Prompt Generation', () => {
  describe('System 层 · 金字塔方法论单一来源', () => {
    it('should include pyramid principle · 结论先行 (Conclusion First)', () => {
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('结论先行（Conclusion First）');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('根节点不应机械复用文档标题');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('概括性结论');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('分类标签');
    });

    it('should include pyramid principle · 以上统下 (Upper-Level Summarizes Lower-Level)', () => {
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('以上统下（Upper-Level Summarizes Lower-Level）');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('上层节点是下层节点的**思想概括**');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('下层节点是上层节点的**具体支撑**');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('直接支撑/解释/例证其父节点');
    });

    it('should include pyramid principle · 归类分组 (MECE)', () => {
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('归类分组（MECE Categorization）');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('互斥且完全穷尽');
    });

    it('should include pyramid principle · 逻辑递进 (Logical Progression)', () => {
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('逻辑递进（Logical Progression）');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('明确的逻辑顺序');
      for (const order of ['演绎', '时间', '结构', '程度']) {
        expect(ANTI_HALLUCINATION_SYSTEM).toContain(order);
      }
    });

    it('should include 总分结构 paradigm requirement', () => {
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('根节点（总）');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('一级节点（分）');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('二级节点（分）');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('一级节点之间的排序必须体现所选递进模式');
    });

    it('should include anti-hallucination red lines', () => {
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('绝对禁止编造、推测、补充、合理化');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('同一信息多次出现时只保留一次');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('文末被截断时以最后一个完整段落为准');
    });

    it('should include node integrity rules (mechanically verifiable)', () => {
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('节点完整性');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('单一来源原则');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('数字与单位不可分割');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('枚举完整性');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('禁止节点以孤立数字、日期残片、地点碎片开头');
    });

    it('should include proper-noun verbatim red line', () => {
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('专名逐字红线');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('禁止改写、缩写、翻译或合理化');
    });

    it('should include genre-agnostic structure paradigm selection (not resume-specific)', () => {
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('结构范式选择');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('先判断文档体裁');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('平行结构一致性');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('事实层与评价层分离');
      // 反过拟合：禁止把骨架写死在某一文体上
      expect(ANTI_HALLUCINATION_SYSTEM).not.toContain('识别为简历');
      expect(ANTI_HALLUCINATION_SYSTEM).not.toContain('个人简历时');
    });

    it('should forbid composite entity labels and truncated branch titles (§8 Tal badcase)', () => {
      // 结构承诺兑现：编号/计数/重复模式三类形态，文体无关表述
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('结构承诺必须兑现');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('显式计数');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('禁止虚构编号');
      // 并列实体聚合为独立主题父分支
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('并列实体聚合');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('主题父分支');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('禁止两两拆分');
      // 同类实体逐项独立，禁止复合标签
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('逐项独立成节点');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('复合标签');
      // 分支标签与叶子同权适用语义完整性
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('分支标签与叶子同权');
      // 反过拟合：§8 禁止出现任何具体文体的示例词
      expect(ANTI_HALLUCINATION_SYSTEM).not.toContain('策略一');
      expect(ANTI_HALLUCINATION_SYSTEM).not.toContain('不公平是');
    });

    it('should share the same markdown limit between stream and compat prompts', () => {
      expect(PROMPT_MARKDOWN_LIMIT).toBe(12000);
    });
  });

  describe('User 层 · 任务声明与语义红线', () => {
    it('should declare the 总分结构 task by referencing the system contract instead of restating it', () => {
      const prompts = [buildPrompt(testDoc), buildCompatJsonPrompt(testDoc)];

      for (const prompt of prompts) {
        expect(prompt).toContain('严格遵循系统指令中的金字塔原理四原则');
        expect(prompt).toContain('总分结构');
      }
    });

    it('should include empty-label prohibition', () => {
      const prompt = buildPrompt(testDoc);
      const compatPrompt = buildCompatJsonPrompt(testDoc);

      expect(prompt).toContain('无空标签节点');
      expect(prompt).toContain('不得仅为分类标签');
      expect(compatPrompt).toContain('空标签');
      expect(compatPrompt).toContain('实质信息');
    });

    it('should include node count and depth constraints', () => {
      const prompts = [buildPrompt(testDoc), buildCompatJsonPrompt(testDoc)];

      for (const prompt of prompts) {
        expect(prompt).toContain(`最大层级：${MAX_TREE_DEPTH}`);
        expect(prompt).toContain(`最大节点数：${MAX_TREE_NODES}`);
        expect(prompt).toContain('上限 35 字');
        expect(prompt).toContain('一级节点 2-8 个');
        expect(prompt).toContain('直接子节点数 ≤ 8 个');
      }
    });

    it('should include fallback rules for edge cases', () => {
      const prompts = [buildPrompt(testDoc), buildCompatJsonPrompt(testDoc)];

      for (const prompt of prompts) {
        expect(prompt).toContain('兜底规则');
        expect(prompt).toContain('无法识别的内容');
      }
    });

    it('should include the required self-check loop in all document generation prompts', () => {
      const prompts = [
        buildPrompt(testDoc),
        buildCompatJsonPrompt(testDoc),
        buildMarkdownPreviewPrompt(testDoc),
      ];

      for (const prompt of prompts) {
        expect(prompt).toContain('结构完整性检查');
        expect(prompt).toContain('内容相关性检查');
        expect(prompt).toContain('逻辑一致性检查');
        expect(prompt).toContain('表达准确性检查');
        expect(prompt).toContain('这是对文档内容最准确、最有效的总结方式吗？');
        expect(prompt).toContain('自检测未通过');
        expect(prompt).toContain('自动返回修改并重新生成');
      }
    });

    it('should require every second-level node to be expanded with source-backed child nodes', () => {
      const prompts = [buildPrompt(testDoc), buildCompatJsonPrompt(testDoc)];

      for (const prompt of prompts) {
        expect(prompt).toContain('所有二级节点必须至少展开一层');
        expect(prompt).toContain('二级节点不得保持叶子状态');
        expect(prompt).toContain('子节点必须来自原文');
        expect(prompt).toContain('检查所有二级节点是否均已展开');
        expect(prompt).toContain('无重要内容节点被遗漏');
      }
    });

    it('should include explicit anti-duplication rules for repeated facts across nodes', () => {
      const prompts = [buildPrompt(testDoc), buildCompatJsonPrompt(testDoc)];

      for (const prompt of prompts) {
        expect(prompt).toContain('同一事实/经历/数据/句意全树只能出现一次');
        expect(prompt).toContain('不得在父节点和子节点中重复复述同一条信息');
        expect(prompt).toContain('禁止用“(1)”“(2)”');
      }
      // 输出前的全树去重扫描：兼容模式一次性输出，必须在 prompt 内显式要求
      expect(buildCompatJsonPrompt(testDoc)).toContain('全树去重扫描');
      expect(buildPrompt(testDoc)).toContain('全树去重');
    });

    it('should require high-value information extraction instead of shallow heading restatement', () => {
      const prompts = [buildPrompt(testDoc), buildCompatJsonPrompt(testDoc)];

      for (const prompt of prompts) {
        expect(prompt).toContain('高价值信息提炼流程');
        expect(prompt).toContain('高信息密度内容');
        expect(prompt).toContain('最影响理解结果');
        expect(prompt).toContain('不要只保留章节名');
      }
    });

    it('should include a coverage checklist for important information dimensions', () => {
      const prompts = [buildPrompt(testDoc), buildCompatJsonPrompt(testDoc)];

      for (const prompt of prompts) {
        expect(prompt).toContain('关键信息覆盖检查');
        expect(prompt).toContain('核心主张');
        expect(prompt).toContain('方法步骤');
        expect(prompt).toContain('风险限制');
        expect(prompt).toContain('帮助用户理解与复述');
      }
    });

    it('should include node writing guidance for user comprehension', () => {
      const prompts = [buildPrompt(testDoc), buildCompatJsonPrompt(testDoc)];

      for (const prompt of prompts) {
        expect(prompt).toContain('节点写法优化');
        expect(prompt).toContain('对象 + 判断/动作/结果');
        expect(prompt).toContain('脱离上下文也能读懂');
        expect(prompt).toContain('泛化套话');
      }
    });

    it('should keep the compat prompt compact enough for non-streaming providers', () => {
      const prompt = buildCompatJsonPrompt(testDoc);

      expect(prompt.length).toBeLessThan(7600);
    });

    it('should prefer a meaningful document title for the root node across layers', () => {
      const prompt = buildPrompt(testDoc);
      const compatPrompt = buildCompatJsonPrompt(testDoc);

      expect(prompt).toContain('标题本身已经概括核心判断');
      expect(prompt).toContain('不只是文档类型名');
      expect(compatPrompt).toContain('更有信息量的结论句');
      expect(ANTI_HALLUCINATION_SYSTEM).toContain('根节点不应机械复用文档标题');
    });

    it('should include real-badcase few-shot examples in full density (lean 省略示例但不丢规则)', () => {
      const fullPrompt = buildPrompt(testDoc, { density: 'full' });
      const leanPrompt = buildPrompt(testDoc, { density: 'lean' });

      expect(fullPrompt).toContain('## Few-shot');
      expect(fullPrompt).toContain('分类边界污染');
      expect(fullPrompt).toContain('文件名作为节点标题');
      // few-shot 压缩后，反例承载的规则必须仍以规则文本形式存在
      expect(leanPrompt).toContain('文件名禁令');
      expect(leanPrompt).toContain('语义归属');
    });

    it('should inject genre hint only when a genre is detected (体裁差异走 User 层)', () => {
      const resumeDoc: NormalizedDocument = {
        markdown: '工作经历：……\n教育背景：……\n专业技能：Figma、Axure',
        chunks: [],
        sourceMeta: { type: 'text', title: '某候选人简历' },
      };

      // 未检出文体：不注入任何提示，System 通用逻辑兜底
      expect(buildPrompt(testDoc)).not.toContain('文档体裁提示');
      expect(buildCompatJsonPrompt(testDoc)).not.toContain('文档体裁提示');

      // 检出简历：注入体裁提示 + 范式建议，并声明仅供参考
      const prompted = buildPrompt(resumeDoc);
      expect(prompted).toContain('文档体裁提示');
      expect(prompted).toContain('个人简历');
      expect(prompted).toContain('实体→属性→量化证据');
      expect(prompted).toContain('仅供参考');
      expect(buildCompatJsonPrompt(resumeDoc)).toContain('文档体裁提示');
    });
  });
});

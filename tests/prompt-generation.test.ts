import { describe, expect, it } from 'vitest';

import { buildCompatJsonPrompt, buildMarkdownPreviewPrompt, buildPrompt } from '../lib/llm/generate';
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

describe('Prompt Generation', () => {
  it('should include pyramid principle · 结论先行 (Conclusion First)', () => {
    const prompt = buildPrompt(testDoc);

    expect(prompt).toContain('金字塔原理');
    expect(prompt).toContain('结论先行');
    expect(prompt).toContain('总分结构');
    expect(prompt).toContain('根节点不应机械复用文档标题');
    expect(prompt).toContain('结论性陈述');
  });

  it('should include pyramid principle · 以上统下 (Upper-Level Summarizes Lower-Level)', () => {
    const prompt = buildPrompt(testDoc);

    expect(prompt).toContain('以上统下');
    expect(prompt).toContain('上层是下层的思想概括');
    expect(prompt).toContain('下层是上层的具体支撑');
    expect(prompt).toContain('直接支撑/解释其父节点');
  });

  it('should include pyramid principle · 归类分组 (MECE)', () => {
    const prompt = buildPrompt(testDoc);

    expect(prompt).toContain('归类分组');
    expect(prompt).toContain('MECE');
    expect(prompt).toContain('互斥且完全穷尽');
  });

  it('should include pyramid principle · 逻辑递进 (Logical Progression)', () => {
    const prompt = buildPrompt(testDoc);

    expect(prompt).toContain('逻辑递进');
    expect(prompt).toContain('明确逻辑顺序');
    expect(prompt).toContain('演绎');
    expect(prompt).toContain('时间');
    expect(prompt).toContain('结构');
    expect(prompt).toContain('程度');
  });

  it('should include 总分结构 paradigm requirement', () => {
    const prompt = buildPrompt(testDoc);

    expect(prompt).toContain('根节点【总】');
    expect(prompt).toContain('一级节点【分】');
    expect(prompt).toContain('二级节点【分】');
    expect(prompt).toContain('按逻辑递进排列');
  });

  it('should include empty-label prohibition', () => {
    const prompt = buildPrompt(testDoc);

    expect(prompt).toContain('无空标签节点');
    expect(prompt).toContain('不得仅为分类标签');
  });

  it('should include node count and depth constraints', () => {
    const prompt = buildPrompt(testDoc);

    expect(prompt).toContain(`最大层级：${MAX_TREE_DEPTH}`);
    expect(prompt).toContain(`最大节点数：${MAX_TREE_NODES}`);
    expect(prompt).toContain('上限 35 字');
    expect(prompt).toContain('一级节点 2-8 个');
    expect(prompt).toContain('子节点数 ≤ 8 个');
  });

  it('should include fallback rules for edge cases', () => {
    const prompt = buildPrompt(testDoc);

    expect(prompt).toContain('兜底规则');
    expect(prompt).toContain('无法识别的内容');
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
      expect(prompt).toContain('全树去重扫描');
    }
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

  it('should prefer a meaningful document title for the root node in both prompts', () => {
    const prompt = buildPrompt(testDoc);
    const compatPrompt = buildCompatJsonPrompt(testDoc);

    expect(prompt).toContain('只有当标题本身已经概括核心判断');
    expect(prompt).toContain('不只是文档类型名');
    expect(compatPrompt).toContain('根节点不应机械复用文档标题');
    expect(compatPrompt).toContain('更有信息量的结论句');
  });
});

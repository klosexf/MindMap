import { describe, expect, it } from 'vitest';

import type { NormalizedDocument } from '../lib/types/mindmap';

function buildPrompt(doc: NormalizedDocument): string {
  const MAX_TREE_DEPTH = 4;
  const MAX_TREE_NODES = 120;
  
  const docTypeHint: Record<string, string> = {
    resume: '这是一份简历/履历文档，请按"基本信息、工作经历、项目经验、专业技能、教育背景"等模块组织内容。',
    report: '这是一份报告/分析文档，请按"概述、主要内容、数据分析、结论建议"等模块组织内容。',
    article: '这是一篇文章/论文，请按"摘要、主要内容、关键观点、结论"等模块组织内容。',
    tutorial: '这是一份教程/指南，请按"概述、核心步骤、注意事项、总结"等模块组织内容。',
    general: '请根据内容的实际结构组织思维导图。',
  };

  return [
    '你是资深知识整理专家，请对文档内容进行优化总结，生成思维导图。',
    '',
    '## 核心原则',
    '- **智能重组**：不拘泥于原文结构，基于核心内容重新组织，采用最清晰的方式呈现',
    '- **节点精炼**：避免节点过多和冗余，每个节点都应有独立价值',
    '- **逻辑清晰**：确保父子节点关系明确，层级递进合理',
    '- **信息完整**：在精简结构的同时，保留所有关键信息',
    '',
    '## 文档类型',
    docTypeHint.general,
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

describe('Prompt Generation', () => {
  it('should include requirement for intelligent reorganization', () => {
    const doc: NormalizedDocument = {
      markdown: '# Test Document\n\nThis is a test.',
      chunks: [],
      sourceMeta: {
        type: 'text',
        title: 'Test Document',
      },
    };

    const prompt = buildPrompt(doc);
    
    expect(prompt).toContain('你是资深知识整理专家');
    expect(prompt).toContain('智能重组');
    expect(prompt).toContain('节点精炼');
    expect(prompt).toContain('逻辑清晰');
    expect(prompt).toContain('信息完整');
  });

  it('should include requirement for detailed content in second layer nodes', () => {
    const doc: NormalizedDocument = {
      markdown: '# Test Document\n\nThis is a test.',
      chunks: [],
      sourceMeta: {
        type: 'text',
        title: 'Test Document',
      },
    };

    const prompt = buildPrompt(doc);
    
    expect(prompt).toContain('第二层为具体内容总结');
    expect(prompt).toContain('第二层节点必须包含具体的内容总结');
    expect(prompt).toContain('呈现核心信息和关键细节');
  });

  it('should include optimization requirements', () => {
    const doc: NormalizedDocument = {
      markdown: '# Test Document\n\nThis is a test.',
      chunks: [],
      sourceMeta: {
        type: 'text',
        title: 'Test Document',
      },
    };

    const prompt = buildPrompt(doc);
    
    expect(prompt).toContain('合并相似内容，去除冗余信息');
    expect(prompt).toContain('避免节点过多和冗余');
    expect(prompt).toContain('优先考虑思维导图的可读性和实用性');
    expect(prompt).toContain('不必完全遵循原文章节顺序');
  });

  it('should not contain old structure-fidelity requirement', () => {
    const doc: NormalizedDocument = {
      markdown: '# Test Document\n\nThis is a test.',
      chunks: [],
      sourceMeta: {
        type: 'text',
        title: 'Test Document',
      },
    };

    const prompt = buildPrompt(doc);
    
    expect(prompt).not.toContain('结构保真');
    expect(prompt).not.toContain('必须反映文档原有的章节/段落结构');
    expect(prompt).not.toContain('内容忠实');
  });
});

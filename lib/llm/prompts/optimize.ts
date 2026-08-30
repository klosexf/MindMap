/**
 * 导图结构优化 User Prompt 与输入契约。
 */

export type TreeOptimizeMode = 'simplify' | 'restructure';

export interface TreeOptimizationInput {
  outline: string;
  rootTitle: string;
  mode: TreeOptimizeMode;
  documentMarkdown?: string;
}

export function buildTreeOptimizePrompt(input: TreeOptimizationInput): string {
  const modeInstruction =
    input.mode === 'simplify'
      ? '优化目标：精简。合并语义重复的节点、删除空泛套话节点、压缩到 3 层以内，让结构更聚焦。'
      : '优化目标：重组。按更合理的逻辑维度（如总分、流程、因果）重新组织分支，调整层级归属，让结构更清晰。';

  const sections: string[] = [
    modeInstruction,
    '',
    `当前导图标题：${input.rootTitle}`,
    '',
    '当前导图大纲（缩进表示层级）：',
    input.outline,
  ];

  if (input.documentMarkdown && input.documentMarkdown.trim()) {
    sections.push('', '参考原文（优化时保持忠于原文事实）：', input.documentMarkdown.trim().slice(0, 6000));
  }

  return sections.join('\n');
}

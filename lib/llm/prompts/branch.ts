/**
 * 分支扩展（节点展开）User Prompt 与输入契约。
 */

export interface BranchExpansionInput {
  focusContent: string;
  pathTitles: string[];
  siblingTitles: string[];
  existingChildren: string[];
  documentMarkdown?: string;
}

export function buildBranchExpansionPrompt(input: BranchExpansionInput): string {
  const sections: string[] = [
    '请为下面的思维导图节点生成子节点。',
    '',
    `选中节点：${input.focusContent}`,
  ];

  if (input.pathTitles.length > 0) {
    sections.push(`从根到该节点的路径：${input.pathTitles.join(' → ')}`);
  }
  if (input.siblingTitles.length > 0) {
    sections.push(`同级已有节点（避免重复）：${input.siblingTitles.slice(0, 12).join('；')}`);
  }
  if (input.existingChildren.length > 0) {
    sections.push(`该节点已有子节点（避免重复）：${input.existingChildren.slice(0, 12).join('；')}`);
  }
  if (input.documentMarkdown && input.documentMarkdown.trim()) {
    sections.push('', '参考原文（优先从中提炼）：', input.documentMarkdown.trim().slice(0, 6000));
  } else {
    sections.push('', '（无参考原文，请基于通用知识提出合理的展开维度）');
  }

  return sections.join('\n');
}

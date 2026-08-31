/**
 * 节点文本 AI 操作（润色 / 拓展 / 简化 / 提问）Prompt 资产。
 *
 * 约束：
 * - 节点 content 上限 500 字符，polish/expand/simplify 的输出必须能直接写回节点，
 *   因此要求输出总量 ≤ 450 字符，超出部分由前端兜底截断
 * - 输出必须是"可直接使用的结果文本"，禁止解释、前后缀、markdown 代码块
 */

export type NodeTextAction = 'polish' | 'expand' | 'simplify' | 'questions';

export interface NodeActionInput {
  action: NodeTextAction;
  nodeContent: string;
  pathTitles: string[];
  documentMarkdown?: string;
}

export const NODE_ACTION_SYSTEM = `你是一个思维导图节点的文本处理助手。你将收到一个节点及其上下文，并按要求输出处理结果。

规则：
1. 直接输出结果文本，禁止任何解释、开场白、结语或 markdown 代码块标记。
2. 保持与节点内容及相关上下文一致的语言。
3. 内容处理类操作（润色/拓展/简化）输出一段连贯文本，总长度不超过 450 个字符。
4. 提问类操作输出恰好 5 个问题，每行一个，以数字编号开头。
5. 只基于节点内容和给定上下文，不要编造上下文中不存在的事实。`;

const ACTION_INSTRUCTIONS: Record<NodeTextAction, string> = {
  polish: '请润色下面的节点文本：保持原意，修正语病，使表达更准确、专业、流畅。不要改变原意，不要新增事实。',
  expand:
    '请拓展下面的节点文本：补充关键细节、原因或示例，使内容更具体。总长度不超过 450 个字符，不要偏离节点主题。',
  simplify: '请简化下面的节点文本：保留核心含义，删除冗余表述，使其更精炼易读。',
  questions:
    '请针对下面的节点内容提出 5 个最有价值的关键问题：帮助用户深入思考该主题。每行一个问题，以数字编号开头。',
};

export function buildNodeActionPrompt(input: NodeActionInput): string {
  const sections: string[] = [ACTION_INSTRUCTIONS[input.action], '', `节点内容：${input.nodeContent}`];

  if (input.pathTitles.length > 0) {
    sections.push(`所在主题路径：${input.pathTitles.join(' → ')}`);
  }
  if (input.documentMarkdown && input.documentMarkdown.trim()) {
    sections.push('', '参考原文（用于理解上下文）：', input.documentMarkdown.trim().slice(0, 4000));
  }

  return sections.join('\n');
}

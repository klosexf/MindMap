import { nanoid } from 'nanoid';

import type { MindMapNode, MindMapTree, SourceReference } from '@/lib/types/mindmap';

export interface TemplateNode {
  content: string;
  children?: TemplateNode[];
}

export interface MindMapTemplate {
  id: string;
  name: string;
  description: string;
  /** Root label shown as the map title node. */
  root: string;
  branches: TemplateNode[];
}

/**
 * Preset mindmap templates: users pick one, get a ready-to-edit skeleton,
 * and refine it directly in the editor instead of starting from a blank canvas.
 */
export const MINDMAP_TEMPLATES: MindMapTemplate[] = [
  {
    id: 'swot',
    name: 'SWOT 分析',
    description: '优势 / 劣势 / 机会 / 威胁四象限盘点',
    root: 'SWOT 分析',
    branches: [
      {
        content: '优势 Strengths',
        children: [
          { content: '核心竞争力' },
          { content: '资源与资产' },
        ],
      },
      {
        content: '劣势 Weaknesses',
        children: [
          { content: '能力短板' },
          { content: '资源约束' },
        ],
      },
      {
        content: '机会 Opportunities',
        children: [
          { content: '市场趋势' },
          { content: '潜在合作' },
        ],
      },
      {
        content: '威胁 Threats',
        children: [
          { content: '竞争风险' },
          { content: '外部变化' },
        ],
      },
    ],
  },
  {
    id: '5w2h',
    name: '5W2H 计划',
    description: '从问题到执行方案的七维拆解',
    root: '5W2H 计划',
    branches: [
      { content: 'What 做什么' },
      { content: 'Why 为什么做' },
      { content: 'Who 谁来负责' },
      { content: 'When 时间节点' },
      { content: 'Where 在哪里' },
      { content: 'How 怎么做' },
      { content: 'How much 成本多少' },
    ],
  },
  {
    id: 'meeting',
    name: '会议纪要',
    description: '议程、结论与行动项一站式记录',
    root: '会议纪要',
    branches: [
      {
        content: '会议信息',
        children: [
          { content: '时间' },
          { content: '参会人' },
        ],
      },
      { content: '议题与讨论' },
      {
        content: '结论与决定',
        children: [{ content: '决定事项' }],
      },
      {
        content: '行动项',
        children: [
          { content: '负责人 / 截止时间' },
          { content: '跟进机制' },
        ],
      },
    ],
  },
  {
    id: 'book-notes',
    name: '读书笔记',
    description: '要点、金句与应用的阅读沉淀',
    root: '读书笔记',
    branches: [
      { content: '书籍信息' },
      {
        content: '核心观点',
        children: [{ content: '论点 / 论据' }],
      },
      { content: '金句摘录' },
      {
        content: '启发与应用',
        children: [{ content: '下一步行动' }],
      },
    ],
  },
];

export function getTemplateById(templateId: string): MindMapTemplate | undefined {
  return MINDMAP_TEMPLATES.find((template) => template.id === templateId);
}

function buildTemplateNode(
  templateNode: TemplateNode,
  sourceRef: SourceReference,
  rootId: string,
): MindMapNode {
  const children = templateNode.children?.map((child) => buildTemplateNode(child, sourceRef, rootId));
  return {
    id: nanoid(),
    content: templateNode.content,
    collapsed: false,
    children: children && children.length > 0 ? children : [],
    meta: {
      sourceRef,
      type: 'detail',
      confidence: 1,
      createdAt: 0,
      createdBy: 'user',
    },
  };
}

/**
 * Materialize a template into a full MindMapTree with unique node ids.
 * Timestamps use the provided `now` so callers (and tests) get deterministic meta.
 */
export function buildTemplateTree(templateId: string, now: number = Date.now()): MindMapTree | null {
  const template = getTemplateById(templateId);
  if (!template) return null;

  const rootId = nanoid();
  const sourceRef: SourceReference = {
    type: 'prompt',
    text: `模板：${template.name}`,
  };

  const root: MindMapNode = {
    id: rootId,
    content: template.root,
    collapsed: false,
    children: template.branches.map((branch) => buildTemplateNode(branch, sourceRef, rootId)),
    meta: {
      sourceRef,
      type: 'main',
      confidence: 1,
      createdAt: now,
      createdBy: 'user',
    },
  };

  return {
    id: nanoid(),
    root,
    meta: {
      title: template.name,
      sourceType: 'prompt',
      createdAt: now,
      updatedAt: now,
      version: 1,
      truncated: false,
    },
  };
}

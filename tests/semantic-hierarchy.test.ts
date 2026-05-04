import { describe, expect, it } from 'vitest';

import { validateSemanticHierarchy } from '../lib/llm/generate';
import type { MindMapTree, SourceReference } from '../lib/types/mindmap';
import { createNode, getDefaultMindMapTree } from '../lib/utils/tree';

function makeSourceRef(): SourceReference {
  return { type: 'text', text: 'test' };
}

function makeTree(rootChildren: { content: string; children: { content: string }[] }[]): MindMapTree {
  const sourceRef = makeSourceRef();
  const tree = getDefaultMindMapTree('Test Tree', sourceRef, 'text');
  const root = createNode('Test Root', sourceRef, 'ai');

  root.children = rootChildren.map((child) => {
    const parentNode = createNode(child.content, sourceRef, 'ai');
    parentNode.children = child.children.map((sub) => createNode(sub.content, sourceRef, 'ai'));
    return parentNode;
  });

  return {
    ...tree,
    root,
  };
}

function getChildContents(tree: MindMapTree, parentIndex: number): string[] {
  const parent = tree.root.children?.[parentIndex];
  if (!parent || !parent.children) return [];
  return parent.children.map((c) => c.content);
}

function getAllChildrenFlat(tree: MindMapTree): string[] {
  return (tree.root.children || []).flatMap((p) => (p.children || []).map((c) => c.content));
}

describe('validateSemanticHierarchy', () => {
  it('passes through a valid "专业技能" node with skill-only children', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Python后端开发' },
          { content: 'React前端架构' },
          { content: 'SQL数据库优化' },
        ],
      },
    ]);

    const result = validateSemanticHierarchy(tree);
    const children = getChildContents(result, 0);

    expect(children).toEqual([
      'Python后端开发',
      'React前端架构',
      'SQL数据库优化',
    ]);
  });

  it('removes "交易结算" from under "专业技能" node', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Python后端开发' },
          { content: '交易结算' },
          { content: 'SQL数据库优化' },
        ],
      },
    ]);

    const result = validateSemanticHierarchy(tree);
    const children = getChildContents(result, 0);

    expect(children).not.toContain('交易结算');
    expect(children).toContain('Python后端开发');
    expect(children).toContain('SQL数据库优化');
  });

  it('removes multiple non-skill children from "专业技能" including 结算, 审批, 对账', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Python后端开发' },
          { content: '交易结算' },
          { content: '费用审批' },
          { content: 'SQL数据库优化' },
          { content: '日常对账' },
        ],
      },
    ]);

    const result = validateSemanticHierarchy(tree);
    const children = getChildContents(result, 0);

    expect(children).not.toContain('交易结算');
    expect(children).not.toContain('费用审批');
    expect(children).not.toContain('日常对账');
    expect(children).toContain('Python后端开发');
    expect(children).toContain('SQL数据库优化');
    expect(children.length).toBe(2);
  });

  it('removes operational terms (运营, 留存, 活跃) from "专业技能"', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Java微服务开发' },
          { content: '平台运营维护' },
          { content: '用户留存提升' },
          { content: 'DAU活跃增长' },
          { content: 'Kubernetes部署' },
        ],
      },
    ]);

    const result = validateSemanticHierarchy(tree);
    const children = getChildContents(result, 0);

    expect(children).not.toContain('平台运营维护');
    expect(children).not.toContain('用户留存提升');
    expect(children).not.toContain('DAU活跃增长');
    expect(children).toContain('Java微服务开发');
    expect(children).toContain('Kubernetes部署');
  });

  it('removes HR/administrative terms (招聘, 考勤, 绩效) from "专业技能"', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'React Native开发' },
          { content: '招聘面试' },
          { content: '考勤管理' },
          { content: '绩效评估' },
        ],
      },
    ]);

    const result = validateSemanticHierarchy(tree);
    const children = getChildContents(result, 0);

    expect(children).not.toContain('招聘面试');
    expect(children).not.toContain('考勤管理');
    expect(children).not.toContain('绩效评估');
    expect(children).toContain('React Native开发');
  });

  it('removes financial terms (预算, 成本, 发票, 报销) from "专业技能"', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Spring Boot开发' },
          { content: '项目成本预算' },
          { content: '发票管理' },
          { content: '费用报销' },
        ],
      },
    ]);

    const result = validateSemanticHierarchy(tree);
    const children = getChildContents(result, 0);

    expect(children).not.toContain('项目成本预算');
    expect(children).not.toContain('发票管理');
    expect(children).not.toContain('费用报销');
    expect(children).toContain('Spring Boot开发');
  });

  it('removes sales/market terms (销售, 拜访, 推广) from "专业技能"', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Go语言开发' },
          { content: '客户拜访' },
          { content: '市场推广' },
          { content: '广告投放' },
        ],
      },
    ]);

    const result = validateSemanticHierarchy(tree);
    const children = getChildContents(result, 0);

    expect(children).not.toContain('客户拜访');
    expect(children).not.toContain('市场推广');
    expect(children).not.toContain('广告投放');
    expect(children).toContain('Go语言开发');
  });

  it('removes procurement/logistics terms (采购, 库存, 物流) from "专业技能"', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Vue.js前端开发' },
          { content: '物资采购' },
          { content: '库存管理' },
          { content: '物流配送' },
        ],
      },
    ]);

    const result = validateSemanticHierarchy(tree);
    const children = getChildContents(result, 0);

    expect(children).not.toContain('物资采购');
    expect(children).not.toContain('库存管理');
    expect(children).not.toContain('物流配送');
    expect(children).toContain('Vue.js前端开发');
  });

  it('removes legal/compliance terms (合同, 法务, 知识产权) from "专业技能"', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Android开发' },
          { content: '合同审查' },
          { content: '知识产权管理' },
        ],
      },
    ]);

    const result = validateSemanticHierarchy(tree);
    const children = getChildContents(result, 0);

    expect(children).not.toContain('合同审查');
    expect(children).not.toContain('知识产权管理');
    expect(children).toContain('Android开发');
  });

  it('does NOT affect non-skill parent nodes', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Python开发' },
          { content: '交易结算' }, // should be removed from skill parent
        ],
      },
      {
        content: '工作职责',
        children: [
          { content: '交易结算' }, // should be KEPT in non-skill parent
          { content: '日常运营' },
        ],
      },
    ]);

    const result = validateSemanticHierarchy(tree);

    const skillChildren = getChildContents(result, 0);
    expect(skillChildren).not.toContain('交易结算');
    expect(skillChildren).toContain('Python开发');

    const dutyChildren = getChildContents(result, 1);
    expect(dutyChildren).toContain('交易结算');
    expect(dutyChildren).toContain('日常运营');
  });

  it('handles "技术栈" as a skill parent keyword', () => {
    const tree = makeTree([
      {
        content: '技术栈',
        children: [
          { content: 'TypeScript全栈开发' },
          { content: '交易结算系统' },
        ],
      },
    ]);

    const result = validateSemanticHierarchy(tree);
    const children = getChildContents(result, 0);

    expect(children).not.toContain('交易结算系统');
    expect(children).toContain('TypeScript全栈开发');
  });

  it('handles "核心能力" as a skill parent keyword', () => {
    const tree = makeTree([
      {
        content: '核心能力',
        children: [
          { content: '系统架构设计' },
          { content: '日常报销审批' },
        ],
      },
    ]);

    const result = validateSemanticHierarchy(tree);
    const children = getChildContents(result, 0);

    expect(children).not.toContain('日常报销审批');
    expect(children).toContain('系统架构设计');
  });

  it('returns the same tree reference when nothing changes', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Python开发' },
          { content: 'React开发' },
        ],
      },
    ]);

    const result = validateSemanticHierarchy(tree);
    // Should be the same reference since no changes were made
    expect(result).toBe(tree);
  });

  it('handles empty children gracefully', () => {
    const tree = makeTree([
      { content: '专业技能', children: [] },
    ]);

    const result = validateSemanticHierarchy(tree);
    const children = getChildContents(result, 0);

    expect(children).toEqual([]);
  });

  it('handles tree with no children at all', () => {
    const sourceRef = makeSourceRef();
    const tree = getDefaultMindMapTree('Empty', sourceRef, 'text');

    const result = validateSemanticHierarchy(tree);
    expect(result).toBe(tree);
  });
});

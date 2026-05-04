import { describe, expect, it } from 'vitest';

import { restructureOversizedBranches } from '../lib/llm/generate';
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

function getAllGroupLabels(tree: MindMapTree, parentIdx: number): string[] {
  const parent = tree.root.children?.[parentIdx];
  if (!parent?.children) return [];
  return parent.children.map((c) => c.content);
}

function countLeafNodes(node: { children?: { children?: any[] }[] }): number {
  if (!node.children || node.children.length === 0) return 1;
  return node.children.reduce((sum: number, c) => sum + countLeafNodes(c), 0);
}

describe('restructureOversizedBranches', () => {
  it('passes through tree with <=8 children unchanged', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Python' },
          { content: 'Java' },
          { content: 'React' },
          { content: 'Vue' },
          { content: 'Docker' },
          { content: 'MySQL' },
          { content: 'Redis' },
          { content: 'K8s' },
        ],
      },
    ]);

    const result = restructureOversizedBranches(tree);
    // 8 children is within limit, should be unchanged
    expect(result).toBe(tree);
  });

  it('restructures >8 children into grouped intermediate nodes', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Python' },
          { content: 'Java' },
          { content: 'Spring Boot' },
          { content: 'React' },
          { content: 'Vue' },
          { content: 'Node.js' },
          { content: 'Docker' },
          { content: 'Kubernetes' },
          { content: 'MySQL' },
          { content: 'Redis' },
        ],
      },
    ]);

    const result = restructureOversizedBranches(tree);
    const parent = result.root.children?.[0];
    expect(parent).toBeDefined();

    // Should have intermediate grouping nodes (not flat 10 leaves)
    const groups = parent!.children || [];
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.length).toBeLessThanOrEqual(8);

    // Each group should have children
    for (const group of groups) {
      expect(group.content.length).toBeGreaterThan(0);
      expect(group.children).toBeDefined();
    }

    // Total leaf count should be preserved
    const totalLeaves = countLeafNodes(parent!);
    expect(totalLeaves).toBe(10);
  });

  it('restructures 15 children with keyword clustering', () => {
    const children = [
      { content: 'Python' },
      { content: 'Java' },
      { content: 'Spring Boot' },
      { content: 'React' },
      { content: 'Vue' },
      { content: 'Node.js' },
      { content: 'Docker' },
      { content: 'Kubernetes' },
      { content: 'MySQL' },
      { content: 'Redis' },
      { content: 'PostgreSQL' },
      { content: 'TypeScript' },
      { content: 'Angular' },
      { content: 'AWS' },
      { content: 'GCP' },
    ];

    const tree = makeTree([{ content: '专业技能', children }]);

    const result = restructureOversizedBranches(tree);
    const parent = result.root.children?.[0];
    expect(parent).toBeDefined();

    const groups = parent!.children || [];
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.length).toBeLessThanOrEqual(8);

    const totalLeaves = countLeafNodes(parent!);
    expect(totalLeaves).toBe(15);
  });

  it('handles multiple oversized parents independently', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'A1' }, { content: 'A2' }, { content: 'A3' },
          { content: 'A4' }, { content: 'A5' }, { content: 'A6' },
          { content: 'A7' }, { content: 'A8' }, { content: 'A9' },
        ],
      },
      {
        content: '工作经历',
        children: [
          { content: 'B1' }, { content: 'B2' }, { content: 'B3' },
          { content: 'B4' }, { content: 'B5' }, { content: 'B6' },
          { content: 'B7' }, { content: 'B8' }, { content: 'B9' },
        ],
      },
    ]);

    const result = restructureOversizedBranches(tree);

    const skill = result.root.children?.[0];
    const exp = result.root.children?.[1];

    expect(skill?.children?.length).toBeGreaterThan(1);
    expect(exp?.children?.length).toBeGreaterThan(1);

    const skillLeaves = countLeafNodes(skill!);
    const expLeaves = countLeafNodes(exp!);
    expect(skillLeaves).toBe(9);
    expect(expLeaves).toBe(9);
  });

  it('does NOT restructure non-oversized siblings while restructuring one oversized', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'A1' }, { content: 'A2' }, { content: 'A3' },
          { content: 'A4' }, { content: 'A5' }, { content: 'A6' },
          { content: 'A7' }, { content: 'A8' }, { content: 'A9' },
        ],
      },
      {
        content: '教育背景',
        children: [
          { content: '本科' },
          { content: '硕士' },
        ],
      },
    ]);

    const result = restructureOversizedBranches(tree);

    const skill = result.root.children?.[0];
    const edu = result.root.children?.[1];

    expect(skill?.children?.length).toBeGreaterThan(1);
    // Non-oversized sibling should NOT be grouped — still flat 2 leaves
    expect(edu?.children?.length).toBe(2);
    expect(edu?.content).toBe('教育背景');
  });

  it('generates meaningful group labels from children keywords', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Python开发' },
          { content: 'Java后端' },
          { content: 'Spring框架' },
          { content: 'React前端' },
          { content: 'Vue组件' },
          { content: 'Docker容器' },
          { content: 'Kubernetes' },
          { content: 'MySQL数据库' },
          { content: 'Redis缓存' },
        ],
      },
    ]);

    const result = restructureOversizedBranches(tree);
    const groups = result.root.children?.[0]?.children || [];

    for (const group of groups) {
      // Group labels should be descriptive (not just "分组 N")
      expect(group.content.length).toBeGreaterThan(1);
    }
  });

  it('handles tree with no children', () => {
    const sourceRef = makeSourceRef();
    const tree = getDefaultMindMapTree('Empty', sourceRef, 'text');

    const result = restructureOversizedBranches(tree);
    expect(result).toBe(tree);
  });

  it('preserves metadata on restructured nodes', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Q1' }, { content: 'Q2' }, { content: 'Q3' },
          { content: 'Q4' }, { content: 'Q5' }, { content: 'Q6' },
          { content: 'Q7' }, { content: 'Q8' }, { content: 'Q9' },
        ],
      },
    ]);

    const result = restructureOversizedBranches(tree);
    const groups = result.root.children?.[0]?.children || [];

    for (const group of groups) {
      expect(group.id).toBeDefined();
      expect(group.meta).toBeDefined();
      expect(group.meta.type).toBeDefined();
    }
  });
});

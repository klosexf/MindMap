import { describe, expect, it } from 'vitest';

import type { MindMapTree } from '@/lib/types/mindmap';
import {
  outlineDocToTree,
  outlineNodeExists,
  outlineRoundTripLossless,
  treeToOutlineDoc,
} from '@/lib/utils/outline';

function buildTree(): MindMapTree {
  const now = Date.now();
  const sourceRef = { type: 'text' as const };
  return {
    id: 'tree-1',
    root: {
      id: 'root',
      content: 'AI产品经理需要掌握的能力',
      children: [
        {
          id: 'a',
          content: '技术理解力',
          children: [
            {
              id: 'a1',
              content: '机器学习基础',
              children: [
                { id: 'a1x', content: '监督学习与无监督学习的区别', meta: { sourceRef, type: 'detail', confidence: 1, createdAt: now, createdBy: 'ai' } },
                { id: 'a1y', content: '常见模型：决策树、神经网络、SVM', meta: { sourceRef, type: 'detail', confidence: 1, createdAt: now, createdBy: 'ai' } },
              ],
              meta: { sourceRef, type: 'main', confidence: 1, createdAt: now, createdBy: 'ai' },
            },
          ],
          meta: { sourceRef, type: 'main', confidence: 1, createdAt: now, createdBy: 'ai' },
        },
        {
          id: 'b',
          content: '产品设计与管理',
          children: [
            { id: 'b1', content: '需求挖掘与分析', meta: { sourceRef, type: 'detail', confidence: 1, createdAt: now, createdBy: 'ai' } },
          ],
          meta: { sourceRef, type: 'main', confidence: 1, createdAt: now, createdBy: 'ai' },
        },
      ],
      meta: { sourceRef, type: 'main', confidence: 1, createdAt: now, createdBy: 'ai' },
    },
    meta: {
      title: 'AI产品经理能力图谱',
      sourceType: 'text',
      createdAt: now,
      updatedAt: now,
      version: 1,
      truncated: false,
    },
  };
}

describe('treeToOutlineDoc', () => {
  it('生成扁平大纲：根节点单独呈现，条目 depth 从 1 递增', () => {
    const doc = treeToOutlineDoc(buildTree());

    expect(doc.rootId).toBe('root');
    expect(doc.title).toBe('AI产品经理能力图谱');
    expect(doc.rootContent).toBe('AI产品经理需要掌握的能力');

    expect(doc.items.map((item) => [item.nodeId, item.depth])).toEqual([
      ['a', 1],
      ['a1', 2],
      ['a1x', 3],
      ['a1y', 3],
      ['b', 1],
      ['b1', 2],
    ]);
  });

  it('忽略 collapsed 状态，展开全部节点', () => {
    const tree = buildTree();
    tree.root.children![0].collapsed = true;
    const doc = treeToOutlineDoc(tree);
    expect(doc.items.some((item) => item.nodeId === 'a1x')).toBe(true);
  });
});

describe('outlineDocToTree', () => {
  it('round-trip：树 → 大纲 → 树 后结构与内容完全一致', () => {
    const tree = buildTree();
    expect(outlineRoundTripLossless(tree)).toBe(true);
  });

  it('保留节点 meta/style 字段（内容完整性）', () => {
    const tree = buildTree();
    const doc = treeToOutlineDoc(tree);
    const rebuilt = outlineDocToTree(doc, tree);

    const originalA1 = tree.root.children![0].children![0];
    const rebuiltA1 = rebuilt.root.children![0].children![0];
    expect(rebuiltA1.meta.type).toBe(originalA1.meta.type);
    expect(rebuiltA1.meta.createdBy).toBe(originalA1.meta.createdBy);
  });

  it('容错：depth 跳级时提升到最近合法层级而不是抛错', () => {
    const tree = buildTree();
    const doc = treeToOutlineDoc(tree);
    doc.items = [
      { nodeId: 'x1', content: '一级', depth: 1 },
      { nodeId: 'x2', content: '非法跳级', depth: 5 },
    ];
    const rebuilt = outlineDocToTree(doc, tree);
    // depth 5 被钳制到 depth 2，挂在 x1 之下
    expect(rebuilt.root.children![0].children![0].id).toBe('x2');
  });

  it('根节点内容编辑能同步到重建后的树', () => {
    const tree = buildTree();
    const doc = treeToOutlineDoc(tree);
    doc.rootContent = '新标题';
    const rebuilt = outlineDocToTree(doc, tree);
    expect(rebuilt.root.content).toBe('新标题');
  });
});

describe('outlineNodeExists', () => {
  it('能定位存在的节点', () => {
    const tree = buildTree();
    expect(outlineNodeExists(tree, 'a1y')).toBe(true);
    expect(outlineNodeExists(tree, 'missing')).toBe(false);
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import type { MindMapNode, MindMapTree } from '../lib/types/mindmap';
import { useMindMapStore } from '../store/mindmap-store';
import { findNode } from '../lib/utils/tree';

function makeNode(id: string, content: string, children: MindMapNode[] = []): MindMapNode {
  const now = Date.now();
  return {
    id,
    content,
    collapsed: false,
    children,
    meta: {
      sourceRef: { type: 'text', text: content },
      createdAt: now,
      createdBy: 'user',
      type: 'detail',
    },
  };
}

function sampleTree(): MindMapTree {
  const now = Date.now();
  return {
    id: 'tree',
    root: makeNode('root', 'Root', [makeNode('parent', 'Parent', [makeNode('child', 'Child')])]),
    meta: {
      sourceType: 'text',
      title: 'demo',
      createdAt: now,
      updatedAt: now,
      version: 1,
      truncated: false,
    },
  };
}

function resetStore(tree: MindMapTree | null, selectedNodeId: string | null = null): void {
  useMindMapStore.setState({
    tree,
    selectedNodeId,
    pending: false,
    layoutDirection: 'LR',
    past: [],
    future: [],
    canUndo: false,
    canRedo: false,
  });
}

afterEach(() => {
  resetStore(null);
});

describe('mindmap store AI helpers', () => {
  it('addAiChildren inserts all children as one undo step', () => {
    resetStore(sampleTree(), 'root');

    const ids = useMindMapStore.getState().addAiChildren('root', ['分支一', '分支二', '分支三']);
    expect(ids).toHaveLength(3);

    const tree = useMindMapStore.getState().tree!;
    ids.forEach((id, i) => {
      expect(findNode(tree.root, id)?.content).toBe(`分支${['一', '二', '三'][i]}`);
    });
    expect(tree.root.children).toHaveLength(4);

    useMindMapStore.getState().undo();

    const undone = useMindMapStore.getState().tree!;
    ids.forEach((id) => {
      expect(findNode(undone.root, id)).toBeUndefined();
    });
    expect(undone.root.children).toHaveLength(1);
  });

  it('addAiChildren marks generated nodes as AI created', () => {
    resetStore(sampleTree(), 'root');

    const [id] = useMindMapStore.getState().addAiChildren('root', ['AI 节点']);
    const node = findNode(useMindMapStore.getState().tree!.root, id!)!;

    expect(node.meta.createdBy).toBe('ai');
    expect(node.meta.sourceRef.type).toBe('text');
  });

  it('addAiChildren ignores empty and oversized input', () => {
    resetStore(sampleTree(), 'root');

    const ids = useMindMapStore.getState().addAiChildren('root', ['  ', '', 'x'.repeat(200)]);
    expect(ids).toHaveLength(1);
    expect(findNode(useMindMapStore.getState().tree!.root, ids[0])!.content).toHaveLength(120);
  });

  it('addAiChildren returns empty for unknown parent', () => {
    resetStore(sampleTree(), 'root');

    const ids = useMindMapStore.getState().addAiChildren('missing', ['分支']);
    expect(ids).toHaveLength(0);
    expect(useMindMapStore.getState().canUndo).toBe(false);
  });

  it('replaceTreeKeepHistory keeps the previous tree as a single undo entry', () => {
    resetStore(sampleTree(), 'root');
    const before = useMindMapStore.getState().tree!;

    const optimized = sampleTree();
    optimized.root = makeNode('new-root', 'Optimized Root', [makeNode('n1', 'One')]);
    useMindMapStore.getState().replaceTreeKeepHistory(optimized);

    expect(useMindMapStore.getState().tree!.root.content).toBe('Optimized Root');
    expect(useMindMapStore.getState().canUndo).toBe(true);

    useMindMapStore.getState().undo();

    const restored = useMindMapStore.getState().tree!;
    expect(restored).toBe(before);
    expect(useMindMapStore.getState().canRedo).toBe(true);
  });

  it('replaceTreeKeepHistory resets history for a different tree id', () => {
    resetStore(sampleTree(), 'root');

    const other = sampleTree();
    other.id = 'other-tree';
    useMindMapStore.getState().replaceTreeKeepHistory(other);

    expect(useMindMapStore.getState().canUndo).toBe(false);
    expect(useMindMapStore.getState().canRedo).toBe(false);
  });
});

describe('mindmap store applyAiGenerationPatches', () => {
  function addPatch(parentId: string, node: MindMapNode) {
    return { type: 'add', nodeId: node.id, parentId, index: 0, node, timestamp: Date.now() } as const;
  }

  it('applies patches without polluting the undo history', () => {
    resetStore(sampleTree(), 'root');

    useMindMapStore
      .getState()
      .applyAiGenerationPatches([addPatch('root', makeNode('ai-1', 'AI 回放节点'))]);

    const state = useMindMapStore.getState();
    expect(findNode(state.tree!.root, 'ai-1')).toBeTruthy();
    // 不入 undo 历史：生成回放是系统行为
    expect(state.past).toHaveLength(0);
    expect(state.canUndo).toBe(false);

    // undo 无历史可回退，AI 节点保留
    state.undo();
    expect(findNode(useMindMapStore.getState().tree!.root, 'ai-1')).toBeTruthy();
  });

  it('skips add patches whose nodeId already exists (幂等守卫)', () => {
    resetStore(sampleTree(), 'root');
    const before = useMindMapStore.getState().tree;

    // sampleTree 已含 'child'（parent 下的子节点）
    useMindMapStore.getState().applyAiGenerationPatches([addPatch('parent', makeNode('child', '重复节点'))]);

    const after = useMindMapStore.getState().tree;
    expect(after).toBe(before);
    expect(after!.root.children![0].children).toHaveLength(1);
    expect(after!.root.children![0].children![0].content).toBe('Child');
  });

  it('is a no-op when there is no tree or no patches', () => {
    resetStore(null);

    expect(() =>
      useMindMapStore.getState().applyAiGenerationPatches([addPatch('root', makeNode('x', 'X'))]),
    ).not.toThrow();
    expect(useMindMapStore.getState().tree).toBeNull();

    resetStore(sampleTree(), 'root');
    const before = useMindMapStore.getState().tree;
    useMindMapStore.getState().applyAiGenerationPatches([]);
    expect(useMindMapStore.getState().tree).toBe(before);
  });
});

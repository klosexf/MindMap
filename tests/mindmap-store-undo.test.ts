import { afterEach, describe, expect, it } from 'vitest';

import type { MindMapNode, MindMapTree, TreePatch } from '../lib/types/mindmap';
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

function makeAddPatch(parentId: string, id: string, content: string): TreePatch {
  const now = Date.now();
  return {
    type: 'add',
    nodeId: id,
    parentId,
    index: 999,
    node: makeNode(id, content),
    timestamp: now,
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

describe('mindmap store undo/redo', () => {
  it('undoes an added child node back to the previous tree', () => {
    resetStore(sampleTree(), 'root');
    const before = useMindMapStore.getState().tree!;

    const newId = useMindMapStore.getState().addChildNode('root', 'new branch');
    expect(newId).toBeTruthy();
    expect(useMindMapStore.getState().canUndo).toBe(true);
    expect(useMindMapStore.getState().canRedo).toBe(false);

    useMindMapStore.getState().undo();

    const after = useMindMapStore.getState().tree!;
    expect(findNode(after.root, newId as string)).toBeUndefined();
    expect(after.root.children?.length).toBe(before.root.children!.length);
    expect(after.meta.version).toBe(before.meta.version);
    expect(useMindMapStore.getState().canUndo).toBe(false);
  });

  it('redoes an undone add', () => {
    resetStore(sampleTree(), 'root');
    const newId = useMindMapStore.getState().addChildNode('root', 'new branch') as string;

    useMindMapStore.getState().undo();
    useMindMapStore.getState().redo();

    const tree = useMindMapStore.getState().tree!;
    expect(findNode(tree.root, newId)?.content).toBe('new branch');
    expect(useMindMapStore.getState().canUndo).toBe(true);
    expect(useMindMapStore.getState().canRedo).toBe(false);
  });

  it('clears the redo stack after a new edit follows an undo', () => {
    resetStore(sampleTree(), 'root');
    useMindMapStore.getState().addChildNode('root', 'first');
    useMindMapStore.getState().undo();
    expect(useMindMapStore.getState().canRedo).toBe(true);

    useMindMapStore.getState().addChildNode('root', 'second');

    expect(useMindMapStore.getState().canRedo).toBe(false);
    useMindMapStore.getState().redo();
    expect(useMindMapStore.getState().tree!.root.children?.length).toBe(2);
  });

  it('restores node content on undo', () => {
    resetStore(sampleTree(), 'parent');

    useMindMapStore.getState().updateNodeContent('parent', 'changed');
    expect(useMindMapStore.getState().tree!.root.children![0].content).toBe('changed');

    useMindMapStore.getState().undo();

    expect(useMindMapStore.getState().tree!.root.children![0].content).toBe('Parent');
  });

  it('restores the node and selection when undoing a delete', () => {
    resetStore(sampleTree(), 'child');

    useMindMapStore.getState().deleteNode('child');
    expect(useMindMapStore.getState().selectedNodeId).toBe('parent');
    expect(findNode(useMindMapStore.getState().tree!.root, 'child')).toBeUndefined();

    useMindMapStore.getState().undo();

    const tree = useMindMapStore.getState().tree!;
    expect(findNode(tree.root, 'child')?.content).toBe('Child');
    expect(useMindMapStore.getState().selectedNodeId).toBe('child');
  });

  it('treats a patch batch as a single undo step', () => {
    resetStore(sampleTree(), 'root');

    useMindMapStore.getState().applyPatches([
      makeAddPatch('root', 'batch-1', 'Batch One'),
      makeAddPatch('root', 'batch-2', 'Batch Two'),
    ]);
    const tree = useMindMapStore.getState().tree!;
    expect(findNode(tree.root, 'batch-1')).toBeDefined();
    expect(findNode(tree.root, 'batch-2')).toBeDefined();

    useMindMapStore.getState().undo();

    const undone = useMindMapStore.getState().tree!;
    expect(findNode(undone.root, 'batch-1')).toBeUndefined();
    expect(findNode(undone.root, 'batch-2')).toBeUndefined();
  });

  it('does not record history for no-op patches', () => {
    resetStore(sampleTree(), 'root');

    useMindMapStore.getState().applyPatch(makeAddPatch('missing-parent', 'ghost', 'Ghost'));

    expect(useMindMapStore.getState().canUndo).toBe(false);
    expect(useMindMapStore.getState().tree!.meta.version).toBe(1);
  });

  it('clears history when a new tree is loaded', () => {
    resetStore(sampleTree(), 'root');
    useMindMapStore.getState().addChildNode('root', 'temp');
    expect(useMindMapStore.getState().canUndo).toBe(true);

    useMindMapStore.getState().setTree(sampleTree());

    expect(useMindMapStore.getState().canUndo).toBe(false);
    expect(useMindMapStore.getState().canRedo).toBe(false);
    useMindMapStore.getState().undo();
    expect(useMindMapStore.getState().tree!.root.children?.length).toBe(1);
  });

  it('caps history depth at 50 entries', () => {
    resetStore(sampleTree(), 'root');

    for (let i = 0; i < 55; i += 1) {
      useMindMapStore.getState().updateNodeContent('parent', `content-${i}`);
    }
    expect(useMindMapStore.getState().tree!.meta.version).toBe(56);

    for (let i = 0; i < 50; i += 1) {
      useMindMapStore.getState().undo();
    }
    expect(useMindMapStore.getState().tree!.meta.version).toBe(6);
    expect(useMindMapStore.getState().canUndo).toBe(false);

    useMindMapStore.getState().undo();
    expect(useMindMapStore.getState().tree!.meta.version).toBe(6);
  });

  it('undo and redo are safe no-ops with empty stacks', () => {
    resetStore(sampleTree(), 'root');

    useMindMapStore.getState().undo();
    useMindMapStore.getState().redo();

    expect(useMindMapStore.getState().tree!.meta.version).toBe(1);
    expect(useMindMapStore.getState().canUndo).toBe(false);
    expect(useMindMapStore.getState().canRedo).toBe(false);
  });

  it('supports undo after redo within the same history line', () => {
    resetStore(sampleTree(), 'root');
    const stepId = useMindMapStore.getState().addChildNode('root', 'step-1') as string;
    useMindMapStore.getState().undo();
    useMindMapStore.getState().redo();
    expect(findNode(useMindMapStore.getState().tree!.root, stepId)).toBeDefined();

    useMindMapStore.getState().undo();
    expect(findNode(useMindMapStore.getState().tree!.root, stepId)).toBeUndefined();
    expect(useMindMapStore.getState().canRedo).toBe(true);
  });
});

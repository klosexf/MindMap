import { afterEach, describe, expect, it } from 'vitest';

import { treePatchSchema } from '../lib/types/mindmap';
import { applyTreePatch } from '../lib/utils/tree';
import type { MindMapTree } from '../lib/types/mindmap';
import { useMindMapStore } from '../store/mindmap-store';

function sampleTree(): MindMapTree {
  const now = Date.now();
  return {
    id: 'tree',
    root: {
      id: 'root',
      content: 'Root',
      collapsed: false,
      meta: {
        sourceRef: { type: 'text', text: 'root' },
        createdAt: now,
        createdBy: 'ai',
        type: 'main',
      },
      children: [
        {
          id: 'child',
          content: 'Child',
          collapsed: false,
          meta: {
            sourceRef: { type: 'text', text: 'child' },
            createdAt: now,
            createdBy: 'user',
            type: 'detail',
          },
          children: [],
        },
      ],
    },
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

afterEach(() => {
  useMindMapStore.setState({
    tree: null,
    selectedNodeId: null,
    pending: false,
    layoutDirection: 'LR',
  });
});

describe('node note data layer', () => {
  it('applyTreePatch 写入 note 并可整体撤销', () => {
    const tree = sampleTree();
    const withNote = applyTreePatch(tree, {
      type: 'update',
      nodeId: 'child',
      node: { note: { content: '第一条笔记', createdAt: 1, updatedAt: 1 } },
      timestamp: Date.now(),
    });

    const child = withNote.root.children![0];
    expect(child.note?.content).toBe('第一条笔记');

    // 撤销等价于反向 patch：note: undefined 清除笔记
    const reverted = applyTreePatch(withNote, {
      type: 'update',
      nodeId: 'child',
      node: { note: undefined },
      timestamp: Date.now(),
    });
    expect(reverted.root.children![0].note).toBeUndefined();
  });

  it('note update patch 通过 zod 校验', () => {
    const result = treePatchSchema.safeParse({
      type: 'update',
      nodeId: 'child',
      node: { note: { content: 'hello', createdAt: 1, updatedAt: 2 } },
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('note 内容超长时校验失败', () => {
    const result = treePatchSchema.safeParse({
      type: 'update',
      nodeId: 'child',
      node: { note: { content: 'x'.repeat(20001), createdAt: 1, updatedAt: 1 } },
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });
});

describe('mindmap store updateNodeNote', () => {
  it('保存笔记并支持 undo 恢复', () => {
    useMindMapStore.setState({ tree: sampleTree(), layoutDirection: 'LR' });

    const store = useMindMapStore.getState();
    store.updateNodeNote('child', { content: '我的笔记' });

    const afterSave = useMindMapStore.getState();
    expect(afterSave.tree!.root.children![0].note?.content).toBe('我的笔记');
    expect(afterSave.canUndo).toBe(true);

    afterSave.undo();
    expect(useMindMapStore.getState().tree!.root.children![0].note).toBeUndefined();
  });

  it('再次保存保留 createdAt，删除笔记置空', () => {
    useMindMapStore.setState({ tree: sampleTree(), layoutDirection: 'LR' });

    const store = useMindMapStore.getState();
    store.updateNodeNote('child', { content: 'v1' });
    const createdAt = useMindMapStore.getState().tree!.root.children![0].note!.createdAt;

    store.updateNodeNote('child', { content: 'v2' });
    const updated = useMindMapStore.getState().tree!.root.children![0].note!;
    expect(updated.content).toBe('v2');
    expect(updated.createdAt).toBe(createdAt);

    store.updateNodeNote('child', null);
    expect(useMindMapStore.getState().tree!.root.children![0].note).toBeUndefined();
  });
});

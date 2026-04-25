'use client';

import { create } from 'zustand';

import type { MindMapTree, TreePatch } from '@/lib/types/mindmap';
import { applyTreePatch, findNode } from '@/lib/utils/tree';

interface MindMapState {
  tree: MindMapTree | null;
  selectedNodeId: string | null;
  pending: boolean;
  setPending: (pending: boolean) => void;
  setTree: (tree: MindMapTree | null) => void;
  applyPatch: (patch: TreePatch) => void;
  setSelectedNode: (id: string | null) => void;
  updateNodeContent: (id: string, content: string) => void;
  toggleNodeCollapse: (id: string) => void;
  addChildNode: (parentId: string, content: string) => void;
  addSiblingNode: (nodeId: string, content: string) => void;
  deleteNode: (nodeId: string) => void;
}

function sourceRefFromTree(tree: MindMapTree) {
  return {
    type: tree.meta.sourceType,
    location: tree.meta.sourceFileName,
    url: tree.meta.sourceUrl,
  } as const;
}

export const useMindMapStore = create<MindMapState>((set, get) => ({
  tree: null,
  selectedNodeId: null,
  pending: false,
  setPending: (pending) => set({ pending }),
  setTree: (tree) => set({ tree }),
  applyPatch: (patch) => {
    const current = get().tree;
    if (!current) return;

    const next = applyTreePatch(current, patch);
    set({ tree: next });
  },
  setSelectedNode: (id) => set({ selectedNodeId: id }),
  updateNodeContent: (id, content) => {
    get().applyPatch({
      type: 'update',
      nodeId: id,
      node: { content },
      timestamp: Date.now(),
    });
  },
  toggleNodeCollapse: (id) => {
    get().applyPatch({
      type: 'toggleCollapse',
      nodeId: id,
      timestamp: Date.now(),
    });
  },
  addChildNode: (parentId, content) => {
    const tree = get().tree;
    if (!tree) return;

    const parent = findNode(tree.root, parentId);
    const childrenLen = parent?.children?.length ?? 0;

    get().applyPatch({
      type: 'add',
      nodeId: crypto.randomUUID(),
      parentId,
      index: childrenLen,
      node: {
        id: crypto.randomUUID(),
        content,
        collapsed: false,
        children: [],
        meta: {
          sourceRef: sourceRefFromTree(tree),
          type: 'detail',
          confidence: 1,
          createdAt: Date.now(),
          createdBy: 'user',
        },
      },
      timestamp: Date.now(),
    });
  },
  addSiblingNode: (nodeId, content) => {
    const tree = get().tree;
    if (!tree || tree.root.id === nodeId) return;

    function findParent(node: MindMapTree['root'], targetId: string): { parentId: string; index: number } | null {
      if (!node.children?.length) return null;
      const idx = node.children.findIndex((child) => child.id === targetId);
      if (idx >= 0) return { parentId: node.id, index: idx + 1 };

      for (const child of node.children) {
        const found = findParent(child, targetId);
        if (found) return found;
      }

      return null;
    }

    const parentInfo = findParent(tree.root, nodeId);
    if (!parentInfo) return;

    get().applyPatch({
      type: 'add',
      nodeId: crypto.randomUUID(),
      parentId: parentInfo.parentId,
      index: parentInfo.index,
      node: {
        id: crypto.randomUUID(),
        content,
        collapsed: false,
        children: [],
        meta: {
          sourceRef: sourceRefFromTree(tree),
          type: 'detail',
          confidence: 1,
          createdAt: Date.now(),
          createdBy: 'user',
        },
      },
      timestamp: Date.now(),
    });
  },
  deleteNode: (nodeId) => {
    const tree = get().tree;
    if (!tree || tree.root.id === nodeId) return;

    get().applyPatch({
      type: 'delete',
      nodeId,
      timestamp: Date.now(),
    });
  },
}));

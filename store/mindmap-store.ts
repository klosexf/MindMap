'use client';

import { create } from 'zustand';

import type { LayoutDirection, MindMapTree, TreePatch } from '@/lib/types/mindmap';
import { applyTreePatch, balanceChildren, findNode } from '@/lib/utils/tree';

interface MindMapState {
  tree: MindMapTree | null;
  selectedNodeId: string | null;
  pending: boolean;
  layoutDirection: LayoutDirection;
  setPending: (pending: boolean) => void;
  setTree: (tree: MindMapTree | null) => void;
  applyPatch: (patch: TreePatch) => void;
  setSelectedNode: (id: string | null) => void;
  updateNodeContent: (id: string, content: string) => void;
  toggleNodeCollapse: (id: string) => void;
  addChildNode: (parentId: string, content: string) => string | void;
  addSiblingNode: (nodeId: string, content: string) => string | void;
  deleteNode: (nodeId: string) => void;
  setLayoutDirection: (direction: LayoutDirection) => void;
  moveNode: (nodeId: string, newParentId: string, index?: number) => void;
  balanceLayout: () => void;
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
  layoutDirection: 'LR' as LayoutDirection,
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
    const newId = crypto.randomUUID();

    get().applyPatch({
      type: 'add',
      nodeId: newId,
      parentId,
      index: childrenLen,
      node: {
        id: newId,
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

    return newId;
  },
  addSiblingNode: (nodeId, content) => {
    const tree = get().tree;
    if (!tree || tree.root.id === nodeId) return;

    function findParentInfo(node: MindMapTree['root'], targetId: string): { parentId: string; index: number } | null {
      if (!node.children?.length) return null;
      const idx = node.children.findIndex((child) => child.id === targetId);
      if (idx >= 0) return { parentId: node.id, index: idx + 1 };

      for (const child of node.children) {
        const found = findParentInfo(child, targetId);
        if (found) return found;
      }

      return null;
    }

    const parentInfo = findParentInfo(tree.root, nodeId);
    if (!parentInfo) return;

    const newId = crypto.randomUUID();

    get().applyPatch({
      type: 'add',
      nodeId: newId,
      parentId: parentInfo.parentId,
      index: parentInfo.index,
      node: {
        id: newId,
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

    return newId;
  },
  deleteNode: (nodeId) => {
    const tree = get().tree;
    if (!tree || tree.root.id === nodeId) return;

    get().applyPatch({
      type: 'delete',
      nodeId,
      timestamp: Date.now(),
    });

    // Reset selection if the deleted node was selected
    const selected = get().selectedNodeId;
    if (selected === nodeId) {
      const updatedTree = get().tree;
      if (updatedTree) {
        function findParent(n: MindMapTree['root'], targetId: string): string | null {
          if (!n.children?.length) return null;
          if (n.children.some((c) => c.id === targetId)) return n.id;
          for (const c of n.children) {
            const p = findParent(c, targetId);
            if (p) return p;
          }
          return null;
        }
        const parentId = findParent(updatedTree.root, nodeId);
        set({ selectedNodeId: parentId || updatedTree.root.id });
      }
    }
  },
  setLayoutDirection: (direction) => set({ layoutDirection: direction }),
  moveNode: (nodeId, newParentId, index = 0) => {
    get().applyPatch({
      type: 'move',
      nodeId,
      newParentId,
      newIndex: index,
      timestamp: Date.now(),
    });
  },
  balanceLayout: () => {
    const current = get().tree;
    if (!current) return;

    const next = balanceChildren(current);
    set({ tree: next });
  },
}));

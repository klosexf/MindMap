'use client';

import { create } from 'zustand';

import type { LayoutDirection, MindMapTree, NodePosition, TreePatch } from '@/lib/types/mindmap';
import { applyTreePatch, createNode, findNode, findParentInfo } from '@/lib/utils/tree';

const MAX_HISTORY_ENTRIES = 50;

interface HistoryEntry {
  tree: MindMapTree;
  selectedNodeId: string | null;
}

interface MindMapState {
  tree: MindMapTree | null;
  selectedNodeId: string | null;
  pending: boolean;
  layoutDirection: LayoutDirection;
  past: HistoryEntry[];
  future: HistoryEntry[];
  canUndo: boolean;
  canRedo: boolean;
  setPending: (pending: boolean) => void;
  setTree: (tree: MindMapTree | null) => void;
  applyPatch: (patch: TreePatch) => void;
  applyPatches: (patches: TreePatch[]) => void;
  undo: () => void;
  redo: () => void;
  setSelectedNode: (id: string | null) => void;
  updateNodeContent: (id: string, content: string) => void;
  toggleNodeCollapse: (id: string) => void;
  addChildNode: (parentId: string, content: string) => string | void;
  addAiChildren: (parentId: string, contents: string[]) => string[];
  replaceTreeKeepHistory: (tree: MindMapTree) => void;
  addSiblingNode: (nodeId: string, content: string) => string | void;
  deleteNode: (nodeId: string) => void;
  setLayoutDirection: (direction: LayoutDirection) => void;
  moveNode: (nodeId: string, newParentId: string, index?: number) => void;
  updateNodePosition: (nodeId: string, position: NodePosition) => void;
}

function sourceRefFromTree(tree: MindMapTree) {
  return {
    type: tree.meta.sourceType,
    location: tree.meta.sourceFileName,
    url: tree.meta.sourceUrl,
  } as const;
}

function buildHistoryPush(state: {
  tree: MindMapTree | null;
  selectedNodeId: string | null;
  past: HistoryEntry[];
}): { past: HistoryEntry[]; future: HistoryEntry[]; canUndo: boolean; canRedo: boolean } | null {
  const { tree, selectedNodeId, past } = state;
  if (!tree) return null;

  const entry: HistoryEntry = { tree, selectedNodeId };
  return {
    past: [...past, entry].slice(-MAX_HISTORY_ENTRIES),
    future: [],
    canUndo: true,
    canRedo: false,
  };
}

export const useMindMapStore = create<MindMapState>((set, get) => ({
  tree: null,
  selectedNodeId: null,
  pending: false,
  layoutDirection: 'LR' as LayoutDirection,
  past: [],
  future: [],
  canUndo: false,
  canRedo: false,
  setPending: (pending) => set({ pending }),
  // Loading a (new) tree starts a fresh history line.
  setTree: (tree) =>
    set({ tree, past: [], future: [], canUndo: false, canRedo: false }),
  applyPatch: (patch) => {
    get().applyPatches([patch]);
  },
  applyPatches: (patches) => {
    const state = get();
    const current = state.tree;
    if (!current || patches.length === 0) return;

    const startVersion = current.meta.version;
    let next = current;
    for (const patch of patches) {
      next = applyTreePatch(next, patch);
    }

    // applyTreePatch keeps the version on no-op patches; those should not
    // pollute the undo stack with entries that "undo" nothing.
    const history =
      next.meta.version !== startVersion ? buildHistoryPush(state) : null;

    set(history ? { tree: next, ...history } : { tree: next });
  },
  undo: () => {
    const state = get();
    const { past, future, tree, selectedNodeId } = state;
    if (!tree || past.length === 0) return;

    const previous = past[past.length - 1];
    const current: HistoryEntry = { tree, selectedNodeId };

    set({
      tree: previous.tree,
      selectedNodeId: previous.selectedNodeId,
      past: past.slice(0, -1),
      future: [current, ...future].slice(0, MAX_HISTORY_ENTRIES),
      canUndo: past.length > 1,
      canRedo: true,
    });
  },
  redo: () => {
    const state = get();
    const { past, future, tree, selectedNodeId } = state;
    if (!tree || future.length === 0) return;

    const nextEntry = future[0];
    const current: HistoryEntry = { tree, selectedNodeId };

    set({
      tree: nextEntry.tree,
      selectedNodeId: nextEntry.selectedNodeId,
      past: [...past, current].slice(-MAX_HISTORY_ENTRIES),
      future: future.slice(1),
      canUndo: true,
      canRedo: future.length > 1,
    });
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
  // Batch-insert AI generated children as a single undo step: all add
  // patches flow through one applyPatches call so undo() reverts them together.
  addAiChildren: (parentId, contents) => {
    const tree = get().tree;
    if (!tree) return [];

    const parent = findNode(tree.root, parentId);
    if (!parent) return [];

    const cleaned = contents
      .map((content) => content.trim().slice(0, 120))
      .filter((content) => content.length > 0)
      .slice(0, 12);
    if (cleaned.length === 0) return [];

    const sourceRef = sourceRefFromTree(tree);
    let index = parent.children?.length ?? 0;
    const patches: TreePatch[] = cleaned.map((content) => {
      const node = createNode(content, sourceRef, 'ai');
      const patch: TreePatch = {
        type: 'add',
        nodeId: node.id,
        parentId,
        index,
        node,
        timestamp: Date.now(),
      };
      index += 1;
      return patch;
    });

    get().applyPatches(patches);
    return patches.map((patch) => patch.nodeId);
  },
  // Replace the whole tree (e.g. after an AI optimize pass) while keeping the
  // previous tree as a single undo entry instead of resetting the history line.
  replaceTreeKeepHistory: (nextTree) => {
    const state = get();
    if (!state.tree || state.tree.id !== nextTree.id) {
      set({ tree: nextTree, past: [], future: [], canUndo: false, canRedo: false });
      return;
    }

    const history = buildHistoryPush(state);
    set(history ? { tree: nextTree, ...history } : { tree: nextTree });
  },
  addSiblingNode: (nodeId, content) => {
    const tree = get().tree;
    if (!tree || tree.root.id === nodeId) return;

    const parentInfo = findParentInfo(tree.root, nodeId);
    if (!parentInfo) return;

    const newId = crypto.randomUUID();

    get().applyPatch({
      type: 'add',
      nodeId: newId,
      parentId: parentInfo.parentId,
      index: parentInfo.index + 1,
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
    const parentInfo = findParentInfo(tree.root, nodeId);

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
        set({ selectedNodeId: parentInfo?.parentId || updatedTree.root.id });
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
  updateNodePosition: (nodeId, position) => {
    get().applyPatch({
      type: 'position',
      nodeId,
      position,
      timestamp: Date.now(),
    });
  },
}));

'use client';

import { create } from 'zustand';

import type { LayoutDirection, MindMapTree, NodeNote, NodePosition, TreePatch } from '@/lib/types/mindmap';
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
  /** 实时生成回放专用：走 applyTreePatch 但不入 undo 历史（含 add 幂等守卫） */
  applyAiGenerationPatches: (patches: TreePatch[]) => void;
  undo: () => void;
  redo: () => void;
  setSelectedNode: (id: string | null) => void;
  updateNodeContent: (id: string, content: string) => void;
  updateNodeNote: (id: string, note: { content: string } | null) => void;
  toggleNodeCollapse: (id: string) => void;
  addChildNode: (parentId: string, content: string) => string | void;
  addAiChildren: (parentId: string, contents: string[]) => string[];
  /** AI 分支扩展流式回放结束后提交撤销快照：整体保持单步可撤销 */
  commitHistorySnapshot: (snapshot: { tree: MindMapTree; selectedNodeId: string | null }) => void;
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
  applyAiGenerationPatches: (patches) => {
    const state = get();
    const current = state.tree;
    if (!current || patches.length === 0) return;

    let next = current;
    for (const patch of patches) {
      // 幂等守卫：启发式路径 skeleton 已含全树，node 事件会重发同 id 节点
      if (patch.type === 'add' && findNode(next.root, patch.nodeId)) continue;
      next = applyTreePatch(next, patch);
    }

    // 不入 undo 历史：生成回放是系统行为；complete/树替换会重置历史线
    set({ tree: next });
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
  // note 传 null 表示删除笔记（patch 中 note: undefined，Object.assign 后即清除）
  updateNodeNote: (id, note) => {
    const existing = get().tree ? findNode(get().tree!.root, id) : undefined;
    const now = Date.now();
    get().applyPatch({
      type: 'update',
      nodeId: id,
      node: {
        note: note
          ? {
              content: note.content,
              createdAt: existing?.note?.createdAt ?? now,
              updatedAt: now,
            }
          : undefined,
      },
      timestamp: now,
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
  // AI 分支扩展流式回放：打字机补丁经 applyAiGenerationPatches 直写（不入栈），
  // 回放结束后由会话调用本方法把「扩展前」快照一次性压入 past，整体单步可撤销。
  commitHistorySnapshot: (snapshot) => {
    const state = get();
    const current = state.tree;
    // 树已切换（用户离开该导图）或无实际变更时不入栈
    if (!current || current.id !== snapshot.tree.id || current === snapshot.tree) return;

    set({
      past: [...state.past, { tree: snapshot.tree, selectedNodeId: snapshot.selectedNodeId }].slice(
        -MAX_HISTORY_ENTRIES,
      ),
      future: [],
      canUndo: true,
      canRedo: false,
    });
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

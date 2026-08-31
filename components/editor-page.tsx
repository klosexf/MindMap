'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import { EditorToolbar, type AiOptimizeMode } from '@/components/editor-toolbar';
import { AiSummaryPanel } from '@/components/ai-summary-panel';
import { GenerationBanner } from '@/components/generation-banner';
import { MindMapEditor, type MindMapEditorRef, type NodeClientRect } from '@/components/mindmap-editor';
import { NodeActionToolbar } from '@/components/node-action-toolbar';
import { NodeAiMenu } from '@/components/node-ai-menu';
import { NodeNotePanel } from '@/components/node-note-panel';
import { OutlineView } from '@/components/outline-view';
import { ViewModeToggle, VIEW_MODE_STORAGE_KEY, type EditorViewMode } from '@/components/view-mode-toggle';
import type { MindMapTree, NodePosition, NormalizedDocument } from '@/lib/types/mindmap';
import { buildPresentationSteps, collapseAllForPresentation } from '@/lib/utils/presentation';
import { findNode } from '@/lib/utils/tree';
import { adoptSessionTree } from '@/lib/streaming/generation-session';
import { startBranchExpansion } from '@/lib/streaming/branch-expansion-session';
import { isActiveGenerationForTree, useGenerationStore } from '@/store/generation-store';
import { useMindMapStore } from '@/store/mindmap-store';

interface EditorPageProps {
  id: string;
}

interface AddNodeAndEditOptions {
  centerInViewport?: boolean;
}

function downloadBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

export function EditorPage({ id }: EditorPageProps) {
  const editorRef = useRef<MindMapEditorRef | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [normalizedDocument, setNormalizedDocument] = useState<NormalizedDocument | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const savedVersionRef = useRef<number>(0);
  const queuedSaveRef = useRef<MindMapTree | null>(null);
  const saveInFlightRef = useRef(false);

  const tree = useMindMapStore((s) => s.tree);
  const selectedNodeId = useMindMapStore((s) => s.selectedNodeId);
  const layoutDirection = useMindMapStore((s) => s.layoutDirection);
  const setTree = useMindMapStore((s) => s.setTree);
  const setSelectedNode = useMindMapStore((s) => s.setSelectedNode);
  const updateNodeContent = useMindMapStore((s) => s.updateNodeContent);
  const addChildNode = useMindMapStore((s) => s.addChildNode);
  const addSiblingNode = useMindMapStore((s) => s.addSiblingNode);
  const deleteNode = useMindMapStore((s) => s.deleteNode);
  const toggleNodeCollapse = useMindMapStore((s) => s.toggleNodeCollapse);
  const setLayoutDirection = useMindMapStore((s) => s.setLayoutDirection);
  const moveNode = useMindMapStore((s) => s.moveNode);
  const updateNodePosition = useMindMapStore((s) => s.updateNodePosition);
  const canUndo = useMindMapStore((s) => s.canUndo);
  const canRedo = useMindMapStore((s) => s.canRedo);
  const undo = useMindMapStore((s) => s.undo);
  const redo = useMindMapStore((s) => s.redo);
  const addAiChildren = useMindMapStore((s) => s.addAiChildren);
  const replaceTreeKeepHistory = useMindMapStore((s) => s.replaceTreeKeepHistory);
  const updateNodeNote = useMindMapStore((s) => s.updateNodeNote);

  // 节点交互：悬浮操作框（选中节点的屏幕矩形由 MindMapEditor rAF 上报）
  const [toolbarState, setToolbarState] = useState<{ nodeId: string; rect: NodeClientRect } | null>(null);
  const [notePanelNodeId, setNotePanelNodeId] = useState<string | null>(null);
  const [aiMenuNodeId, setAiMenuNodeId] = useState<string | null>(null);
  const notePanelDirtyRef = useRef(false);

  const [aiExpanding, setAiExpanding] = useState(false);
  // AI 分支扩展打字机节点（画布「生成中」高亮）
  const [aiTypingNodeId, setAiTypingNodeId] = useState<string | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeMode, setOptimizeMode] = useState<AiOptimizeMode>('simplify');

  // 演示模式：进入时全折叠（快照留底），按分支顺序逐步展开并聚焦画布
  const [presenting, setPresenting] = useState(false);
  const [presentationSteps, setPresentationSteps] = useState<string[] | null>(null);
  const [presentationStepIndex, setPresentationStepIndex] = useState(0);
  const presentationSnapshotRef = useRef<MindMapTree | null>(null);

  // 视图模式：导图 ↔ 文字大纲，偏好持久化到 localStorage
  const [viewMode, setViewMode] = useState<EditorViewMode>('mindmap');

  // 实时生成会话：treeId 匹配且非终态 → 生成中（编辑锁 + 横幅 + 会话领养）
  const genStatus = useGenerationStore((s) => s.status);
  const genTreeId = useGenerationStore((s) => s.treeId);
  const generating = isActiveGenerationForTree({ treeId: genTreeId, status: genStatus }, id);
  // 编辑锁：实时生成或 AI 分支扩展打字机回放期间，行内编辑/新增一律锁定
  const editorLocked = generating || aiExpanding;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
      if (saved === 'mindmap' || saved === 'outline') {
        setViewMode(saved);
      }
    } catch {
      /* localStorage 不可用时保持默认模式 */
    }
  }, []);

  const handleViewModeChange = useCallback((mode: EditorViewMode) => {
    setViewMode(mode);
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      /* 忽略持久化失败，模式切换仍然生效 */
    }
  }, []);

  const loadTree = useCallback(async () => {
    setLoading(true);
    setError(null);

    // 会话领养：活跃会话（streaming/paused）且 id 匹配时，跳过服务端 setTree，
    // 以会话工作树全量恢复（服务端骨架会覆盖已回放节点，该竞态在启发式路径下必现）。
    const sessionTree = adoptSessionTree(id);
    if (sessionTree) {
      setTree(sessionTree);
      savedVersionRef.current = sessionTree.meta.version;
      setDirty(false);
      // 仅补拉 normalizedDocument（AI 扩展/优化依赖），不 setTree
      try {
        const res = await fetch(`/api/mindmaps/${id}`);
        if (res.ok) {
          const json = (await res.json()) as { normalizedDocument?: NormalizedDocument };
          setNormalizedDocument(json.normalizedDocument ?? null);
        }
      } catch {
        // doc 拉取失败仅降级 AI 上下文功能，回放不受影响
      }
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`/api/mindmaps/${id}`);
      if (!res.ok) {
        const statusText = res.status === 404 ? '导图不存在' : `加载失败 (HTTP ${res.status})`;
        throw new Error(statusText);
      }

      const json = (await res.json()) as { tree: MindMapTree; normalizedDocument?: NormalizedDocument };
      if (!json.tree) {
        throw new Error('服务器返回的导图数据为空');
      }
      setTree(json.tree);
      setNormalizedDocument(json.normalizedDocument ?? null);
      // 不自动选中根节点：保持默认无选中状态，让方向键画布拖动等无选中交互开箱可用
      savedVersionRef.current = json.tree.meta.version;
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [id, setTree]);

  useEffect(() => {
    loadTree();
    return () => {
      // 活跃会话期间保留 store 树（会话循环仍在写），重进编辑器走「会话领养」恢复
      const gen = useGenerationStore.getState();
      const sessionActive = isActiveGenerationForTree(gen, id);
      if (!sessionActive) {
        setTree(null);
        setNormalizedDocument(null);
      }
    };
  }, [id, loadTree, setTree]);

  // Track dirty state when tree changes
  useEffect(() => {
    // 生成中抑制 dirty：回放造成的 version 变化是系统行为，不是未保存编辑
    if (generating) return;
    if (tree && tree.meta.version !== savedVersionRef.current) {
      setDirty(true);
    }
  }, [tree, generating]);

  // 生成结束（completed/stopped）时同步保存基线：终树已由服务端/停止保存落盘，
  // 避免闪现「未保存」；error 终态不同步（部分树未落盘，保留 dirty 提示用户手动保存）
  const wasGeneratingRef = useRef(false);
  useEffect(() => {
    if (generating) {
      wasGeneratingRef.current = true;
      return;
    }
    if (!wasGeneratingRef.current) return;
    wasGeneratingRef.current = false;
    if (tree && genTreeId === id && (genStatus === 'completed' || genStatus === 'stopped')) {
      savedVersionRef.current = tree.meta.version;
      setDirty(false);
    }
  }, [generating, tree, genTreeId, genStatus, id]);

  // Inline add node helpers
  const addNodeAndEdit = useCallback(
    (mode: 'child' | 'sibling', options?: AddNodeAndEditOptions) => {
      if (!selectedNodeId || !tree) return;

      const newId =
        mode === 'child'
          ? addChildNode(selectedNodeId, '')
          : addSiblingNode(selectedNodeId, '');
      if (!newId) return;

      setSelectedNode(newId);

      // 大纲模式下不唤起画布行内编辑，新节点以「空主题」出现在大纲中，双击即可编辑
      if (viewMode === 'outline') return;

      // Wait for React to commit tree changes and G6 to render the new node
      setTimeout(() => {
        editorRef.current?.startEditingNode(newId, options);
      }, 150);
    },
    [selectedNodeId, tree, viewMode, addChildNode, addSiblingNode, setSelectedNode],
  );

  const handleAddChild = useCallback(() => addNodeAndEdit('child'), [addNodeAndEdit]);
  const handleAddSibling = useCallback(() => addNodeAndEdit('sibling'), [addNodeAndEdit]);

  // Clean up newly created empty nodes when inline editing ends.
  // Only deletes the node when both original AND final text are empty,
  // so clearing an existing node's content does not accidentally delete it.
  const handleEditEnd = useCallback(
    (nodeId: string, _committed: boolean, finalText: string, originalText: string) => {
      if (!finalText.trim() && !originalText.trim()) {
        deleteNode(nodeId);
      }
    },
    [deleteNode],
  );

  const handleEnterWithoutText = useCallback(() => {
    addNodeAndEdit('child', { centerInViewport: true });
  }, [addNodeAndEdit]);

  const saveTreeSnapshot = useCallback(async (treeToSave: MindMapTree) => {
    queuedSaveRef.current = treeToSave;
    if (saveInFlightRef.current) return;

    saveInFlightRef.current = true;
    setSaving(true);
    setNotice('保存中...');
    try {
      while (queuedSaveRef.current) {
        const nextTree = queuedSaveRef.current;
        queuedSaveRef.current = null;

        const res = await fetch(`/api/mindmaps/${nextTree.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tree: nextTree }),
        });

        if (!res.ok) {
          setNotice('保存失败');
          return;
        }

        savedVersionRef.current = nextTree.meta.version;
      }

      setDirty(false);
      setNotice('已保存');
      setTimeout(() => setNotice(null), 1500);
    } catch {
      setNotice('保存失败');
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, []);

  const saveTree = useCallback(async () => {
    if (!tree) return;
    await saveTreeSnapshot(tree);
  }, [saveTreeSnapshot, tree]);

  // ---------- 节点悬浮操作框 / 笔记面板 ----------

  const handleSelectionChange = useCallback((nodeId: string | null, rect: NodeClientRect | null) => {
    setToolbarState(nodeId && rect ? { nodeId, rect } : null);
    // 选中切到其他节点或取消选中时，关闭进行中的 AI 菜单（流式请求由组件卸载 abort）
    setAiMenuNodeId((current) => (current && current !== nodeId ? null : current));
  }, []);

  const openNotePanel = useCallback(
    (nodeId: string) => {
      if (notePanelNodeId && notePanelNodeId !== nodeId && notePanelDirtyRef.current) {
        if (!window.confirm('当前笔记尚未保存，确定切换到其他节点吗？')) return;
      }
      setNotePanelNodeId(nodeId);
    },
    [notePanelNodeId],
  );

  const handleNoteSave = useCallback(
    (nodeId: string, content: string) => {
      updateNodeNote(nodeId, { content });
      const nextTree = useMindMapStore.getState().tree;
      if (nextTree) {
        void saveTreeSnapshot(nextTree);
      }
      setNotePanelNodeId(null);
      setNotice('笔记已保存');
      setTimeout(() => setNotice(null), 1500);
    },
    [saveTreeSnapshot, updateNodeNote],
  );

  const handleNoteDelete = useCallback(
    (nodeId: string) => {
      updateNodeNote(nodeId, null);
      const nextTree = useMindMapStore.getState().tree;
      if (nextTree) {
        void saveTreeSnapshot(nextTree);
      }
      setNotePanelNodeId(null);
      setNotice('笔记已删除');
      setTimeout(() => setNotice(null), 1500);
    },
    [saveTreeSnapshot, updateNodeNote],
  );

  // AI 文本处理结果写回节点 content（单步可撤销）
  const handleApplyAiText = useCallback(
    (nodeId: string, text: string) => {
      updateNodeContent(nodeId, text);
      const nextTree = useMindMapStore.getState().tree;
      if (nextTree) {
        void saveTreeSnapshot(nextTree);
      }
      setNotice('已应用到节点，可撤销');
      setTimeout(() => setNotice(null), 1500);
    },
    [saveTreeSnapshot, updateNodeContent],
  );

  // AI 生成的问题列表插入为子节点
  const handleInsertQuestions = useCallback(
    (nodeId: string, questions: string[]) => {
      const ids = addAiChildren(nodeId, questions);
      if (ids.length === 0) return;
      const nextTree = useMindMapStore.getState().tree;
      if (nextTree) {
        void saveTreeSnapshot(nextTree);
      }
      setNotice(`已插入 ${ids.length} 个问题子节点，可撤销`);
      setTimeout(() => setNotice(null), 1500);
    },
    [addAiChildren, saveTreeSnapshot],
  );

  const handleUpdateNodePosition = useCallback(
    (nodeId: string, position: NodePosition) => {
      updateNodePosition(nodeId, position);
      const nextTree = useMindMapStore.getState().tree;
      if (nextTree) {
        void saveTreeSnapshot(nextTree);
      }
    },
    [saveTreeSnapshot, updateNodePosition],
  );

  // 拖动整棵子树后的批量位置持久化：applyPatches 一次提交，撤销栈只留一条记录
  const handleUpdateNodePositions = useCallback(
    (updates: Array<{ id: string; position: NodePosition }>) => {
      if (updates.length === 0) return;
      const timestamp = Date.now();
      applyPatches(updates.map(({ id, position }) => ({ type: 'position' as const, nodeId: id, position, timestamp })));
      const nextTree = useMindMapStore.getState().tree;
      if (nextTree) {
        void saveTreeSnapshot(nextTree);
      }
    },
    [applyPatches, saveTreeSnapshot],
  );

  // AI 分支扩展：流式会话 + 打字机回放（子主题逐个逐字出现，新节点高亮标示来源），
  // 整体单步可撤销；生成期间沿用 generating 编辑锁防止内容互相覆盖
  const handleAiExpand = useCallback(async (targetNodeId?: string) => {
    const nodeId = targetNodeId ?? selectedNodeId;
    if (!tree || !nodeId || aiExpanding || optimizing) return;

    setAiExpanding(true);
    setNotice('AI 扩展中…');
    try {
      const { count } = await startBranchExpansion({
        tree,
        nodeId,
        normalizedDocument: normalizedDocument ?? undefined,
        onProgress: (applied) => setNotice(`AI 扩展中… 已生成 ${applied} 个子主题`),
        onTypingNode: setAiTypingNodeId,
      });

      if (count === 0) {
        throw new Error('AI 扩展结果为空，请重试或换个节点');
      }

      setNotice(`AI 扩展完成：新增 ${count} 个子节点，可撤销`);
      const nextTree = useMindMapStore.getState().tree;
      if (nextTree) {
        void saveTreeSnapshot(nextTree);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'AI 扩展失败');
    } finally {
      setAiExpanding(false);
      setAiTypingNodeId(null);
    }
  }, [tree, selectedNodeId, aiExpanding, optimizing, normalizedDocument, saveTreeSnapshot]);

  const handleAiOptimize = useCallback(async () => {
    if (!tree || optimizing || aiExpanding) return;

    setOptimizing(true);
    setNotice('AI 优化中...');
    try {
      const res = await fetch('/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tree,
          mode: optimizeMode,
          normalizedDocument: normalizedDocument ?? undefined,
        }),
      });

      const json = (await res.json().catch(() => ({}))) as {
        tree?: MindMapTree;
        error?: string;
      };
      if (!res.ok || !json.tree) {
        throw new Error(json.error || 'AI 优化失败');
      }

      replaceTreeKeepHistory(json.tree);
      setSelectedNode(json.tree.root.id);
      setNotice('AI 优化完成，可用撤销恢复原结构');
      void saveTreeSnapshot(json.tree);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'AI 优化失败');
    } finally {
      setOptimizing(false);
    }
  }, [tree, optimizing, aiExpanding, optimizeMode, normalizedDocument, replaceTreeKeepHistory, setSelectedNode, saveTreeSnapshot]);

  // ---------- 演示模式 ----------

  const focusPresentationNode = useCallback((nodeId: string) => {
    // 与 addNodeAndEdit 相同节奏：等 React 提交 + G6 重渲染后再聚焦
    setTimeout(() => {
      void editorRef.current?.focusNode(nodeId);
    }, 150);
  }, []);

  const enterPresentation = useCallback(() => {
    if (!tree || presentationSteps) return;

    // 演示依赖画布聚焦，大纲视图下先切回导图视图
    setViewMode('mindmap');
    presentationSnapshotRef.current = tree;
    setPresentationSteps(buildPresentationSteps(tree.root));
    setPresentationStepIndex(0);
    setPresenting(true);
    replaceTreeKeepHistory(collapseAllForPresentation(tree));
    setSelectedNode(tree.root.id);
    focusPresentationNode(tree.root.id);
  }, [tree, presentationSteps, replaceTreeKeepHistory, setSelectedNode, focusPresentationNode]);

  const exitPresentation = useCallback(() => {
    const snapshot = presentationSnapshotRef.current;
    if (snapshot) {
      // 恢复进入演示前的折叠状态；作为一步可撤销操作保留在历史里
      replaceTreeKeepHistory(snapshot);
    }
    presentationSnapshotRef.current = null;
    setPresentationSteps(null);
    setPresentationStepIndex(0);
    setPresenting(false);
  }, [replaceTreeKeepHistory]);

  const presentationNext = useCallback(() => {
    if (!presentationSteps || !tree) return;

    // 从游标起找第一个「仍折叠且有子节点」的步骤（用户手动展开过的直接跳过）
    let index = presentationStepIndex;
    while (index < presentationSteps.length) {
      const node = findNode(tree.root, presentationSteps[index]);
      if (node && (node.children?.length ?? 0) > 0 && node.collapsed) break;
      index += 1;
    }
    if (index >= presentationSteps.length) return;

    const nodeId = presentationSteps[index];
    toggleNodeCollapse(nodeId);
    setSelectedNode(nodeId);
    setPresentationStepIndex(index + 1);
    focusPresentationNode(nodeId);
  }, [presentationSteps, presentationStepIndex, tree, toggleNodeCollapse, setSelectedNode, focusPresentationNode]);

  const presentationPrev = useCallback(() => {
    if (!presentationSteps || !tree || presentationStepIndex <= 0) return;

    // 回退目标：最近展开的那个步骤；若已被手动折叠则继续向前找
    let index = presentationStepIndex - 1;
    while (index >= 0) {
      const node = findNode(tree.root, presentationSteps[index]);
      if (node && !node.collapsed) break;
      index -= 1;
    }
    if (index < 0) return;

    const nodeId = presentationSteps[index];
    toggleNodeCollapse(nodeId);
    setSelectedNode(nodeId);
    setPresentationStepIndex(index);
    focusPresentationNode(nodeId);
  }, [presentationSteps, presentationStepIndex, tree, toggleNodeCollapse, setSelectedNode, focusPresentationNode]);

  const togglePresentation = useCallback(() => {
    if (presenting) {
      exitPresentation();
    } else {
      enterPresentation();
    }
  }, [presenting, enterPresentation, exitPresentation]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const targetTag = target?.tagName?.toLowerCase() || '';
      const fromEditable =
        targetTag === 'input' ||
        targetTag === 'textarea' ||
        targetTag === 'select' ||
        target?.isContentEditable === true;

      // 演示模式独占键盘：空格/→ 前进，← 回退，Esc 退出，
      // 结构编辑与撤销重做快捷键全部拦截，避免演示中破坏数据。
      if (presenting) {
        if (event.key === 'Escape') {
          event.preventDefault();
          exitPresentation();
          return;
        }
        if (fromEditable) return;

        if (event.key === ' ' || event.key === 'ArrowRight') {
          event.preventDefault();
          presentationNext();
          return;
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          presentationPrev();
          return;
        }
        if (['Tab', 'Enter', 'Delete', 'Backspace'].includes(event.key)) {
          event.preventDefault();
        }
        return;
      }

      // 生成中编辑锁：结构编辑快捷键与保存/撤销重做全部拦截
      // （保存会把部分树落盘、撤销会与回放的树替换冲突）；浏览交互（方向键拖画布等）不拦。
      if (generating) {
        const structural = ['Tab', 'Enter', 'Delete', 'Backspace'].includes(event.key);
        if (structural && !fromEditable) {
          event.preventDefault();
        }
        if ((event.ctrlKey || event.metaKey) && ['s', 'S', 'z', 'Z', 'y', 'Y'].includes(event.key)) {
          event.preventDefault();
        }
        return;
      }

      // Ctrl+S / Cmd+S to save
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        if (tree) saveTree();
        return;
      }

      // Cmd/Ctrl+Z to undo, Shift+Cmd/Ctrl+Z or Ctrl+Y to redo.
      // Skipped while inline editing so the native text undo keeps working.
      // Check the event origin, not document.activeElement: React may flush
      // state updates (unmounting the inline editor) before this window-level
      // handler runs, which would make activeElement fall back to <body> and
      // wrongly trigger global shortcuts for keys typed inside the editor.
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        ['z', 'Z', 'y', 'Y'].includes(event.key)
      ) {
        if (fromEditable) return;
        if (!tree) return;

        event.preventDefault();
        const isRedo = event.shiftKey || event.key === 'y' || event.key === 'Y';
        if (isRedo) {
          redo();
        } else {
          undo();
        }
        return;
      }

      if (!tree || !selectedNodeId) return;

      // 大纲模式下画布节点快捷键（Tab/Enter/Delete）交由大纲行内编辑处理
      if (viewMode === 'outline') return;

      if (event.key === 'Tab') {
        event.preventDefault();
        addNodeAndEdit('child', { centerInViewport: true });
      }

      if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        if (fromEditable) return;

        event.preventDefault();
        addNodeAndEdit('sibling', { centerInViewport: true });
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (fromEditable) return;

        if (selectedNodeId === tree.root.id) return;
        event.preventDefault();
        deleteNode(selectedNodeId);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    addNodeAndEdit,
    deleteNode,
    saveTree,
    selectedNodeId,
    tree,
    undo,
    redo,
    viewMode,
    presenting,
    generating,
    presentationNext,
    presentationPrev,
    exitPresentation,
  ]);

  async function exportMarkdown() {
    if (!tree) return;

    const res = await fetch('/api/export/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree }),
    });

    if (!res.ok) {
      setNotice('Markdown 导出失败');
      return;
    }

    const json = (await res.json()) as { markdown: string; fileName: string };
    downloadBlob(new Blob([json.markdown], { type: 'text/markdown;charset=utf-8' }), json.fileName || 'mindmap.md');
    setNotice('Markdown 已导出');
  }

  async function exportPng() {
    if (!tree) return;

    const dataUrl = await editorRef.current?.exportPngDataUrl();

    const res = await fetch('/api/export/png', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataUrl: dataUrl || undefined,
        title: tree.meta.title || 'mindmap',
      }),
    });

    if (!res.ok) {
      setNotice('PNG 导出失败');
      return;
    }

    const blob = await res.blob();
    downloadBlob(blob, `${tree.meta.title || 'mindmap'}.png`);
    setNotice('PNG 已导出');
  }

  if (loading) {
    return (
      <main className="page editor-shell">
        <div className="editor-loading">加载导图中...</div>
      </main>
    );
  }

  if (error || !tree) {
    return (
      <main className="page editor-shell">
        <p className="error-line">{error || '导图不存在'}</p>
        <Link href="/">返回首页</Link>
      </main>
    );
  }

  return (
    <main className="page editor-shell">
      {/* 单行顶部导航：身份区 + 工具区 + 主操作区 */}
      <EditorToolbar
        title={tree.meta.title || '未命名导图'}
        saveNotice={notice}
        selectedNodeId={selectedNodeId}
        layoutDirection={layoutDirection}
        generating={generating}
        dirty={dirty}
        saving={saving}
        canUndo={canUndo}
        canRedo={canRedo}
        aiExpanding={aiExpanding}
        optimizing={optimizing}
        optimizeMode={optimizeMode}
        onUndo={undo}
        onRedo={redo}
        onAiOptimizeModeChange={setOptimizeMode}
        onAiOptimize={() => {
          void handleAiOptimize();
        }}
        onAddChild={handleAddChild}
        onAddSibling={handleAddSibling}
        onToggleCollapse={() => {
          if (!selectedNodeId) return;
          toggleNodeCollapse(selectedNodeId);
        }}
        onDelete={() => {
          if (!selectedNodeId || selectedNodeId === tree.root.id) return;
          deleteNode(selectedNodeId);
        }}
        onSave={saveTree}
        onExportMarkdown={exportMarkdown}
        onExportPng={exportPng}
        onLayoutChange={setLayoutDirection}
        presenting={presenting}
        onTogglePresentation={togglePresentation}
      />

      {/* 实时生成进度横幅（会话 treeId 匹配时渲染，含暂停/恢复/停止） */}
      <GenerationBanner treeId={id} />

      <section className="editor-workspace">
        <div className={`editor-canvas-area${viewMode === 'outline' ? ' outline-active' : ''}`}>
          {/* 左上角悬浮模式切换控件 */}
          <ViewModeToggle value={viewMode} onChange={handleViewModeChange} />

          {/* 演示模式控制条：底部居中悬浮 */}
          {presenting && presentationSteps ? (
            <div className="presentation-bar" role="region" aria-label="演示模式控制">
              <button
                type="button"
                className="presentation-btn"
                onClick={presentationPrev}
                disabled={presentationStepIndex <= 0}
                title="上一步 (←)"
              >
                ← 上一步
              </button>
              <span className="presentation-progress" aria-live="polite">
                {presentationStepIndex} / {presentationSteps.length}
              </span>
              <button
                type="button"
                className="presentation-btn"
                onClick={presentationNext}
                disabled={presentationStepIndex >= presentationSteps.length}
                title="下一步 (空格 / →)"
              >
                下一步 →
              </button>
              <span className="presentation-divider" aria-hidden="true" />
              <button
                type="button"
                className="presentation-btn presentation-exit"
                onClick={exitPresentation}
                title="退出演示 (Esc)"
              >
                退出演示
              </button>
            </div>
          ) : null}

          {/* 两个视图面板常驻挂载、CSS 切换可见性：
              保留 G6 画布缩放/平移状态与大纲滚动位置，切换零开销 */}
          <div className={`canvas-pane${viewMode === 'outline' ? ' pane-hidden' : ''}`}>
            <MindMapEditor
              ref={editorRef}
              tree={tree}
              selectedNodeId={selectedNodeId}
              generating={editorLocked}
              aiTypingNodeId={aiTypingNodeId}
              onSelectNode={setSelectedNode}
              onUpdateNodeContent={updateNodeContent}
              layoutDirection={layoutDirection}
              onMoveNode={moveNode}
              onUpdateNodePosition={handleUpdateNodePosition}
              onEditEnd={handleEditEnd}
              onEnterWithoutText={handleEnterWithoutText}
              onSelectionChange={handleSelectionChange}
            />

            {/* 选中节点的悬浮操作框（大纲模式下不渲染；生成/扩展回放中内容编辑锁定，同样不渲染） */}
            {viewMode === 'mindmap' &&
              !editorLocked &&
              toolbarState &&
              (() => {
                const node = findNode(tree.root, toolbarState.nodeId);
                if (!node) return null;
                return (
                  <NodeActionToolbar
                    nodeId={node.id}
                    anchorRect={toolbarState.rect}
                    hasNote={Boolean(node.note)}
                    onAddNote={() => openNotePanel(node.id)}
                    onAskAi={() => setAiMenuNodeId((current) => (current === node.id ? null : node.id))}
                  />
                );
              })()}

            {/* AI 功能子菜单 + 流式结果卡片（锚定在悬浮框下方） */}
            {viewMode === 'mindmap' &&
              toolbarState &&
              aiMenuNodeId === toolbarState.nodeId &&
              (() => {
                const node = findNode(tree.root, aiMenuNodeId);
                if (!node) return null;
                return (
                  <NodeAiMenu
                    key={node.id}
                    nodeId={node.id}
                    anchorRect={toolbarState.rect}
                    tree={tree}
                    onApplyText={handleApplyAiText}
                    onInsertQuestions={handleInsertQuestions}
                    onGenerateChildren={(nodeId) => {
                      void handleAiExpand(nodeId);
                    }}
                    childrenGenerating={aiExpanding}
                    onClose={() => setAiMenuNodeId(null)}
                  />
                );
              })()}

            {/* 节点笔记侧边面板 */}
            {notePanelNodeId &&
              (() => {
                const node = findNode(tree.root, notePanelNodeId);
                if (!node) return null;
                return (
                  <NodeNotePanel
                    key={node.id}
                    nodeId={node.id}
                    nodeContent={node.content}
                    note={node.note ?? null}
                    onDirtyChange={(dirty) => {
                      notePanelDirtyRef.current = dirty;
                    }}
                    onSave={(content) => handleNoteSave(node.id, content)}
                    onDelete={() => handleNoteDelete(node.id)}
                    onClose={() => setNotePanelNodeId(null)}
                  />
                );
              })()}
          </div>

          <div className={`canvas-pane outline-pane-wrap${viewMode === 'outline' ? '' : ' pane-hidden'}`}>
            <OutlineView
              tree={tree}
              selectedNodeId={selectedNodeId}
              generating={generating}
              onSelectNode={setSelectedNode}
              onUpdateNodeContent={updateNodeContent}
              onAddChild={(parentId) => addChildNode(parentId, '')}
              onAddSibling={(nodeId) => addSiblingNode(nodeId, '')}
            />
          </div>
        </div>

        <AiSummaryPanel tree={tree} normalizedDocument={normalizedDocument} />
      </section>
    </main>
  );
}

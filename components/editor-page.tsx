'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import { EditorToolbar, type AiOptimizeMode } from '@/components/editor-toolbar';
import { AiSummaryPanel } from '@/components/ai-summary-panel';
import { MindMapEditor, type MindMapEditorRef } from '@/components/mindmap-editor';
import { OutlineView } from '@/components/outline-view';
import { ViewModeToggle, VIEW_MODE_STORAGE_KEY, type EditorViewMode } from '@/components/view-mode-toggle';
import type { MindMapTree, NodePosition, NormalizedDocument } from '@/lib/types/mindmap';
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

  const [aiExpanding, setAiExpanding] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeMode, setOptimizeMode] = useState<AiOptimizeMode>('simplify');

  // 视图模式：导图 ↔ 文字大纲，偏好持久化到 localStorage
  const [viewMode, setViewMode] = useState<EditorViewMode>('mindmap');

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
  }, [id, setSelectedNode, setTree]);

  useEffect(() => {
    loadTree();
    return () => {
      setTree(null);
      setNormalizedDocument(null);
    };
  }, [loadTree, setTree]);

  // Track dirty state when tree changes
  useEffect(() => {
    if (tree && tree.meta.version !== savedVersionRef.current) {
      setDirty(true);
    }
  }, [tree]);

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

  const handleAiExpand = useCallback(async () => {
    if (!tree || !selectedNodeId || aiExpanding || optimizing) return;

    setAiExpanding(true);
    setNotice('AI 扩展中...');
    try {
      const res = await fetch('/api/expand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tree,
          nodeId: selectedNodeId,
          normalizedDocument: normalizedDocument ?? undefined,
        }),
      });

      const json = (await res.json().catch(() => ({}))) as {
        children?: string[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(json.error || 'AI 扩展失败');
      }

      const ids = addAiChildren(selectedNodeId, json.children || []);
      if (ids.length === 0) {
        throw new Error('AI 扩展结果为空，请重试或换个节点');
      }

      setNotice(`AI 扩展完成：新增 ${ids.length} 个子节点`);
      const nextTree = useMindMapStore.getState().tree;
      if (nextTree) {
        void saveTreeSnapshot(nextTree);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'AI 扩展失败');
    } finally {
      setAiExpanding(false);
    }
  }, [tree, selectedNodeId, aiExpanding, optimizing, normalizedDocument, addAiChildren, saveTreeSnapshot]);

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

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
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
      const target = event.target as HTMLElement | null;
      const targetTag = target?.tagName?.toLowerCase() || '';
      const fromEditable =
        targetTag === 'input' ||
        targetTag === 'textarea' ||
        targetTag === 'select' ||
        target?.isContentEditable === true;

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
  }, [addNodeAndEdit, deleteNode, saveTree, selectedNodeId, tree, undo, redo, viewMode]);

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
      <header className="editor-topbar">
        <div className="editor-topbar-left">
          <Link href="/" className="back-link">
            ← 返回首页
          </Link>
          <span className="editor-divider" aria-hidden="true" />
          <h1>{tree.meta.title || '未命名导图'}</h1>
        </div>
        <div className="editor-topbar-right">
          <span className={`save-state ${notice ? 'active' : ''} ${dirty ? 'dirty' : ''}`}>
            {notice || (dirty ? '未保存' : '已保存')}
          </span>
        </div>
      </header>

      <section className="editor-workspace">
        <div className={`editor-canvas-area${viewMode === 'outline' ? ' outline-active' : ''}`}>
          <EditorToolbar
            selectedNodeId={selectedNodeId}
            layoutDirection={layoutDirection}
            dirty={dirty}
            saving={saving}
            canUndo={canUndo}
            canRedo={canRedo}
            aiExpanding={aiExpanding}
            optimizing={optimizing}
            optimizeMode={optimizeMode}
            onUndo={undo}
            onRedo={redo}
            onAiExpand={() => {
              void handleAiExpand();
            }}
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
          />

          {/* 左上角悬浮模式切换控件 */}
          <ViewModeToggle value={viewMode} onChange={handleViewModeChange} />

          {/* 两个视图面板常驻挂载、CSS 切换可见性：
              保留 G6 画布缩放/平移状态与大纲滚动位置，切换零开销 */}
          <div className={`canvas-pane${viewMode === 'outline' ? ' pane-hidden' : ''}`}>
            <MindMapEditor
              ref={editorRef}
              tree={tree}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNode}
              onUpdateNodeContent={updateNodeContent}
              layoutDirection={layoutDirection}
              onMoveNode={moveNode}
              onUpdateNodePosition={handleUpdateNodePosition}
              onEditEnd={handleEditEnd}
              onEnterWithoutText={handleEnterWithoutText}
            />
          </div>

          <div className={`canvas-pane outline-pane-wrap${viewMode === 'outline' ? '' : ' pane-hidden'}`}>
            <OutlineView
              tree={tree}
              selectedNodeId={selectedNodeId}
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

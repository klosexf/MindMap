'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import { EditorToolbar } from '@/components/editor-toolbar';
import { MindMapEditor, type MindMapEditorRef } from '@/components/mindmap-editor';
import type { MindMapTree } from '@/lib/types/mindmap';
import { useMindMapStore } from '@/store/mindmap-store';

interface EditorPageProps {
  id: string;
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
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const savedVersionRef = useRef<number>(0);

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
  const balanceLayout = useMindMapStore((s) => s.balanceLayout);

  const loadTree = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/mindmaps/${id}`);
      if (!res.ok) {
        const statusText = res.status === 404 ? '导图不存在' : `加载失败 (HTTP ${res.status})`;
        throw new Error(statusText);
      }

      const json = (await res.json()) as { tree: MindMapTree };
      if (!json.tree) {
        throw new Error('服务器返回的导图数据为空');
      }
      setTree(json.tree);
      setSelectedNode(json.tree.root.id);
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
    return () => setTree(null);
  }, [loadTree, setTree]);

  // Track dirty state when tree changes
  useEffect(() => {
    if (tree && tree.meta.version !== savedVersionRef.current) {
      setDirty(true);
    }
  }, [tree]);

  // Inline add node helpers
  const addNodeAndEdit = useCallback(
    (mode: 'child' | 'sibling') => {
      if (!selectedNodeId || !tree) return;

      const newId =
        mode === 'child'
          ? addChildNode(selectedNodeId, '')
          : addSiblingNode(selectedNodeId, '');
      if (!newId) return;

      setSelectedNode(newId);

      // Wait for React to commit tree changes and G6 to render the new node
      setTimeout(() => {
        editorRef.current?.startEditingNode(newId);
      }, 150);
    },
    [selectedNodeId, tree, addChildNode, addSiblingNode, setSelectedNode],
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

  const saveTree = useCallback(async () => {
    if (!tree || saving) return;
    setSaving(true);
    setNotice('保存中...');

    try {
      const res = await fetch(`/api/mindmaps/${tree.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tree }),
      });

      if (!res.ok) {
        setNotice('保存失败');
        return;
      }

      savedVersionRef.current = tree.meta.version;
      setDirty(false);
      setNotice('已保存');
      setTimeout(() => setNotice(null), 1500);
    } catch {
      setNotice('保存失败');
    } finally {
      setSaving(false);
    }
  }, [saving, tree]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // Ctrl+S / Cmd+S to save
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        if (tree) saveTree();
        return;
      }

      if (!tree || !selectedNodeId) return;

      if (event.key === 'Tab') {
        event.preventDefault();
        addNodeAndEdit('child');
      }

      if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        const activeTag = (document.activeElement?.tagName || '').toLowerCase();
        if (activeTag === 'input' || activeTag === 'textarea') return;

        event.preventDefault();
        addNodeAndEdit('sibling');
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        const activeTag = (document.activeElement?.tagName || '').toLowerCase();
        if (activeTag === 'input' || activeTag === 'textarea') return;

        if (selectedNodeId === tree.root.id) return;
        event.preventDefault();
        deleteNode(selectedNodeId);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [addNodeAndEdit, deleteNode, saveTree, selectedNodeId, tree]);

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

  function renameNode() {
    if (!tree || !selectedNodeId) return;
    editorRef.current?.startEditingNode(selectedNodeId);
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
        <aside className="editor-sidecard">
          <h2>当前说明</h2>
          <ul>
            <li>快捷键：`Tab` 添加子节点</li>
            <li>快捷键：`Enter` 添加兄弟节点</li>
            <li>快捷键：`Delete` 删除非根节点</li>
            <li>快捷键：`Ctrl+S` 保存导图</li>
            <li>当前选中：{selectedNodeId || '未选择'}</li>
          </ul>
        </aside>

        <div className="editor-canvas-area">
          <EditorToolbar
            selectedNodeId={selectedNodeId}
            layoutDirection={layoutDirection}
            dirty={dirty}
            saving={saving}
            onRename={renameNode}
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
            onBalance={balanceLayout}
          />

          <MindMapEditor
            ref={editorRef}
            tree={tree}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNode}
            onUpdateNodeContent={updateNodeContent}
            layoutDirection={layoutDirection}
            onMoveNode={moveNode}
            onEditEnd={handleEditEnd}
          />
        </div>
      </section>
    </main>
  );
}

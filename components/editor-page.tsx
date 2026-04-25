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

  const tree = useMindMapStore((s) => s.tree);
  const selectedNodeId = useMindMapStore((s) => s.selectedNodeId);
  const setTree = useMindMapStore((s) => s.setTree);
  const setSelectedNode = useMindMapStore((s) => s.setSelectedNode);
  const updateNodeContent = useMindMapStore((s) => s.updateNodeContent);
  const addChildNode = useMindMapStore((s) => s.addChildNode);
  const addSiblingNode = useMindMapStore((s) => s.addSiblingNode);
  const deleteNode = useMindMapStore((s) => s.deleteNode);
  const toggleNodeCollapse = useMindMapStore((s) => s.toggleNodeCollapse);

  const loadTree = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/mindmaps/${id}`);
      if (!res.ok) throw new Error('导图不存在或加载失败');

      const json = (await res.json()) as { tree: MindMapTree };
      setTree(json.tree);
      setSelectedNode(json.tree.root.id);
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!tree || !selectedNodeId) return;

      if (event.key === 'Tab') {
        event.preventDefault();
        const value = window.prompt('子节点内容');
        if (value?.trim()) {
          addChildNode(selectedNodeId, value.trim());
        }
      }

      if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        const activeTag = (document.activeElement?.tagName || '').toLowerCase();
        if (activeTag === 'input' || activeTag === 'textarea') return;

        event.preventDefault();
        const value = window.prompt('兄弟节点内容');
        if (value?.trim()) {
          addSiblingNode(selectedNodeId, value.trim());
        }
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
  }, [addChildNode, addSiblingNode, deleteNode, selectedNodeId, tree]);

  async function saveTree() {
    if (!tree) return;
    setNotice('保存中...');

    const res = await fetch(`/api/mindmaps/${tree.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree }),
    });

    if (!res.ok) {
      setNotice('保存失败');
      return;
    }

    setNotice('已保存');
    setTimeout(() => setNotice(null), 1500);
  }

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
    const node = findNodeById(tree.root, selectedNodeId);
    if (!node) return;

    const value = window.prompt('修改节点文本', node.content);
    if (value?.trim()) {
      updateNodeContent(selectedNodeId, value.trim());
    }
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
          <span className={`save-state ${notice ? 'active' : ''}`}>{notice || '编辑中'}</span>
        </div>
      </header>

      <section className="editor-workspace">
        <aside className="editor-sidecard">
          <h2>当前说明</h2>
          <ul>
            <li>快捷键：`Tab` 添加子节点</li>
            <li>快捷键：`Enter` 添加兄弟节点</li>
            <li>快捷键：`Delete` 删除非根节点</li>
            <li>当前选中：{selectedNodeId || '未选择'}</li>
          </ul>
        </aside>

        <div className="editor-canvas-area">
          <EditorToolbar
            selectedNodeId={selectedNodeId}
            onRename={renameNode}
            onAddChild={() => {
              if (!selectedNodeId) return;
              const value = window.prompt('子节点内容');
              if (value?.trim()) addChildNode(selectedNodeId, value.trim());
            }}
            onAddSibling={() => {
              if (!selectedNodeId) return;
              const value = window.prompt('兄弟节点内容');
              if (value?.trim()) addSiblingNode(selectedNodeId, value.trim());
            }}
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
          />

          <MindMapEditor ref={editorRef} tree={tree} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNode} />
        </div>
      </section>
    </main>
  );
}

function findNodeById(node: MindMapTree['root'], id: string): MindMapTree['root'] | null {
  if (node.id === id) return node;

  if (!node.children?.length) return null;
  for (const child of node.children) {
    const found = findNodeById(child, id);
    if (found) return found;
  }

  return null;
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { NodeNote } from '@/lib/types/mindmap';

interface NodeNotePanelProps {
  nodeId: string;
  nodeContent: string;
  note: NodeNote | null;
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (content: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

const MAX_NOTE_LENGTH = 20000;

export function NodeNotePanel({ nodeId, nodeContent, note, onDirtyChange, onSave, onDelete, onClose }: NodeNotePanelProps) {
  const [draft, setDraft] = useState(note?.content ?? '');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const dirty = draft !== (note?.content ?? '');

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // 打开时聚焦文本区，光标移到末尾
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    const length = textarea.value.length;
    textarea.setSelectionRange(length, length);
  }, [nodeId]);

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('笔记尚未保存，确定放弃修改吗？')) return;
    onClose();
  }, [dirty, onClose]);

  const handleSave = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSave(trimmed.slice(0, MAX_NOTE_LENGTH));
  }, [draft, onSave]);

  const handleDelete = useCallback(() => {
    if (!window.confirm('确定删除这条笔记吗？')) return;
    onDelete();
  }, [onDelete]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault();
        handleSave();
      }
    },
    [handleSave, requestClose],
  );

  return (
    <aside className="node-note-panel" role="complementary" aria-label="节点笔记">
      <header className="node-note-header">
        <div className="node-note-title-wrap">
          <span className="node-note-badge">笔记</span>
          <h2 className="node-note-title" title={nodeContent}>
            {nodeContent || '未命名节点'}
          </h2>
        </div>
        <button type="button" className="node-note-close" onClick={requestClose} aria-label="关闭笔记面板">
          ✕
        </button>
      </header>

      <textarea
        ref={textareaRef}
        className="node-note-textarea"
        value={draft}
        maxLength={MAX_NOTE_LENGTH}
        placeholder="记录与该节点相关的笔记…"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
      />

      <footer className="node-note-footer">
        <span className="node-note-count">{draft.length.toLocaleString()} / {MAX_NOTE_LENGTH.toLocaleString()}</span>
        <div className="node-note-actions">
          {note && (
            <button type="button" className="node-note-btn danger" onClick={handleDelete}>
              删除
            </button>
          )}
          <button type="button" className="node-note-btn" onClick={requestClose}>
            取消
          </button>
          <button type="button" className="node-note-btn primary" onClick={handleSave} disabled={!draft.trim()}>
            保存
          </button>
        </div>
      </footer>
    </aside>
  );
}

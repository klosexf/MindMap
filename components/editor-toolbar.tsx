'use client';

import type { LayoutDirection } from '@/lib/types/mindmap';

interface EditorToolbarProps {
  selectedNodeId: string | null;
  layoutDirection: LayoutDirection;
  dirty: boolean;
  saving: boolean;
  onRename: () => void;
  onAddChild: () => void;
  onAddSibling: () => void;
  onToggleCollapse: () => void;
  onDelete: () => void;
  onSave: () => void;
  onExportMarkdown: () => void;
  onExportPng: () => void;
  onLayoutChange: (direction: LayoutDirection) => void;
  onBalance: () => void;
}

const LAYOUT_OPTIONS: Array<{ value: LayoutDirection; label: string }> = [
  { value: 'LR', label: '左 → 右' },
  { value: 'RL', label: '右 → 左' },
  { value: 'TB', label: '上 → 下' },
  { value: 'BT', label: '下 → 上' },
];

export function EditorToolbar({
  selectedNodeId,
  layoutDirection,
  dirty,
  saving,
  onRename,
  onAddChild,
  onAddSibling,
  onToggleCollapse,
  onDelete,
  onSave,
  onExportMarkdown,
  onExportPng,
  onLayoutChange,
  onBalance,
}: EditorToolbarProps) {
  const hasSelection = Boolean(selectedNodeId);

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <select
          value={layoutDirection}
          onChange={(e) => onLayoutChange(e.target.value as LayoutDirection)}
          className="tool-select"
        >
          {LAYOUT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={onBalance} className="tool-btn">
          平衡结构
        </button>
      </div>
      <span className="toolbar-divider" />
      <div className="toolbar-group">
        <button type="button" onClick={onRename} disabled={!hasSelection} className="tool-btn">
          改文字
        </button>
        <button type="button" onClick={onAddChild} disabled={!hasSelection} className="tool-btn">
          加子 (Tab)
        </button>
        <button type="button" onClick={onAddSibling} disabled={!hasSelection} className="tool-btn">
          加兄弟 (Enter)
        </button>
        <button type="button" onClick={onToggleCollapse} disabled={!hasSelection} className="tool-btn">
          折叠/展开
        </button>
        <button type="button" onClick={onDelete} disabled={!hasSelection} className="tool-btn danger">
          删除
        </button>
      </div>
      <span className="toolbar-divider" />
      <div className="toolbar-group">
        <button type="button" onClick={onSave} disabled={saving} className={`tool-btn primary ${dirty ? 'dirty' : ''}`}>
          {saving ? '保存中...' : dirty ? '保存 *' : '已保存'}
        </button>
        <button type="button" onClick={onExportMarkdown} className="tool-btn">
          导出 Markdown
        </button>
        <button type="button" onClick={onExportPng} className="tool-btn">
          导出 PNG
        </button>
      </div>
    </div>
  );
}

'use client';

interface EditorToolbarProps {
  selectedNodeId: string | null;
  onRename: () => void;
  onAddChild: () => void;
  onAddSibling: () => void;
  onToggleCollapse: () => void;
  onDelete: () => void;
  onSave: () => void;
  onExportMarkdown: () => void;
  onExportPng: () => void;
}

export function EditorToolbar({
  selectedNodeId,
  onRename,
  onAddChild,
  onAddSibling,
  onToggleCollapse,
  onDelete,
  onSave,
  onExportMarkdown,
  onExportPng,
}: EditorToolbarProps) {
  const hasSelection = Boolean(selectedNodeId);

  return (
    <div className="toolbar">
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
        <button type="button" onClick={onSave} className="tool-btn primary">
          保存
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

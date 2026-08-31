'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { LayoutDirection } from '@/lib/types/mindmap';

export type AiOptimizeMode = 'simplify' | 'restructure';

interface EditorToolbarProps {
  title: string;
  saveNotice: string | null;
  selectedNodeId: string | null;
  layoutDirection: LayoutDirection;
  /** 实时生成回放中：内容编辑/保存/撤销重做锁定，浏览类操作保留 */
  generating: boolean;
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  aiExpanding: boolean;
  optimizing: boolean;
  optimizeMode: AiOptimizeMode;
  onUndo: () => void;
  onRedo: () => void;
  onAiOptimizeModeChange: (mode: AiOptimizeMode) => void;
  onAiOptimize: () => void;
  onAddChild: () => void;
  onAddSibling: () => void;
  onDelete: () => void;
  onSave: () => void;
  onExportMarkdown: () => void;
  onExportPng: () => void;
  onLayoutChange: (direction: LayoutDirection) => void;
  presenting: boolean;
  onTogglePresentation: () => void;
}

const LAYOUT_OPTIONS: Array<{ value: LayoutDirection; label: string }> = [
  { value: 'LR', label: '左 → 右' },
  { value: 'RL', label: '右 → 左' },
  { value: 'TB', label: '上 → 下' },
  { value: 'BT', label: '下 → 上' },
];

const OPTIMIZE_OPTIONS: Array<{ value: AiOptimizeMode; label: string }> = [
  { value: 'simplify', label: 'AI 精简' },
  { value: 'restructure', label: 'AI 重组' },
];

/* ---------- 内联线性图标（16px, currentColor） ---------- */

const iconProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/* 布局方向迷你结构示意图（参照 XMind 结构选择器：实心根节点 + 分支子节点） */
function LayoutDiagram({ direction }: { direction: LayoutDirection }) {
  if (direction === 'LR') {
    return (
      <svg {...iconProps}>
        <rect x="2.5" y="9" width="5.5" height="6" rx="1.4" fill="currentColor" stroke="none" />
        <rect x="16" y="3.5" width="5.5" height="4.5" rx="1.2" />
        <rect x="16" y="16" width="5.5" height="4.5" rx="1.2" />
        <path d="M8 12h3.5M11.5 5.75H16M11.5 18.25H16M11.5 5.75v12.5" />
      </svg>
    );
  }
  if (direction === 'RL') {
    return (
      <svg {...iconProps}>
        <rect x="16" y="9" width="5.5" height="6" rx="1.4" fill="currentColor" stroke="none" />
        <rect x="2.5" y="3.5" width="5.5" height="4.5" rx="1.2" />
        <rect x="2.5" y="16" width="5.5" height="4.5" rx="1.2" />
        <path d="M16 12h-3.5M12.5 5.75H8M12.5 18.25H8M12.5 5.75v12.5" />
      </svg>
    );
  }
  if (direction === 'TB') {
    return (
      <svg {...iconProps}>
        <rect x="9.25" y="2.5" width="5.5" height="5.5" rx="1.4" fill="currentColor" stroke="none" />
        <rect x="2.5" y="16.5" width="5.5" height="4.5" rx="1.2" />
        <rect x="16" y="16.5" width="5.5" height="4.5" rx="1.2" />
        <path d="M12 8v4M5.25 12h13.5M5.25 12v4.5M18.75 12v4.5" />
      </svg>
    );
  }
  return (
    <svg {...iconProps}>
      <rect x="9.25" y="16" width="5.5" height="5.5" rx="1.4" fill="currentColor" stroke="none" />
      <rect x="2.5" y="3" width="5.5" height="4.5" rx="1.2" />
      <rect x="16" y="3" width="5.5" height="4.5" rx="1.2" />
      <path d="M12 16v-4M5.25 12h13.5M5.25 12V7.5M18.75 12V7.5" />
    </svg>
  );
}

function IconBack() {
  return (
    <svg {...iconProps}>
      <path d="M15 5 8 12l7 7" />
    </svg>
  );
}

function IconUndo() {
  return (
    <svg {...iconProps}>
      <path d="M8 5 4 9l4 4" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </svg>
  );
}

function IconRedo() {
  return (
    <svg {...iconProps}>
      <path d="m16 5 4 4-4 4" />
      <path d="M20 9H10a6 6 0 0 0 0 12h3" />
    </svg>
  );
}

function IconWand() {
  return (
    <svg {...iconProps}>
      <path d="M5 19 17 7M15 5l4 4" />
      <path d="M7 4v3M5.5 5.5h3M18 14v3M16.5 15.5h3" />
    </svg>
  );
}

function IconAddChild() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="9" width="6" height="6" rx="1.2" />
      <rect x="16" y="9" width="6" height="6" rx="1.2" />
      <path d="M9 12h4M13 12v0" />
      <path d="M19 6.5V9M19 15v2.5" />
    </svg>
  );
}

function IconAddSibling() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="9" width="6" height="6" rx="1.2" />
      <rect x="14" y="2.5" width="6" height="6" rx="1.2" />
      <rect x="14" y="15.5" width="6" height="6" rx="1.2" />
      <path d="M9 12h2.5" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg {...iconProps}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function IconSave() {
  return (
    <svg {...iconProps}>
      <path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M8 3v5h7V3M8 21v-7h8v7" />
    </svg>
  );
}

function IconPresent() {
  return (
    <svg {...iconProps}>
      <path d="M8 5.5v13l11-6.5-11-6.5z" />
    </svg>
  );
}

function IconExportFile() {
  return (
    <svg {...iconProps}>
      <path d="M12 3v12M8 7l4-4 4 4" />
      <path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
    </svg>
  );
}

function IconMarkdown() {
  return (
    <svg {...iconProps}>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M6 15V9l2.5 3L11 9v6M16.5 9v4M16.5 15v-2M14 11.5 16.5 14 19 11.5" />
    </svg>
  );
}

function IconImage() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4 18 5-5 3 3 4-4 4 4" />
    </svg>
  );
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg {...iconProps} width={12} height={12} className={`chevron${className ? ` ${className}` : ''}`}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...iconProps} width={14} height={14} className="layout-check">
      <path d="m5 12 5 5 9-10" />
    </svg>
  );
}

/* ---------- 下拉面板通用关闭逻辑（外点 / Esc / 滚动 / 缩放） ---------- */

function useDismissable(open: boolean, setOpen: (open: boolean) => void, wrapRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, setOpen, wrapRef]);
}

/* ---------- 下拉锚点定位 ---------- */

function useAnchor(btnRef: React.RefObject<HTMLElement | null>) {
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const sync = (open: boolean) => {
    if (!open && btnRef.current) return;
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor(open ? { top: r.bottom + 6, left: r.left } : null);
  };
  return { anchor, sync };
}

/* ---------- 布局方向选择器（示意图标下拉，参照 XMind 结构选择器） ---------- */

function LayoutPicker({
  value,
  onChange,
}: {
  value: LayoutDirection;
  onChange: (direction: LayoutDirection) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const { anchor, sync } = useAnchor(btnRef);
  useDismissable(open, setOpen, wrapRef);

  const toggle = () => {
    sync(!open);
    setOpen((o) => !o);
  };

  const currentLabel = LAYOUT_OPTIONS.find((o) => o.value === value)?.label ?? '';

  return (
    <div className="tool-dropdown" ref={wrapRef}>
      <button
        type="button"
        ref={btnRef}
        className="tool-btn"
        onClick={toggle}
        title="布局方向"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <LayoutDiagram direction={value} />
        <span className="tool-label">{currentLabel}</span>
        <Chevron className={open ? 'chevron-open' : ''} />
      </button>
      {open && anchor && (
        <div className="layout-menu" role="listbox" aria-label="布局方向" style={{ top: anchor.top, left: anchor.left }}>
          {LAYOUT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className={`layout-option${opt.value === value ? ' active' : ''}`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              <LayoutDiagram direction={opt.value} />
              <span>{opt.label}</span>
              {opt.value === value && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- 导出下拉（Markdown / PNG 合并为单一入口） ---------- */

function ExportPicker({
  onExportMarkdown,
  onExportPng,
}: {
  onExportMarkdown: () => void;
  onExportPng: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const { anchor, sync } = useAnchor(btnRef);
  useDismissable(open, setOpen, wrapRef);

  const toggle = () => {
    sync(!open);
    setOpen((o) => !o);
  };

  return (
    <div className="tool-dropdown" ref={wrapRef}>
      <button
        type="button"
        ref={btnRef}
        className="tool-btn"
        onClick={toggle}
        title="导出"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconExportFile />
        <span className="tool-label">导出</span>
        <Chevron className={open ? 'chevron-open' : ''} />
      </button>
      {open && anchor && (
        <div className="layout-menu export-menu" role="menu" aria-label="导出" style={{ top: anchor.top, left: anchor.left }}>
          <button
            type="button"
            role="menuitem"
            className="layout-option"
            onClick={() => {
              onExportMarkdown();
              setOpen(false);
            }}
          >
            <IconMarkdown />
            <span>Markdown 文件</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="layout-option"
            onClick={() => {
              onExportPng();
              setOpen(false);
            }}
          >
            <IconImage />
            <span>PNG 图片</span>
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- 通用按钮子组件 ---------- */

function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  variant,
  title,
  showChevron,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'danger';
  title?: string;
  showChevron?: boolean;
}) {
  const cls = ['tool-btn', variant].filter(Boolean).join(' ');
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cls} title={title}>
      {icon}
      <span className="tool-label">{label}</span>
      {showChevron && <Chevron />}
    </button>
  );
}

function ToolbarGroup({ children, extra }: { children: ReactNode; extra?: string }) {
  return <div className={`toolbar-group${extra ? ` ${extra}` : ''}`}>{children}</div>;
}

export function EditorToolbar({
  title,
  saveNotice,
  selectedNodeId,
  layoutDirection,
  generating,
  dirty,
  saving,
  canUndo,
  canRedo,
  aiExpanding,
  optimizing,
  optimizeMode,
  onUndo,
  onRedo,
  onAiOptimizeModeChange,
  onAiOptimize,
  onAddChild,
  onAddSibling,
  onDelete,
  onSave,
  onExportMarkdown,
  onExportPng,
  onLayoutChange,
  presenting,
  onTogglePresentation,
}: EditorToolbarProps) {
  const hasSelection = Boolean(selectedNodeId);

  return (
    <header className="editor-topbar">
      {/* 身份区：返回 + 标题 + 保存状态 */}
      <div className="editor-topbar-left">
        <Link href="/" className="back-link" aria-label="返回首页" title="返回首页">
          <IconBack />
        </Link>
        <span className="editor-divider" aria-hidden="true" />
        <h1>{title}</h1>
        <span
          className={`save-state ${saveNotice ? 'active' : ''} ${dirty ? 'dirty' : ''}`}
          role="status"
          aria-live="polite"
        >
          <i className="save-dot" aria-hidden="true" />
          {saveNotice || (dirty ? '未保存' : '已保存')}
        </span>
      </div>

      <span className="toolbar-divider" aria-hidden="true" />

      {/* 工具区：单行滚动 */}
      <div className="toolbar" role="toolbar" aria-label="导图编辑工具栏">
        {/* 组 1：结构 */}
        <ToolbarGroup>
          <LayoutPicker value={layoutDirection} onChange={onLayoutChange} />
        </ToolbarGroup>

        <span className="toolbar-divider" aria-hidden="true" />

        {/* 组 2：历史 */}
        <ToolbarGroup>
          <ToolButton
            icon={<IconUndo />}
            label="撤销"
            onClick={onUndo}
            disabled={!canUndo || generating}
            title="撤销 (Cmd/Ctrl+Z)"
          />
          <ToolButton
            icon={<IconRedo />}
            label="重做"
            onClick={onRedo}
            disabled={!canRedo || generating}
            title="重做 (Cmd/Ctrl+Shift+Z)"
          />
        </ToolbarGroup>

        <span className="toolbar-divider" aria-hidden="true" />

        {/* 组 3：AI（核心能力，底色块突出） */}
        <ToolbarGroup extra="ai-group">
          <ToolButton
            icon={<IconWand />}
            label={optimizing ? 'AI 优化中…' : 'AI 优化'}
            onClick={onAiOptimize}
            disabled={optimizing || aiExpanding || generating}
            title="AI 优化整图结构（结果可一键撤销）"
          />
          <div className="tool-select-wrap compact" title="切换 AI 优化模式">
            <select
              value={optimizeMode}
              onChange={(e) => onAiOptimizeModeChange(e.target.value as AiOptimizeMode)}
              className="tool-select"
              aria-label="AI 优化模式"
              disabled={optimizing || aiExpanding || generating}
            >
              {OPTIMIZE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <Chevron />
          </div>
        </ToolbarGroup>

        <span className="toolbar-divider" aria-hidden="true" />

        {/* 组 4：节点编辑 */}
        <ToolbarGroup>
          <ToolButton
            icon={<IconAddSibling />}
            label="主题"
            onClick={onAddSibling}
            disabled={!hasSelection || generating}
            title="添加同级主题 (Enter)"
          />
          <ToolButton
            icon={<IconAddChild />}
            label="细分主题"
            onClick={onAddChild}
            disabled={!hasSelection || generating}
            title="添加细分主题 (Tab)"
          />
          <ToolButton
            icon={<IconTrash />}
            label="删除"
            onClick={onDelete}
            disabled={!hasSelection || generating}
            variant="danger"
            title="删除选中节点"
          />
        </ToolbarGroup>
      </div>

      {/* 右侧主操作区 */}
      <div className="toolbar-end">
        <ToolButton
          icon={<IconPresent />}
          label={presenting ? '退出演示' : '演示'}
          onClick={onTogglePresentation}
          disabled={generating}
          title="演示模式：全折叠后按分支逐步展开（空格下一步，Esc 退出）"
        />
        <ExportPicker onExportMarkdown={onExportMarkdown} onExportPng={onExportPng} />
        <button
          type="button"
          onClick={onSave}
          disabled={saving || generating}
          className={`tool-btn primary ${dirty ? 'dirty' : ''}`}
          title={dirty ? '有未保存的修改，点击保存 (Cmd/Ctrl+S)' : '所有修改已保存'}
        >
          <IconSave />
          <span className="tool-label">{saving ? '保存中…' : '保存'}</span>
        </button>
      </div>
    </header>
  );
}

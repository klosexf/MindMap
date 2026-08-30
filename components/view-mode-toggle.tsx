'use client';

export type EditorViewMode = 'mindmap' | 'outline';

export const VIEW_MODE_STORAGE_KEY = 'mindmap:view-mode';

const MODE_OPTIONS: Array<{ value: EditorViewMode; label: string; title: string }> = [
  { value: 'mindmap', label: '导图', title: '思维导图模式' },
  { value: 'outline', label: '大纲', title: '文字大纲模式' },
];

function IconMindMap() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="9" width="6" height="6" rx="1.4" fill="currentColor" stroke="none" />
      <rect x="15.5" y="3" width="6" height="5" rx="1.2" />
      <rect x="15.5" y="16" width="6" height="5" rx="1.2" />
      <path d="M8.5 12H11M11 12v-6.5M11 5.5h4.5M11 12v6.5M11 18.5h4.5" />
    </svg>
  );
}

function IconOutline() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="5" cy="18" r="1.4" fill="currentColor" stroke="none" />
      <path d="M9.5 6h11M9.5 12h11M9.5 18h11" />
    </svg>
  );
}

const ICONS: Record<EditorViewMode, React.ReactNode> = {
  mindmap: <IconMindMap />,
  outline: <IconOutline />,
};

interface ViewModeToggleProps {
  value: EditorViewMode;
  onChange: (mode: EditorViewMode) => void;
}

/** 左上角悬浮模式切换控件：导图 ↔ 文字大纲 */
export function ViewModeToggle({ value, onChange }: ViewModeToggleProps) {
  return (
    <div className="view-mode-toggle" role="radiogroup" aria-label="视图模式切换">
      {MODE_OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={`view-mode-btn${active ? ' active' : ''}`}
            title={opt.title}
            onClick={() => {
              if (!active) onChange(opt.value);
            }}
          >
            {ICONS[opt.value]}
            <span className="view-mode-label">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

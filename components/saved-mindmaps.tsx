'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

interface MindMapSummary {
  id: string;
  meta: {
    title?: string;
    sourceType: string;
    sourceUrl?: string;
    sourceFileName?: string;
    createdAt: number;
    updatedAt: number;
    version: number;
  };
  rootContent: string;
}

export function SavedMindMaps() {
  const [open, setOpen] = useState(false);
  const [mindmaps, setMindmaps] = useState<MindMapSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  const loadMindmaps = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/mindmaps');
      if (!res.ok) throw new Error('加载失败');
      const json = (await res.json()) as { mindmaps: MindMapSummary[] };
      setMindmaps(json.mindmaps);
    } catch {
      setError('无法加载历史记录');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load data when drawer opens
  useEffect(() => {
    if (open) {
      loadMindmaps();
    }
  }, [open, loadMindmaps]);

  // Close on Escape key
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const handleDelete = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (!confirm('确定要删除该思维导图吗？此操作不可恢复。')) return;

      setDeletingId(id);
      try {
        const res = await fetch(`/api/mindmaps/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('删除失败');
        setMindmaps((prev) => prev.filter((m) => m.id !== id));
      } catch {
        alert('删除失败，请重试');
      } finally {
        setDeletingId(null);
      }
    },
    [],
  );

  function formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin} 分钟前`;
    if (diffHour < 24) return `${diffHour} 小时前`;
    if (diffDay < 7) return `${diffDay} 天前`;

    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function sourceTypeLabel(type: string): string {
    const map: Record<string, string> = {
      text: '文本',
      url: '链接',
      pdf: 'PDF',
      prompt: '提示词',
      wechat: '微信',
    };
    return map[type] || type;
  }

  return (
    <>
      {/* Navbar trigger button */}
      <button
        type="button"
        className="saved-files-trigger"
        onClick={() => setOpen(true)}
        aria-label="已保存文件"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span>已保存文件</span>
        {mindmaps.length > 0 && (
          <span className="saved-files-badge">{mindmaps.length}</span>
        )}
      </button>

      {/* Backdrop overlay */}
      <div
        className={`drawer-backdrop ${open ? 'visible' : ''}`}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <aside
        ref={drawerRef}
        className={`drawer-panel ${open ? 'open' : ''}`}
        aria-label="已保存的思维导图"
        aria-hidden={!open}
      >
        <div className="drawer-header">
          <h2 className="drawer-title">已保存文件</h2>
          <button
            type="button"
            className="drawer-close-btn"
            onClick={() => setOpen(false)}
            aria-label="关闭面板"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="drawer-body">
          {loading && (
            <div className="drawer-loading">
              <div className="drawer-spinner" />
              <span>加载中...</span>
            </div>
          )}

          {!loading && error && (
            <div className="drawer-empty">
              <p className="drawer-error-text">{error}</p>
              <button type="button" className="drawer-retry-btn" onClick={loadMindmaps}>
                重试
              </button>
            </div>
          )}

          {!loading && !error && mindmaps.length === 0 && (
            <div className="drawer-empty">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.3">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <p>还没有保存的思维导图</p>
              <p className="drawer-empty-hint">在上方输入内容生成导图后，可在编辑器中点击「保存」</p>
            </div>
          )}

          {!loading && !error && mindmaps.length > 0 && (
            <ul className="drawer-list">
              {mindmaps.map((map) => (
                <li key={map.id} className="drawer-item">
                  <Link href={`/g/${map.id}`} className="drawer-item-link" onClick={() => setOpen(false)}>
                    <div className="drawer-item-top">
                      <span className="drawer-item-badge">{sourceTypeLabel(map.meta.sourceType)}</span>
                      <span className="drawer-item-time">{formatDate(map.meta.updatedAt)}</span>
                    </div>
                    <h3 className="drawer-item-title">{map.meta.title || map.rootContent}</h3>
                    <div className="drawer-item-bottom">
                      <span className="drawer-item-version">v{map.meta.version}</span>
                      <button
                        type="button"
                        className="drawer-item-delete"
                        onClick={(e) => handleDelete(map.id, e)}
                        disabled={deletingId === map.id}
                        aria-label={`删除「${map.meta.title || map.rootContent}」`}
                      >
                        {deletingId === map.id ? '删除中...' : '删除'}
                      </button>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}

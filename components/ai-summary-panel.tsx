'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MindMapNode, MindMapTree } from '@/lib/types/mindmap';

interface SummaryProof {
  source?: string;
  provider?: string;
  model?: string;
}

type SummaryFeedback = 'like' | 'dislike' | null;

function buildTreeSignature(tree: MindMapTree): string {
  const queue: MindMapNode[] = [tree.root];
  const parts: string[] = [];

  while (queue.length > 0 && parts.length < 80) {
    const node = queue.shift();
    if (!node) continue;

    const content = node.content.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (content) parts.push(content);

    for (const child of node.children || []) {
      queue.push(child);
      if (queue.length + parts.length >= 120) break;
    }
  }

  return `${tree.meta.version}:${parts.join('|')}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function AiSummaryPanel({ tree }: { tree: MindMapTree }) {
  const [points, setPoints] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<SummaryFeedback>(null);
  const [summaryProof, setSummaryProof] = useState<SummaryProof | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [stale, setStale] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const hasLoadedRef = useRef(false);
  const signature = useMemo(() => buildTreeSignature(tree), [tree]);

  const requestSummary = useCallback(
    async (reason: 'auto' | 'manual') => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (reason === 'auto' && hasLoadedRef.current) {
        setStale(true);
      }

      setLoading(true);
      setError(null);

      try {
        const res = await fetch('/api/summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tree }),
          signal: controller.signal,
        });

        const json = (await res.json().catch(() => ({}))) as {
          points?: string[];
          error?: string;
          proof?: SummaryProof;
        };

        if (!res.ok) {
          throw new Error(json.error || '摘要生成失败');
        }

        const nextPoints = Array.isArray(json.points) ? json.points.filter((item) => typeof item === 'string' && item.trim()) : [];
        if (nextPoints.length === 0) {
          throw new Error('摘要结果为空，请重试');
        }

        setPoints(nextPoints);
        setSummaryProof(json.proof || null);
        setUpdatedAt(Date.now());
        setStale(false);
        hasLoadedRef.current = true;
      } catch (err) {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : '摘要生成失败';
        setError(msg);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    },
    [tree],
  );

  useEffect(() => {
    const delay = hasLoadedRef.current ? 900 : 120;
    const timer = window.setTimeout(() => {
      void requestSummary('auto');
    }, delay);

    return () => window.clearTimeout(timer);
  }, [signature, requestSummary]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return (
    <aside className="editor-summary-panel" aria-label="AI 摘要模块">
      <article className="ai-summary-card">
        <header className="ai-summary-head">
          <span className="ai-summary-head-title">
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path
                d="M10 1.8l1.4 3.6 3.6 1.4-3.6 1.4L10 11.8 8.6 8.2 5 6.8l3.6-1.4L10 1.8zm6.2 8.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2zM4 11.2l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5z"
                fill="currentColor"
              />
            </svg>
            AI 摘要
          </span>
          <button
            type="button"
            className={`ai-summary-refresh-btn ${loading ? 'loading' : ''}`}
            onClick={() => void requestSummary('manual')}
            disabled={loading}
            title="重新生成"
            aria-label="重新生成摘要"
          >
            ↻
          </button>
        </header>

        <div className="ai-summary-body">
          {loading && points.length === 0 && (
            <div className="ai-summary-skeleton" aria-hidden="true">
              <span className="ai-summary-skeleton-line" />
              <span className="ai-summary-skeleton-line" />
              <span className="ai-summary-skeleton-line" />
            </div>
          )}

          {!loading && points.length === 0 && error && (
            <div className="ai-summary-empty" role="status">
              <p>摘要生成失败</p>
              <button type="button" className="ai-summary-retry-btn" onClick={() => void requestSummary('manual')}>
                点击重试
              </button>
            </div>
          )}

          {points.length > 0 && (
            <ul className="ai-summary-list">
              {points.map((point, index) => (
                <li key={`${index}-${point.slice(0, 12)}`}>{point}</li>
              ))}
            </ul>
          )}
        </div>

        <footer className="ai-summary-foot">
          <div className="ai-summary-foot-left">
            <span className="ai-summary-source-text">
              {stale
                ? '内容已更新，正在同步摘要...'
                : updatedAt
                  ? `基于当前摘要内容生成 · ${formatTime(updatedAt)}`
                  : '基于当前摘要内容生成'}
            </span>
            {error && points.length > 0 && <span className="ai-summary-error-inline">{error}</span>}
            {summaryProof && summaryProof.provider && summaryProof.model && (
              <span className="ai-summary-proof">
                {summaryProof.provider} / {summaryProof.model}
              </span>
            )}
          </div>
          <div className="ai-summary-feedback-actions" role="group" aria-label="摘要反馈">
            <button
              type="button"
              className={`ai-summary-feedback-btn ${feedback === 'like' ? 'active' : ''}`}
              onClick={() => setFeedback((prev) => (prev === 'like' ? null : 'like'))}
              aria-pressed={feedback === 'like'}
              title="点赞"
            >
              👍
            </button>
            <button
              type="button"
              className={`ai-summary-feedback-btn ${feedback === 'dislike' ? 'active' : ''}`}
              onClick={() => setFeedback((prev) => (prev === 'dislike' ? null : 'dislike'))}
              aria-pressed={feedback === 'dislike'}
              title="点踩"
            >
              👎
            </button>
          </div>
        </footer>
      </article>
    </aside>
  );
}

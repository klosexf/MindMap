'use client';

import { useEffect, useState } from 'react';

import { pauseGeneration, resumeGeneration, stopGeneration } from '@/lib/streaming/generation-session';
import { useGenerationStore } from '@/store/generation-store';

interface GenerationBannerProps {
  /** 当前编辑器展示的导图 id；与会话 treeId 匹配才渲染 */
  treeId: string;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

const PHASE_LABELS: Record<string, string> = {
  parsing: '正在解析输入内容...',
  skeleton: '导图骨架已生成，正在补全节点...',
  nodes: 'AI 正在逐节点生成导图...',
  done: '生成完成',
};

/**
 * 实时生成进度横幅：阶段文案 + 节点计数 + 耗时 + 流光进度条 + 暂停/恢复/停止。
 * LLM 流式无法预知总节点数，进度采用非确定式反馈（阶段 + 计数 + 流光）。
 */
export function GenerationBanner({ treeId }: GenerationBannerProps) {
  const status = useGenerationStore((s) => s.status);
  const sessionTreeId = useGenerationStore((s) => s.treeId);
  const phase = useGenerationStore((s) => s.phase);
  const nodesApplied = useGenerationStore((s) => s.nodesApplied);
  const nodesReceived = useGenerationStore((s) => s.nodesReceived);
  const errorMessage = useGenerationStore((s) => s.errorMessage);
  const warning = useGenerationStore((s) => s.warning);
  const startedAt = useGenerationStore((s) => s.startedAt);

  const [dismissed, setDismissed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const active = status === 'streaming' || status === 'paused';

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [active]);

  // 新会话/新导图时重置关闭态
  useEffect(() => {
    if (active) setDismissed(false);
  }, [active]);

  if (sessionTreeId !== treeId || status === 'idle') return null;
  if ((status === 'completed' || status === 'stopped' || status === 'error') && dismissed) return null;

  const label =
    status === 'paused'
      ? '已暂停（事件继续接收，恢复后加速追平）'
      : status === 'completed'
        ? '生成完成'
        : status === 'stopped'
          ? `已停止生成，保留 ${nodesApplied} 个已生成节点`
          : status === 'error'
            ? '生成中断，已保留当前内容'
            : PHASE_LABELS[phase] ?? '生成中...';

  return (
    <div className={`generation-banner${status === 'completed' ? ' is-done' : ''}${status === 'error' ? ' is-error' : ''}${status === 'stopped' ? ' is-stopped' : ''}`} role="status">
      {active && <span className="generation-banner-bar" aria-hidden="true" />}
      <div className="generation-banner-main">
        <div className="generation-banner-row">
          <span className="generation-banner-label">{label}</span>
          {active && (
            <span className="generation-banner-meta">
              已生成 {nodesApplied}
              {nodesReceived > nodesApplied ? ` / 已接收 ${nodesReceived}` : ''} 个节点
              {startedAt ? ` · ${formatElapsed(Math.max(0, now - startedAt))}` : ''}
            </span>
          )}
        </div>
        {(warning || errorMessage) && (
          <span className="generation-banner-note">{errorMessage || warning}</span>
        )}
      </div>
      <div className="generation-banner-actions">
        {status === 'streaming' && (
          <button type="button" className="generation-banner-btn" onClick={pauseGeneration}>
            暂停
          </button>
        )}
        {status === 'paused' && (
          <button type="button" className="generation-banner-btn" onClick={resumeGeneration}>
            恢复
          </button>
        )}
        {active && (
          <button type="button" className="generation-banner-btn generation-banner-stop" onClick={() => void stopGeneration()}>
            停止生成
          </button>
        )}
        {!active && (
          <button type="button" className="generation-banner-btn" onClick={() => setDismissed(true)}>
            知道了
          </button>
        )}
      </div>
    </div>
  );
}

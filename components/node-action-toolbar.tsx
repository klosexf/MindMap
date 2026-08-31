'use client';

import { useMemo } from 'react';

export interface NodeActionAnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface NodeActionToolbarProps {
  nodeId: string;
  anchorRect: NodeActionAnchorRect;
  hasNote: boolean;
  onAddNote: () => void;
  onAskAi: () => void;
}

/** 悬浮框预估尺寸：与 CSS .node-action-toolbar 保持一致，用于翻转/钳制计算 */
export const TOOLBAR_WIDTH = 176;
export const TOOLBAR_HEIGHT = 56;
const EDGE_GAP = 8;
/** 悬浮框与节点之间的间距 */
const NODE_GAP = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 计算悬浮框位置：优先出现在节点右下方（右缘与节点右缘对齐），
 * 下方放不下翻到节点上方，最终钳制在视口内。
 */
export function computeToolbarPosition(
  anchorRect: NodeActionAnchorRect,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  const maxLeft = viewportWidth - EDGE_GAP - TOOLBAR_WIDTH;
  const maxTop = viewportHeight - EDGE_GAP - TOOLBAR_HEIGHT;

  // 右缘对齐节点右缘；越出左缘时钳制回视口
  const left = clamp(anchorRect.left + anchorRect.width - TOOLBAR_WIDTH, EDGE_GAP, Math.max(maxLeft, EDGE_GAP));

  const belowTop = anchorRect.top + anchorRect.height + NODE_GAP;
  if (belowTop <= maxTop) {
    return {
      left,
      top: clamp(belowTop, EDGE_GAP, maxTop),
    };
  }

  // 下方放不下：翻到节点上方
  const aboveTop = anchorRect.top - NODE_GAP - TOOLBAR_HEIGHT;
  return {
    left,
    top: clamp(aboveTop, EDGE_GAP, maxTop),
  };
}

export function NodeActionToolbar({ nodeId, anchorRect, hasNote, onAddNote, onAskAi }: NodeActionToolbarProps) {
  const position = useMemo(() => {
    if (typeof window === 'undefined') {
      return {
        left: anchorRect.left + anchorRect.width - TOOLBAR_WIDTH,
        top: anchorRect.top + anchorRect.height + NODE_GAP,
      };
    }
    return computeToolbarPosition(anchorRect, window.innerWidth, window.innerHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, anchorRect.left, anchorRect.top, anchorRect.width, anchorRect.height]);

  return (
    <div
      key={nodeId}
      className="node-action-toolbar"
      role="toolbar"
      aria-label="节点操作"
      data-node-id={nodeId}
      style={{ left: position.left, top: position.top }}
      // 阻止点击冒泡到画布（避免触发 canvas:click 取消选中）
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button type="button" className="node-action-btn" onClick={onAddNote} title={hasNote ? '查看笔记' : '添加笔记'}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <path
            d="M5 4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-15Z"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path d="M9 8.5h6M9 12h6M9 15.5h3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="m14.5 17.5 2 2 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{hasNote ? '查看笔记' : '添加笔记'}</span>
      </button>

      <span className="node-action-divider" aria-hidden="true" />

      <button type="button" className="node-action-btn node-action-ai" onClick={onAskAi} title="询问 AI">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <path
            d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7L12 3Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M18.5 14.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3Z" fill="currentColor" />
        </svg>
        <span>询问AI</span>
      </button>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { MindMapTree } from '@/lib/types/mindmap';
import type { NodeActionAnchorRect } from '@/components/node-action-toolbar';
import { computeToolbarPosition, TOOLBAR_HEIGHT } from '@/components/node-action-toolbar';

const TEXT_ACTIONS: Array<{ action: 'polish' | 'expand' | 'simplify'; label: string }> = [
  { action: 'polish', label: '文本润色' },
  { action: 'expand', label: '内容拓展' },
  { action: 'simplify', label: '内容简化' },
];

type MenuStatus = 'menu' | 'running' | 'done' | 'error';

interface NodeAiMenuProps {
  nodeId: string;
  anchorRect: NodeActionAnchorRect;
  tree: MindMapTree;
  /** 应用文本处理结果（替换节点 content） */
  onApplyText: (nodeId: string, text: string) => void;
  /** 将问题列表插入为子节点 */
  onInsertQuestions: (nodeId: string, questions: string[]) => void;
  /** 智能生成子主题（复用现有 /api/expand 流程） */
  onGenerateChildren: (nodeId: string) => void;
  /** 子主题生成进行中（禁用入口，避免并发） */
  childrenGenerating: boolean;
  onClose: () => void;
}

const MENU_WIDTH = 200;
const MENU_GAP = 6;
const EDGE_GAP = 8;
/** 菜单初始高度预估（menu 状态 5 项），测量到实际高度后修正 */
const MENU_FALLBACK_HEIGHT = 190;

function clampMenuPosition(
  position: { left: number; top: number },
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const maxLeft = Math.max(viewportWidth - EDGE_GAP - MENU_WIDTH, EDGE_GAP);
  return {
    left: Math.min(Math.max(position.left, EDGE_GAP), maxLeft),
    top: Math.min(Math.max(position.top, EDGE_GAP), Math.max(viewportHeight - EDGE_GAP - menuHeight, EDGE_GAP)),
  };
}

export function NodeAiMenu({
  nodeId,
  anchorRect,
  tree,
  onApplyText,
  onInsertQuestions,
  onGenerateChildren,
  childrenGenerating,
  onClose,
}: NodeAiMenuProps) {
  const [status, setStatus] = useState<MenuStatus>('menu');
  const [output, setOutput] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [runningAction, setRunningAction] = useState<'polish' | 'expand' | 'simplify' | 'questions' | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef('');
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 菜单实际高度（流式输出时动态增长），首帧用预估高度
  const [menuHeight, setMenuHeight] = useState(MENU_FALLBACK_HEIGHT);

  // 卸载时中止进行中的请求
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // 内容/状态变化后重新测量高度：流式结果卡片高度会持续增长
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (el && Math.abs(el.offsetHeight - menuHeight) > 1) {
      setMenuHeight(el.offsetHeight);
    }
  }, [status, output, errorMsg, menuHeight]);

  // 悬浮框下方展开：复用工具栏定位逻辑，向下偏移一个工具栏高度；
  // 视口底部放不下时优先翻转到工具栏上方，仍放不下再整体钳入视口
  const position = useMemo(() => {
    if (typeof window === 'undefined') {
      return { left: anchorRect.left, top: anchorRect.top + TOOLBAR_HEIGHT + MENU_GAP };
    }
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const toolbarPos = computeToolbarPosition(anchorRect, viewportWidth, viewportHeight);
    const belowTop = toolbarPos.top + TOOLBAR_HEIGHT + MENU_GAP;

    if (belowTop + menuHeight <= viewportHeight - EDGE_GAP) {
      return clampMenuPosition({ left: toolbarPos.left, top: belowTop }, menuHeight, viewportWidth, viewportHeight);
    }

    // 下方放不下：翻转到工具栏上方
    const aboveTop = toolbarPos.top - MENU_GAP - menuHeight;
    if (aboveTop >= EDGE_GAP) {
      return clampMenuPosition({ left: toolbarPos.left, top: aboveTop }, menuHeight, viewportWidth, viewportHeight);
    }

    // 上下都放不下（视口过矮）：钳入视口顶部
    return clampMenuPosition({ left: toolbarPos.left, top: EDGE_GAP }, menuHeight, viewportWidth, viewportHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, anchorRect.left, anchorRect.top, anchorRect.width, anchorRect.height, menuHeight]);

  const runAction = useCallback(
    async (action: 'polish' | 'expand' | 'simplify' | 'questions') => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setRunningAction(action);
      setStatus('running');
      setOutput('');
      setErrorMsg('');
      outputRef.current = '';

      try {
        const res = await fetch('/api/node-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tree, nodeId, action }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const json = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(json.error || `AI 处理失败 (HTTP ${res.status})`);
        }

        // 解析 SSE 流
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const messages = buffer.split('\n\n');
          buffer = messages.pop() ?? '';

          for (const message of messages) {
            const eventLine = message.split('\n').find((line) => line.startsWith('event: '));
            const dataLine = message.split('\n').find((line) => line.startsWith('data: '));
            if (!eventLine || !dataLine) continue;

            const eventType = eventLine.slice('event: '.length);
            const data = JSON.parse(dataLine.slice('data: '.length)) as { text?: string; message?: string };

            if (eventType === 'delta' && data.text) {
              outputRef.current += data.text;
              setOutput(outputRef.current);
            } else if (eventType === 'error') {
              throw new Error(data.message || 'AI 处理失败');
            }
            // done 事件由流结束自然处理
          }
        }

        if (!outputRef.current.trim()) {
          throw new Error('AI 返回结果为空，请重试');
        }

        setStatus('done');
      } catch (err) {
        if (controller.signal.aborted) return;
        setErrorMsg(err instanceof Error ? err.message : 'AI 处理失败');
        setStatus('error');
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [tree, nodeId],
  );

  const handleApply = useCallback(() => {
    // content 上限 500 字符：超长截断（服务端 prompt 已约束，这里兜底）
    const text = outputRef.current.trim().slice(0, 500);
    if (!text) return;
    if (runningAction === 'questions') {
      const questions = outputRef.current
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*\d+[.、)]?\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 8);
      if (questions.length > 0) {
        onInsertQuestions(nodeId, questions);
        onClose();
        return;
      }
    }
    onApplyText(nodeId, text);
    onClose();
  }, [nodeId, onApplyText, onInsertQuestions, onClose, runningAction]);

  const requestClose = useCallback(() => {
    abortRef.current?.abort();
    onClose();
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="node-ai-menu"
      role="menu"
      aria-label="AI 功能菜单"
      style={{ left: position.left, top: position.top }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {status === 'menu' && (
        <div className="node-ai-menu-list">
          {TEXT_ACTIONS.map(({ action, label }) => (
            <button key={action} type="button" className="node-ai-menu-item" onClick={() => void runAction(action)}>
              {label}
            </button>
          ))}
          <button
            type="button"
            className="node-ai-menu-item"
            onClick={() => {
              onGenerateChildren(nodeId);
              onClose();
            }}
          >
            智能生成子主题
          </button>
          <button type="button" className="node-ai-menu-item" onClick={() => void runAction('questions')}>
            帮我提出 5 个问题
          </button>
        </div>
      )}

      {status === 'running' && (
        <div className="node-ai-result">
          <div className="node-ai-result-head">
            <span className="node-ai-spinner" aria-hidden="true" />
            <span>AI 处理中…</span>
            <button type="button" className="node-ai-cancel" onClick={requestClose}>
              取消
            </button>
          </div>
          <div className="node-ai-result-body">
            {output || <span className="node-ai-placeholder">正在生成…</span>}
          </div>
        </div>
      )}

      {status === 'done' && (
        <div className="node-ai-result">
          <div className="node-ai-result-head">
            <span className="node-ai-done-label">处理完成</span>
            <button type="button" className="node-ai-cancel" onClick={requestClose}>
              关闭
            </button>
          </div>
          <div className="node-ai-result-body">{output}</div>
          <div className="node-ai-result-actions">
            <button type="button" className="node-ai-btn" onClick={requestClose}>
              放弃
            </button>
            <button type="button" className="node-ai-btn primary" onClick={handleApply}>
              {runningAction === 'questions' ? '插入为子节点' : '应用到节点'}
            </button>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="node-ai-result">
          <div className="node-ai-result-head">
            <span className="node-ai-error-label">处理失败</span>
            <button type="button" className="node-ai-cancel" onClick={requestClose}>
              关闭
            </button>
          </div>
          <div className="node-ai-result-body error">{errorMsg}</div>
          <div className="node-ai-result-actions">
            <button
              type="button"
              className="node-ai-btn primary"
              onClick={() => runningAction && void runAction(runningAction)}
            >
              重试
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

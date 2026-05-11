// @vitest-environment jsdom

import { createElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSummaryPanel } from '../components/ai-summary-panel';
import type { MindMapTree, NormalizedDocument } from '../lib/types/mindmap';
import { applyTreePatch } from '../lib/utils/tree';

function createTree(id = 'tree-1', createdAt = 1): MindMapTree {
  return {
    id,
    root: {
      id: 'root',
      content: 'AI 思维导图',
      collapsed: false,
      meta: {
        sourceRef: { type: 'text', text: 'AI 思维导图' },
        confidence: 1,
        type: 'main',
        createdAt,
        createdBy: 'ai',
      },
      children: [
        {
          id: 'branch-a',
          content: '分支 A',
          collapsed: false,
          meta: {
            sourceRef: { type: 'text', text: '分支 A' },
            confidence: 0.8,
            type: 'detail',
            createdAt,
            createdBy: 'ai',
          },
          children: [],
        },
        {
          id: 'branch-b',
          content: '分支 B',
          collapsed: false,
          meta: {
            sourceRef: { type: 'text', text: '分支 B' },
            confidence: 0.8,
            type: 'detail',
            createdAt,
            createdBy: 'ai',
          },
          children: [],
        },
      ],
    },
    meta: {
      title: 'AI 思维导图',
      sourceType: 'text',
      createdAt,
      updatedAt: createdAt,
      version: 1,
      truncated: false,
    },
  };
}

function createDoc(): NormalizedDocument {
  return {
    markdown: '# AI 思维导图\n\n## 原文\n\n分支 A\n\n分支 B',
    chunks: [
      {
        id: 'chunk-a',
        text: '分支 A',
        tokenEstimate: 8,
        sourceRef: { type: 'text', location: 'line:1', text: '分支 A' },
      },
      {
        id: 'chunk-b',
        text: '分支 B',
        tokenEstimate: 8,
        sourceRef: { type: 'text', location: 'line:2', text: '分支 B' },
      },
    ],
    sourceMeta: {
      type: 'text',
      title: 'AI 思维导图',
    },
  };
}

function okSummary(points: string[]) {
  return {
    ok: true,
    json: async () => ({
      points,
      proof: {
        source: 'llm',
        provider: 'zhipu',
        model: 'glm-4',
      },
    }),
  } as Response;
}

async function advanceSummaryTimer(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushAsyncState() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AiSummaryPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not auto-refresh summary when nodes are only moved, but manual refresh uses the latest tree', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okSummary(['初始摘要']))
      .mockResolvedValueOnce(okSummary(['手动刷新后的摘要']));
    vi.stubGlobal('fetch', fetchMock);

    const initialTree = createTree();
    const normalizedDocument = createDoc();
    const { rerender } = render(createElement(AiSummaryPanel, { tree: initialTree, normalizedDocument }));

    await advanceSummaryTimer(150);
    await flushAsyncState();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('初始摘要')).toBeInTheDocument();

    const movedTree = applyTreePatch(initialTree, {
      type: 'move',
      nodeId: 'branch-b',
      newParentId: 'branch-a',
      newIndex: 0,
      timestamp: Date.now(),
    });

    rerender(createElement(AiSummaryPanel, { tree: movedTree, normalizedDocument }));

    await advanceSummaryTimer(1500);
    await flushAsyncState();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('初始摘要')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重新生成摘要' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('手动刷新后的摘要')).toBeInTheDocument();

    const secondCallPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body || '{}')) as {
      normalizedDocument?: NormalizedDocument;
    };
    expect(secondCallPayload.normalizedDocument?.sourceMeta.title).toBe('AI 思维导图');
    expect(secondCallPayload.normalizedDocument?.chunks).toHaveLength(2);
  });

  it('auto-generates a new summary when switching to a newly generated tree instance', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okSummary(['旧导图摘要']))
      .mockResolvedValueOnce(okSummary(['新导图摘要']));
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(
      createElement(AiSummaryPanel, { tree: createTree('tree-1', 1), normalizedDocument: createDoc() }),
    );

    await advanceSummaryTimer(150);
    await flushAsyncState();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(
      createElement(AiSummaryPanel, {
        tree: createTree('tree-2', 2),
        normalizedDocument: {
          ...createDoc(),
          sourceMeta: { ...createDoc().sourceMeta, title: '新导图原文' },
        },
      }),
    );

    await advanceSummaryTimer(150);
    await flushAsyncState();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText('新导图摘要')).toBeInTheDocument();
  });
});

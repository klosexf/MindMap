import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MindMapTree, NormalizedDocument } from '../lib/types/mindmap';

function createTree(): MindMapTree {
  return {
    id: 'tree-persisted',
    root: {
      id: 'root-1',
      content: '人工智能发展报告 2024',
      collapsed: false,
      meta: {
        sourceRef: { type: 'pdf', page: 1, location: 'page:1', text: '人工智能发展报告 2024' },
        confidence: 0.93,
        type: 'main',
        createdAt: 1,
        createdBy: 'ai',
      },
      children: [],
    },
    meta: {
      title: '人工智能发展报告 2024',
      sourceType: 'pdf',
      sourceFileName: 'ai-report-2024.pdf',
      createdAt: 1,
      updatedAt: 1,
      version: 1,
      truncated: false,
    },
  };
}

function createDoc(): NormalizedDocument {
  return {
    markdown: '# 人工智能发展报告 2024\n\n## 第一章\n\n大模型能力持续提升。',
    chunks: [
      {
        id: 'chunk-1',
        text: '## 第一章\n\n大模型能力持续提升。',
        tokenEstimate: 24,
        sourceRef: {
          type: 'pdf',
          page: 1,
          location: 'page:1',
          text: '大模型能力持续提升。',
        },
      },
    ],
    sourceMeta: {
      type: 'pdf',
      title: '人工智能发展报告 2024',
      sourceFileName: 'ai-report-2024.pdf',
    },
  };
}

describe('GET/PATCH /api/mindmaps/[id]', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    vi.resetModules();
  });

  it('persists normalizedDocument together with the tree so editor reload can summarize from source chunks', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mindmap-record-'));
    process.chdir(tempDir);
    vi.resetModules();

    const { GET, PATCH } = await import('../app/api/mindmaps/[id]/route');
    const tree = createTree();
    const normalizedDocument = createDoc();

    const patchRes = await PATCH(
      new Request(`http://localhost/api/mindmaps/${tree.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tree, normalizedDocument }),
      }),
      { params: Promise.resolve({ id: tree.id }) },
    );

    expect(patchRes.status).toBe(200);

    const getRes = await GET(new Request(`http://localhost/api/mindmaps/${tree.id}`), {
      params: Promise.resolve({ id: tree.id }),
    });
    const json = await getRes.json();

    expect(getRes.status).toBe(200);
    expect(json.tree.id).toBe(tree.id);
    expect(json.normalizedDocument.sourceMeta.title).toBe('人工智能发展报告 2024');
    expect(json.normalizedDocument.chunks[0].sourceRef.page).toBe(1);
  });
});

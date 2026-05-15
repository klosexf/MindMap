import { describe, expect, it } from 'vitest';

import { preferDocumentTitleForRoot } from '../lib/llm/generate';
import type { SourceReference } from '../lib/types/mindmap';
import { getDefaultMindMapTree } from '../lib/utils/tree';

function sourceRef(): SourceReference {
  return { type: 'pdf', location: 'resume.pdf', text: 'resume excerpt' };
}

describe('preferDocumentTitleForRoot', () => {
  it('keeps the stronger generated root when the document title adds little beyond naming', () => {
    const tree = getDefaultMindMapTree('原始标题', sourceRef(), 'pdf');
    tree.root.content = '9年产品经理经验，覆盖商业化与增长';
    tree.meta.title = '原始标题';

    const aligned = preferDocumentTitleForRoot(tree, '谭艳丽 9年产品经理经验');

    expect(aligned.root.content).toBe('9年产品经理经验，覆盖商业化与增长');
    expect(aligned.meta.title).toBe('谭艳丽 9年产品经理经验');
  });

  it('keeps a stronger conclusion root when document title is mostly a document-type label', () => {
    const tree = getDefaultMindMapTree('原始标题', sourceRef(), 'pdf');
    tree.root.content = '研究型重度用户导向的 AI 思维导图产品';
    tree.meta.title = '原始标题';

    const aligned = preferDocumentTitleForRoot(tree, 'AI 思维导图产品 · PRD v0.1');

    expect(aligned.root.content).toBe('研究型重度用户导向的 AI 思维导图产品');
    expect(aligned.meta.title).toBe('AI 思维导图产品');
  });

  it('does not overwrite the root node with a filename-like title', () => {
    const tree = getDefaultMindMapTree('原始标题', sourceRef(), 'pdf');
    tree.root.content = '9年产品经理经验，覆盖商业化与增长';
    tree.meta.title = '原始标题';

    const aligned = preferDocumentTitleForRoot(tree, '【产品经理_深圳 15-20K】谭艳丽 9年.pdf');

    expect(aligned.root.content).toBe('9年产品经理经验，覆盖商业化与增长');
    expect(aligned.meta.title).toBe('原始标题');
  });
});

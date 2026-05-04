import { describe, expect, it } from 'vitest';

import { deduplicateNodeTitles } from '../lib/llm/generate';
import type { MindMapTree, SourceReference } from '../lib/types/mindmap';
import { createNode, getDefaultMindMapTree } from '../lib/utils/tree';

function makeSourceRef(): SourceReference {
  return { type: 'text', text: 'test' };
}

function makeTree(rootChildren: { content: string; children: { content: string }[] }[]): MindMapTree {
  const sourceRef = makeSourceRef();
  const tree = getDefaultMindMapTree('Test Tree', sourceRef, 'text');
  const root = createNode('Test Root', sourceRef, 'ai');

  root.children = rootChildren.map((child) => {
    const parentNode = createNode(child.content, sourceRef, 'ai');
    parentNode.children = child.children.map((sub) => createNode(sub.content, sourceRef, 'ai'));
    return parentNode;
  });

  return {
    ...tree,
    root,
  };
}

function getChildContents(tree: MindMapTree, parentIndex: number): string[] {
  const parent = tree.root.children?.[parentIndex];
  if (!parent || !parent.children) return [];
  return parent.children.map((c) => c.content);
}

describe('deduplicateNodeTitles', () => {
  it('passes through tree with no duplicates unchanged', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Python开发' },
          { content: 'React前端' },
          { content: 'SQL优化' },
        ],
      },
    ]);

    const result = deduplicateNodeTitles(tree);
    expect(getChildContents(result, 0)).toEqual(['Python开发', 'React前端', 'SQL优化']);
  });

  it('removes child node whose content matches parent content exactly', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: '专业技能' },
          { content: 'Python开发' },
          { content: 'React前端' },
        ],
      },
    ]);

    const result = deduplicateNodeTitles(tree);
    const children = getChildContents(result, 0);
    expect(children).not.toContain('专业技能');
    expect(children).toContain('Python开发');
    expect(children).toContain('React前端');
  });

  it('keeps child when parent title is only a substring of longer child content', () => {
    // Parent "专业技能 · Python / Java" contains child "专业技能" as substring,
    // but child is shorter than parent → NOT redundant (it's a sub-topic label)
    const tree = makeTree([
      {
        content: '专业技能 · Python / Java',
        children: [
          { content: '专业技能' },
          { content: 'Python开发' },
        ],
      },
    ]);

    const result = deduplicateNodeTitles(tree);
    const children = getChildContents(result, 0);
    expect(children).toContain('专业技能');
    expect(children).toContain('Python开发');
  });

  it('differentiates sibling nodes with identical content by adding suffix', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Python开发' },
          { content: 'Python开发' },
          { content: 'React前端' },
        ],
      },
    ]);

    const result = deduplicateNodeTitles(tree);
    const children = getChildContents(result, 0);
    expect(children.length).toBe(3);
    // First occurrence stays, second gets suffix
    expect(children.filter((c) => c.startsWith('Python开发'))).toHaveLength(2);
    expect(children).toContain('React前端');
  });

  it('renames ALL child nodes matching parent title with suffixes', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: '专业技能' },
          { content: '专业技能' },
          { content: '专业技能' },
        ],
      },
    ]);

    const result = deduplicateNodeTitles(tree);
    const children = getChildContents(result, 0);
    expect(children.length).toBe(3);
    expect(children.every((c) => c !== '专业技能')).toBe(true);
    expect(children.every((c) => c.startsWith('专业技能'))).toBe(true);
  });

  it('differentiates multiple sibling duplicates (2 repeated 3 times each) with suffixes', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Python开发' },
          { content: 'Python开发' },
          { content: 'Python开发' },
          { content: 'React前端' },
          { content: 'React前端' },
          { content: 'React前端' },
        ],
      },
    ]);

    const result = deduplicateNodeTitles(tree);
    const children = getChildContents(result, 0);
    expect(children.length).toBe(6);
    expect(children.some((c) => c === 'Python开发')).toBe(true);
    expect(children.some((c) => c === 'React前端')).toBe(true);
    // Second/third occurrences have suffix
    expect(children.filter((c) => c.includes('('))).toHaveLength(4);
  });

  it('removes parent-duplicate child AND differentiates sibling duplicates simultaneously', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: '专业技能' },
          { content: 'Python开发' },
          { content: 'Python开发' },
          { content: 'React前端' },
        ],
      },
    ]);

    const result = deduplicateNodeTitles(tree);
    const children = getChildContents(result, 0);
    expect(children).not.toContain('专业技能');
    expect(children.length).toBe(3);
  });

  it('recursively deduplicates nested children', () => {
    const sourceRef = makeSourceRef();
    const tree = getDefaultMindMapTree('Test', sourceRef, 'text');
    const root = createNode('Test Root', sourceRef, 'ai');

    const nestedDupe = createNode('Python开发', sourceRef, 'ai');
    const nestedGood = createNode('FastAPI框架', sourceRef, 'ai');
    const pythonParent = createNode('Python开发', sourceRef, 'ai');
    pythonParent.children = [nestedDupe, nestedGood];

    const backendNode = createNode('后端技术', sourceRef, 'ai');
    backendNode.children = [pythonParent];
    root.children = [backendNode];
    tree.root = root;

    const result = deduplicateNodeTitles(tree);
    const firstChild = result.root.children?.[0];
    const nested = firstChild?.children?.[0]?.children || [];
    expect(nested.map((c: { content: string }) => c.content)).toEqual(['FastAPI框架']);
  });

  it('differentiates whitespace-normalized duplicates by adding suffix', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Python  开发' },
          { content: 'Python开发' },
        ],
      },
    ]);

    const result = deduplicateNodeTitles(tree);
    const children = getChildContents(result, 0);
    // Both kept, one with suffix
    expect(children.length).toBe(2);
    expect(children.some((c) => c.includes('('))).toBe(true);
  });

  it('handles tree with no children at all without error', () => {
    const sourceRef = makeSourceRef();
    const tree = getDefaultMindMapTree('Empty', sourceRef, 'text');

    const result = deduplicateNodeTitles(tree);
    expect(result.root.content).toBe('Empty');
    expect(result.root.children).toEqual([]);
  });

  it('handles empty children arrays on parent', () => {
    const tree = makeTree([
      { content: '专业技能', children: [] },
    ]);

    const result = deduplicateNodeTitles(tree);
    expect(getChildContents(result, 0)).toEqual([]);
  });

  it('differentiates siblings with similar content (one contains the other) by suffix', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Python后端开发' },
          { content: 'Python' },
        ],
      },
    ]);

    const result = deduplicateNodeTitles(tree);
    const children = getChildContents(result, 0);
    expect(children.length).toBe(2);
    // Both kept, second has suffix
    expect(children.some((c) => c === 'Python后端开发')).toBe(true);
    expect(children.some((c) => c.includes('('))).toBe(true);
  });

  it('removes multiple parents that each have dup children to their own parent', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: '专业技能' },
          { content: 'Python' },
        ],
      },
      {
        content: '工作经历',
        children: [
          { content: '工作经历' },
          { content: '某公司项目经理' },
        ],
      },
    ]);

    const result = deduplicateNodeTitles(tree);

    const skillChildren = getChildContents(result, 0);
    expect(skillChildren).not.toContain('专业技能');
    expect(skillChildren).toContain('Python');

    const expChildren = getChildContents(result, 1);
    expect(expChildren).not.toContain('工作经历');
    expect(expChildren).toContain('某公司项目经理');
  });

  it('returns same tree when no dedup needed but creates new reference', () => {
    const tree = makeTree([
      {
        content: '专业技能',
        children: [
          { content: 'Python' },
          { content: 'React' },
        ],
      },
    ]);

    const result = deduplicateNodeTitles(tree);
    expect(getChildContents(result, 0)).toEqual(['Python', 'React']);
  });
});

import { describe, expect, it } from 'vitest';

import { buildHeuristicMindMapTree, repairSparseFirstLayerForDoc } from '../lib/llm/generate';
import type { MindMapTree, NormalizedDocument, SourceReference } from '../lib/types/mindmap';
import { createNode, getDefaultMindMapTree } from '../lib/utils/tree';

function sourceRef(): SourceReference {
  return { type: 'pdf', location: 'resume.pdf', text: 'resume excerpt' };
}

function makeDoc(): NormalizedDocument {
  const ref = sourceRef();
  return {
    markdown: [
      '资深产品经理，拥有10年以上游戏和泛娱乐行业经验。',
      '核心能力包括商业化营收、流量转化、游戏生态和团队搭建。',
      '虎牙直播任游戏事业部负责人，负责商业化营收、流量转化、游戏生态和团队搭建。',
      '腾讯游戏负责产品运营长线运营，覆盖核心运营工作、活动运营、用户运营和社区运营。',
    ].join('\n'),
    chunks: [
      {
        id: 'chunk-1',
        text: '核心能力包括商业化营收、流量转化、游戏生态和团队搭建。',
        tokenEstimate: 24,
        sourceRef: ref,
      },
      {
        id: 'chunk-2',
        text: '虎牙直播任游戏事业部负责人，负责商业化营收、流量转化、游戏生态和团队搭建。',
        tokenEstimate: 36,
        sourceRef: ref,
      },
      {
        id: 'chunk-3',
        text: '腾讯游戏负责产品运营长线运营，覆盖核心运营工作、活动运营、用户运营和社区运营。',
        tokenEstimate: 36,
        sourceRef: ref,
      },
    ],
    sourceMeta: {
      type: 'pdf',
      title: '产品经理简历',
      sourceFileName: 'resume.pdf',
    },
  };
}

function makeTree(): MindMapTree {
  const ref = sourceRef();
  const tree = getDefaultMindMapTree('产品经理简历', ref, 'pdf');
  const root = createNode('资深产品经理具备游戏商业化与运营经验', ref, 'ai');

  const capability = createNode('核心能力', ref, 'ai');
  const projects = createNode('项目经验', ref, 'ai');
  const huya = createNode('虎牙直播', ref, 'ai');
  const tencent = createNode('腾讯游戏', ref, 'ai');

  projects.children = [huya, tencent];
  root.children = [capability, projects];

  return { ...tree, root };
}

describe('branch expansion', () => {
  it('expands every sparse root branch from source-backed content', () => {
    const result = repairSparseFirstLayerForDoc(makeTree(), makeDoc());
    const capability = result.root.children?.find((node) => node.content === '核心能力');

    expect(capability?.children?.length).toBeGreaterThan(0);
    expect(capability?.children?.[0]?.content).toContain('商业化营收');
  });

  it('expands sparse second-level project nodes from source-backed content', () => {
    const result = repairSparseFirstLayerForDoc(makeTree(), makeDoc());
    const projects = result.root.children?.find((node) => node.content === '项目经验');
    const huya = projects?.children?.find((node) => node.content === '虎牙直播');
    const tencent = projects?.children?.find((node) => node.content === '腾讯游戏');

    expect(huya?.children?.length).toBeGreaterThan(0);
    expect(huya?.children?.[0]?.content).toContain('游戏事业部负责人');
    expect(tencent?.children?.length).toBeGreaterThan(0);
    expect(tencent?.children?.[0]?.content).toContain('产品运营长线运营');
  });

  it('does not use the PDF file name as the fallback root topic', () => {
    const doc = makeDoc();
    const tree = buildHeuristicMindMapTree({
      ...doc,
      markdown: [
        '# 【产品经理_深圳 18-30K】袁先生 10年以上.pdf',
        doc.markdown,
      ].join('\n\n'),
      sourceMeta: {
        ...doc.sourceMeta,
        title: '【产品经理_深圳 18-30K】袁先生 10年以上',
        sourceFileName: '【产品经理_深圳 18-30K】袁先生 10年以上.pdf',
      },
    });

    expect(tree.root.content).not.toContain('.pdf');
    expect(tree.root.content).not.toContain('产品经理_深圳 18-30K');
    expect(tree.root.content).not.toBe('思维导图');
  });

  it('does not reuse the same source sentence across multiple expanded branches', () => {
    const ref = sourceRef();
    const sharedSentence = '负责商业化营收、流量转化和团队搭建。';
    const doc: NormalizedDocument = {
      markdown: sharedSentence,
      chunks: [
        {
          id: 'shared-chunk',
          text: sharedSentence,
          tokenEstimate: 16,
          sourceRef: ref,
        },
      ],
      sourceMeta: {
        type: 'pdf',
        title: '产品经理简历',
        sourceFileName: 'resume.pdf',
      },
    };

    const tree = getDefaultMindMapTree('产品经理简历', ref, 'pdf');
    const root = createNode('产品经理兼具商业化与增长能力', ref, 'ai');
    root.children = [
      createNode('商业化能力', ref, 'ai'),
      createNode('流量转化能力', ref, 'ai'),
    ];

    const result = repairSparseFirstLayerForDoc({ ...tree, root }, doc);
    const branchDetails = (result.root.children || []).flatMap((branch) =>
      (branch.children || []).map((child) => child.content),
    );
    const normalizedSharedSentence = sharedSentence.replace(/[。！？!?,，\s]/g, '');

    expect(
      branchDetails.filter((content) => content.replace(/[。！？!?,，\s]/g, '') === normalizedSharedSentence),
    ).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';

import { removeLeafLabelNodes, splitOversizedNodeContent } from '../lib/llm/generate';
import type { MindMapNode, MindMapTree } from '../lib/types/mindmap';

/**
 * 生成管线代码层兜底测试：
 * - splitOversizedNodeContent：超长节点的拆分/截断（修复前叶层超长内容被原样保留的缺陷）
 * - removeLeafLabelNodes：二级层空标签叶子清理
 * - MAX_TREE_DEPTH=4：深度上限提升后与后处理的组合行为
 */

let idSeq = 0;
function makeNode(content: string, children: MindMapNode[] = []): MindMapNode {
  idSeq += 1;
  return {
    id: `node-${idSeq}`,
    content,
    children,
    collapsed: false,
    meta: {
      sourceRef: { type: 'text' },
      type: 'detail',
      confidence: 0.65,
      createdAt: Date.now(),
      createdBy: 'ai',
    },
  };
}

function makeTree(root: MindMapNode): MindMapTree {
  return {
    id: 'tree-1',
    root,
    meta: {
      title: '测试导图',
      sourceType: 'text',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      truncated: false,
    },
  };
}

function collectContents(node: MindMapNode, depth = 0, acc: { depth: number; content: string }[] = []): { depth: number; content: string }[] {
  acc.push({ depth, content: node.content });
  for (const child of node.children ?? []) {
    collectContents(child, depth + 1, acc);
  }
  return acc;
}

describe('splitOversizedNodeContent · 超长节点兜底', () => {
  it('无标点的叶层 OCR 长段（历史 badcase）必须被截断，不允许原样保留', () => {
    const rawContent = '产品管理是不公平的岗位期待我们同时按照创造者节奏和管理者节奏工作没有任何事情会围绕产品经理产能进行规划我们没有招聘和解雇权却被期待让事情发生且必须快速发生';
    const tree = makeTree(makeNode('根节点', [makeNode('一级分支', [makeNode('二级节点', [makeNode(rawContent)])])]));

    const result = splitOversizedNodeContent(tree);
    const contents = collectContents(result.root);
    const rawNode = contents.find((c) => c.content.startsWith('产品管理是不公平'));
    // 修复前：该节点原样保留（90+ 字）；修复后：截断到 40 字以内
    expect(rawNode).toBeDefined();
    expect(rawNode!.content.length).toBeLessThanOrEqual(40);
    expect(rawNode!.content.endsWith('…')).toBe(true);
  });

  it('带句号的长文本在可拆分层被拆分为父子结构', () => {
    const longContent = '负责从零搭建用户增长体系。通过裂变和拼团机制实现低成本增长。付费投放组合策略拉动 DAU 从 0 到 50 万。';
    const tree = makeTree(makeNode('根节点', [makeNode('一级分支', [makeNode(longContent)])]));

    const result = splitOversizedNodeContent(tree);
    const split = result.root.children![0].children![0];
    // 拆分后首句为父节点，其余句子成为子节点
    expect(split.content).toBe('负责从零搭建用户增长体系。');
    expect(split.children!.length).toBe(2);
  });

  it('短内容节点不受影响', () => {
    const tree = makeTree(makeNode('根节点', [makeNode('正常短节点')]));
    const result = splitOversizedNodeContent(tree);
    expect(result.root.children![0].content).toBe('正常短节点');
  });

  it('日期/版本号中的句点不被当作句界拆碎（历史 badcase）', () => {
    const longContent = '工作经历：深圳众诚智学科技有限公司商业化产品经理（2021.06-2022.07）';
    const tree = makeTree(makeNode('根节点', [makeNode('一级分支', [makeNode(longContent)])]));

    const result = splitOversizedNodeContent(tree);
    const contents = collectContents(result.root).map((c) => c.content);
    // 修复前：按「2021.」句点拆成 （2021 / 06-2022 / 07）；修复后：日期完整保留
    expect(contents.some((c) => c.includes('2021.06-2022.07'))).toBe(true);
    expect(contents).not.toContain('06-2022');
    expect(contents).not.toContain('07）');
  });
});

describe('removeLeafLabelNodes · 二级空标签叶子清理', () => {
  it('删除无子节点的泛化标签二级叶子（历史 badcase）', () => {
    const tree = makeTree(
      makeNode('根节点', [
        makeNode('不公平岗位的本质价值', [
          makeNode('要求巨大责任与极端适应能力', [makeNode('承担巨大责任')]),
          makeNode('回报这些能力的岗位特征'),
          makeNode('AI时代继续发展的独特条件'),
        ]),
      ]),
    );

    const result = removeLeafLabelNodes(tree);
    const contents = collectContents(result.root).map((c) => c.content);
    expect(contents).not.toContain('回报这些能力的岗位特征');
    expect(contents).not.toContain('AI时代继续发展的独特条件');
    expect(contents).toContain('要求巨大责任与极端适应能力');
  });

  it('保留有实质内容的二级短叶子（不以标签词结尾）', () => {
    const tree = makeTree(
      makeNode('根节点', [makeNode('不公平现实', [makeNode('无招聘解雇权却需让事情发生')])]),
    );
    const result = removeLeafLabelNodes(tree);
    expect(collectContents(result.root).map((c) => c.content)).toContain('无招聘解雇权却需让事情发生');
  });

  it('保留有子节点的二级标签式节点与一级分支', () => {
    const tree = makeTree(
      makeNode('根节点', [
        makeNode('不公平的现实挑战', [makeNode('有展开的背景', [makeNode('具体内容')])]),
      ]),
    );
    const result = removeLeafLabelNodes(tree);
    const contents = collectContents(result.root).map((c) => c.content);
    // 一级分支以"挑战"结尾不受影响；二级节点有子节点不删
    expect(contents).toContain('不公平的现实挑战');
    expect(contents).toContain('有展开的背景');
  });
});

describe('MAX_TREE_DEPTH 提升后的组合行为', () => {
  it('深度 4 层结构：中间层超长节点拆分后子节点落在第 4 层', () => {
    const longContent = '第一步完成基础设施搭建与团队组建。第二步完成多数据源接入与清洗。第三步上线监控告警与值班响应机制。';
    const tree = makeTree(
      makeNode('根节点', [
        makeNode('一级分支', [makeNode('二级策略', [makeNode(longContent)])]),
      ]),
    );
    const result = splitOversizedNodeContent(tree);
    const contents = collectContents(result.root);
    // depth 3 的超长节点在 MAX_TREE_DEPTH=4 下可拆分，子节点落 depth 4
    const splitParent = result.root.children![0].children![0].children![0];
    expect(splitParent.content).toBe('第一步完成基础设施搭建与团队组建。');
    expect(splitParent.children!.length).toBe(2);
    expect(contents.some((c) => c.depth === 4)).toBe(true);
  });
});

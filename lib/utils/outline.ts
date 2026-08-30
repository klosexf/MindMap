import { type MindMapNode, type MindMapTree } from '@/lib/types/mindmap';
import { findNode } from '@/lib/utils/tree';

/**
 * 思维导图 ↔ 文字大纲 双向转换。
 *
 * 大纲文档采用扁平 items（含 depth）而非嵌套树，方便渲染层直接映射为
 * 缩进列表；nodeId 全程保留，编辑操作可通过 id 映射回原树节点，
 * 保证转换无损（round-trip 后结构与内容完全一致）。
 */

export interface OutlineItem {
  nodeId: string;
  content: string;
  /** 根节点为 0，一级主题为 1，以此类推 */
  depth: number;
}

export interface OutlineDoc {
  rootId: string;
  /** 文档主标题：优先取 meta.title，否则取根节点内容 */
  title: string;
  /** 根节点内容（作为文档 H1 展示，可编辑） */
  rootContent: string;
  /** 根节点以下的扁平大纲条目（depth 从 1 开始） */
  items: OutlineItem[];
}

/** 思维导图树 → 大纲文档（展开全部节点，不受 collapsed 影响） */
export function treeToOutlineDoc(tree: MindMapTree): OutlineDoc {
  const items: OutlineItem[] = [];

  function walk(node: MindMapNode, depth: number): void {
    if (depth > 0) {
      items.push({ nodeId: node.id, content: node.content, depth });
    }
    node.children?.forEach((child) => walk(child, depth + 1));
  }

  tree.root.children?.forEach((child) => walk(child, 1));

  return {
    rootId: tree.root.id,
    title: tree.meta.title || tree.root.content,
    rootContent: tree.root.content,
    items,
  };
}

/**
 * 大纲文档 → 思维导图树。
 *
 * 按 depth 重建层级；每个节点的 meta/style/position 等字段通过 nodeId
 * 从 sourceTree 原样保留（找不到时回退为空节点骨架），确保内容完整性。
 * 传入 outline 的 items 必须满足：depth 相对前一项涨幅 ≤ 1，否则该条目
 * 会被提升到最近一个合法层级（防御性容错，不抛错）。
 */
export function outlineDocToTree(
  doc: OutlineDoc,
  sourceTree: MindMapTree,
): MindMapTree {
  const nodeById = new Map<string, MindMapNode>();
  function index(node: MindMapNode): void {
    nodeById.set(node.id, node);
    node.children?.forEach(index);
  }
  index(sourceTree.root);

  const rootNode = nodeById.get(doc.rootId);
  const nextTree: MindMapTree = {
    ...structuredClone(sourceTree),
    root: {
      id: doc.rootId,
      content: doc.rootContent,
      children: [],
      collapsed: rootNode?.collapsed ?? false,
      ...(rootNode?.style ? { style: rootNode.style } : {}),
      ...(rootNode?.position ? { position: rootNode.position } : {}),
      meta: rootNode
        ? { ...rootNode.meta }
        : { ...sourceTree.root.meta, type: 'detail', createdAt: Date.now(), createdBy: 'user' },
    },
  };

  // 挂载点栈：栈顶为当前 depth 的最新父节点
  const stack: Array<{ depth: number; node: MindMapNode }> = [
    { depth: 0, node: nextTree.root },
  ];

  for (const item of doc.items) {
    let depth = item.depth;
    // 容错：depth 不得超过前一项 + 1
    const prevDepth = stack[stack.length - 1].depth;
    if (depth > prevDepth + 1) depth = prevDepth + 1;

    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].node;

    const original = nodeById.get(item.nodeId);
    const node: MindMapNode = {
      id: item.nodeId,
      content: item.content,
      children: [],
      collapsed: original?.collapsed ?? false,
      ...(original?.style ? { style: original.style } : {}),
      ...(original?.position ? { position: original.position } : {}),
      meta: original
        ? { ...original.meta }
        : { ...nextTree.root.meta, type: 'detail', createdAt: Date.now(), createdBy: 'user' },
    };

    parent.children = parent.children ?? [];
    parent.children.push(node);
    stack.push({ depth, node });
  }

  return nextTree;
}

/** 校验一轮转换后内容与层级完全一致（用于测试与运行时断言） */
export function outlineRoundTripLossless(tree: MindMapTree): boolean {
  const doc = treeToOutlineDoc(tree);
  const rebuilt = outlineDocToTree(doc, tree);

  function sameShape(a: MindMapNode, b: MindMapNode): boolean {
    if (a.id !== b.id || a.content !== b.content) return false;
    const ac = a.children ?? [];
    const bc = b.children ?? [];
    if (ac.length !== bc.length) return false;
    return ac.every((child, i) => sameShape(child, bc[i]));
  }

  return sameShape(tree.root, rebuilt.root);
}

/** 供编辑器复用：按 id 在大纲文档中定位条目索引 */
export function findOutlineItemIndex(doc: OutlineDoc, nodeId: string): number {
  return doc.items.findIndex((item) => item.nodeId === nodeId);
}

/** 复用 tree 工具：确认节点存在（大纲编辑前校验） */
export function outlineNodeExists(tree: MindMapTree, nodeId: string): boolean {
  return Boolean(findNode(tree.root, nodeId));
}

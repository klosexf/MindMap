import type { MindMapNode, MindMapTree } from '@/lib/types/mindmap';

/**
 * 演示模式工具：把整张导图折叠到只剩根节点，然后按分支顺序（DFS 前序）
 * 逐步展开，配合画布聚焦形成「逐层讲述」的演示节奏。
 */

function hasChildren(node: MindMapNode): boolean {
  return (node.children?.length ?? 0) > 0;
}

function collapseDeep(node: MindMapNode): MindMapNode {
  if (!hasChildren(node)) return node;

  return {
    ...node,
    collapsed: true,
    children: node.children!.map(collapseDeep),
  };
}

/**
 * 返回一份「所有可折叠节点都折叠」的新树，供进入演示模式时使用。
 * 不修改输入树；meta/version 保持不变，退出演示时用快照原样恢复。
 */
export function collapseAllForPresentation(tree: MindMapTree): MindMapTree {
  return {
    ...tree,
    root: collapseDeep(tree.root),
  };
}

/**
 * 展开步骤序列（DFS 前序）：先展开根，再依次深挖每个分支。
 * 只包含「有子节点」的节点；叶子节点无需展开。
 */
export function buildPresentationSteps(root: MindMapNode): string[] {
  const steps: string[] = [];

  function walk(node: MindMapNode): void {
    if (!hasChildren(node)) return;

    steps.push(node.id);
    for (const child of node.children!) {
      walk(child);
    }
  }

  walk(root);
  return steps;
}

import { nanoid } from 'nanoid';
import {
  type MindMapNode,
  type MindMapTree,
  type SourceReference,
  type TreePatch,
} from '@/lib/types/mindmap';

export const MAX_TREE_DEPTH = 3;
export const MAX_TREE_NODES = 500;

export function createSourceRefFallback(sourceRef: Partial<SourceReference>): SourceReference {
  return {
    type: sourceRef.type ?? 'text',
    location: sourceRef.location,
    page: sourceRef.page,
    timestamp: sourceRef.timestamp,
    url: sourceRef.url,
    text: sourceRef.text,
  };
}

export function createNode(
  content: string,
  sourceRef: SourceReference,
  createdBy: 'ai' | 'user' = 'user',
): MindMapNode {
  const now = Date.now();
  return {
    id: nanoid(),
    content,
    collapsed: false,
    children: [],
    meta: {
      sourceRef,
      type: 'detail',
      confidence: createdBy === 'ai' ? 0.8 : 1,
      createdAt: now,
      createdBy,
      editedAt: now,
      editedBy: createdBy,
    },
  };
}

export function traverseTree(
  node: MindMapNode,
  cb: (node: MindMapNode, parentId?: string, index?: number) => void,
  parentId?: string,
  index?: number,
): void {
  cb(node, parentId, index);
  if (!node.children?.length) return;

  node.children.forEach((child, childIndex) => {
    traverseTree(child, cb, node.id, childIndex);
  });
}

export function flattenTree(root: MindMapNode): Array<{ node: MindMapNode; parentId?: string; index: number }> {
  const list: Array<{ node: MindMapNode; parentId?: string; index: number }> = [];

  function walk(node: MindMapNode, parentId: string | undefined, index: number): void {
    list.push({ node, parentId, index });
    if (!node.children?.length) return;
    node.children.forEach((child, childIndex) => walk(child, node.id, childIndex));
  }

  walk(root, undefined, 0);
  return list;
}

export function countNodes(root: MindMapNode): number {
  let count = 0;
  traverseTree(root, () => {
    count += 1;
  });
  return count;
}

export function findNode(root: MindMapNode, nodeId: string): MindMapNode | undefined {
  if (root.id === nodeId) return root;
  if (!root.children?.length) return undefined;

  for (const child of root.children) {
    const hit = findNode(child, nodeId);
    if (hit) return hit;
  }

  return undefined;
}

export function applyTreePatch(tree: MindMapTree, patch: TreePatch): MindMapTree {
  const nextTree = structuredClone(tree);

  switch (patch.type) {
    case 'add': {
      const parent = findNode(nextTree.root, patch.parentId);
      if (!parent) return nextTree;

      parent.children = parent.children ?? [];
      const safeIndex = Math.max(0, Math.min(patch.index, parent.children.length));
      parent.children.splice(safeIndex, 0, patch.node);
      break;
    }
    case 'update': {
      const target = findNode(nextTree.root, patch.nodeId);
      if (!target) return nextTree;

      Object.assign(target, patch.node);
      target.meta = {
        ...target.meta,
        ...(patch.node.meta ?? {}),
        editedAt: Date.now(),
      };
      break;
    }
    case 'toggleCollapse': {
      const target = findNode(nextTree.root, patch.nodeId);
      if (!target) return nextTree;

      target.collapsed = !target.collapsed;
      target.meta.editedAt = Date.now();
      target.meta.editedBy = 'user';
      break;
    }
    case 'delete': {
      if (nextTree.root.id === patch.nodeId) {
        return nextTree;
      }

      function removeFrom(node: MindMapNode): boolean {
        if (!node.children?.length) return false;
        const idx = node.children.findIndex((child) => child.id === patch.nodeId);
        if (idx >= 0) {
          node.children.splice(idx, 1);
          return true;
        }

        return node.children.some((child) => removeFrom(child));
      }

      removeFrom(nextTree.root);
      break;
    }
    default:
      return nextTree;
  }

  nextTree.meta.updatedAt = Date.now();
  nextTree.meta.version += 1;
  return nextTree;
}

export function clampTree(tree: MindMapTree, maxDepth = MAX_TREE_DEPTH, maxNodes = MAX_TREE_NODES): MindMapTree {
  const next = structuredClone(tree);
  let visited = 0;
  let truncated = false;

  function walk(node: MindMapNode, depth: number): void {
    visited += 1;

    if (visited > maxNodes) {
      node.children = [];
      truncated = true;
      return;
    }

    if (depth >= maxDepth) {
      if ((node.children?.length ?? 0) > 0) {
        truncated = true;
      }
      node.children = [];
      return;
    }

    if (!node.children?.length) return;

    const keptChildren: MindMapNode[] = [];
    for (const child of node.children) {
      if (visited >= maxNodes) {
        truncated = true;
        break;
      }
      keptChildren.push(child);
      walk(child, depth + 1);
    }
    node.children = keptChildren;
  }

  walk(next.root, 0);
  next.meta.truncated = truncated;
  next.meta.updatedAt = Date.now();
  return next;
}

export function treeToMarkdown(node: MindMapNode, depth = 0): string {
  const prefix = depth === 0 ? '# ' : `${'  '.repeat(depth - 1)}- `;
  let output = `${prefix}${node.content}\n`;

  if (node.children?.length) {
    node.children.forEach((child) => {
      output += treeToMarkdown(child, depth + 1);
    });
  }

  return output;
}

export function getDefaultMindMapTree(title: string, sourceRef: SourceReference, sourceType: MindMapTree['meta']['sourceType']): MindMapTree {
  const now = Date.now();
  return {
    id: nanoid(),
    root: {
      id: nanoid(),
      content: title || '未命名导图',
      children: [],
      collapsed: false,
      meta: {
        sourceRef,
        type: 'main',
        confidence: 1,
        createdAt: now,
        createdBy: 'ai',
      },
    },
    meta: {
      title,
      sourceType,
      createdAt: now,
      updatedAt: now,
      version: 1,
      truncated: false,
    },
  };
}

export function normalizeNodeIds(root: MindMapNode, sourceRef: SourceReference): MindMapNode {
  const next = structuredClone(root);

  function walk(node: MindMapNode): void {
    if (!node.id) node.id = nanoid();
    node.meta = {
      sourceRef,
      type: node.meta?.type ?? 'detail',
      confidence: node.meta?.confidence ?? 0.8,
      createdAt: node.meta?.createdAt ?? Date.now(),
      createdBy: node.meta?.createdBy ?? 'ai',
      editedAt: node.meta?.editedAt,
      editedBy: node.meta?.editedBy,
    };

    if (!node.children) {
      node.children = [];
      return;
    }

    node.children.forEach((child) => walk(child));
  }

  walk(next);
  return next;
}

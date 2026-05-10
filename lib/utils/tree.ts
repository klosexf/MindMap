import { nanoid } from 'nanoid';
import {
  type MindMapNode,
  type MindMapTree,
  type SourceReference,
  type TreePatch,
} from '@/lib/types/mindmap';

export const MAX_TREE_DEPTH = 3;
export const MAX_TREE_NODES = 500;
const DROP_SIBLING_EDGE_PX = 24;
export const DROP_BORDER_PROXIMITY_PX = 36;

export type DropMoveMode = 'child' | 'sibling';
export type DropSiblingPlacement = 'before' | 'after';

export interface ParentInfo {
  parentId: string;
  index: number;
}

export interface PointLike {
  x: number;
  y: number;
}

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RectProximityCandidate {
  id: string;
  rect: RectLike;
}

export interface RectProximityMatch {
  id: string;
  distance: number;
}

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

export function findParentInfo(root: MindMapNode, nodeId: string): ParentInfo | null {
  if (!root.children?.length) return null;

  const index = root.children.findIndex((child) => child.id === nodeId);
  if (index >= 0) {
    return {
      parentId: root.id,
      index,
    };
  }

  for (const child of root.children) {
    const found = findParentInfo(child, nodeId);
    if (found) return found;
  }

  return null;
}

export function resolveDropMoveTarget(
  root: MindMapNode,
  movingNodeId: string,
  targetNodeId: string,
  mode: DropMoveMode,
  siblingPlacement: DropSiblingPlacement = 'after',
): { newParentId: string; newIndex: number } | null {
  if (!movingNodeId || !targetNodeId) return null;
  if (movingNodeId === targetNodeId) return null;
  if (root.id === movingNodeId) return null;

  const movingNode = findNode(root, movingNodeId);
  const targetNode = findNode(root, targetNodeId);
  if (!movingNode || !targetNode) return null;

  if (mode === 'child') {
    if (isDescendant(root, movingNodeId, targetNodeId)) return null;
    const childCount = targetNode.children?.length ?? 0;
    return {
      newParentId: targetNodeId,
      newIndex: childCount,
    };
  }

  const targetParent = findParentInfo(root, targetNodeId);
  if (!targetParent) return null;
  if (movingNodeId === targetParent.parentId) return null;
  if (isDescendant(root, movingNodeId, targetParent.parentId)) return null;

  let newIndex = siblingPlacement === 'before' ? targetParent.index : targetParent.index + 1;
  const movingParent = findParentInfo(root, movingNodeId);
  if (movingParent && movingParent.parentId === targetParent.parentId && movingParent.index < newIndex) {
    newIndex -= 1;
  }

  return {
    newParentId: targetParent.parentId,
    newIndex: Math.max(0, newIndex),
  };
}

export function inferDropModeFromPoint(
  point: PointLike,
  rect: RectLike,
  direction: 'LR' | 'RL' | 'TB' | 'BT' = 'LR',
): DropMoveMode {
  const isHorizontalLayout = direction === 'LR' || direction === 'RL';

  if (isHorizontalLayout) {
    const edgeBand = Math.max(12, Math.min(DROP_SIBLING_EDGE_PX, rect.width / 4));
    const leftEdge = rect.left + edgeBand;
    const rightEdge = rect.left + rect.width - edgeBand;
    return point.x > leftEdge && point.x < rightEdge ? 'child' : 'sibling';
  }

  const edgeBand = Math.max(12, Math.min(DROP_SIBLING_EDGE_PX, rect.height / 4));
  const topEdge = rect.top + edgeBand;
  const bottomEdge = rect.top + rect.height - edgeBand;
  return point.y > topEdge && point.y < bottomEdge ? 'child' : 'sibling';
}

function normalizeRect(rect: RectLike): RectLike {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  return {
    left: Math.min(rect.left, right),
    top: Math.min(rect.top, bottom),
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

function isValidRect(rect: RectLike): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function rectCenterDistance(a: RectLike, b: RectLike): number {
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  const bx = b.left + b.width / 2;
  const by = b.top + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

export function rectBorderDistance(a: RectLike, b: RectLike): number {
  const source = normalizeRect(a);
  const target = normalizeRect(b);

  const sourceRight = source.left + source.width;
  const sourceBottom = source.top + source.height;
  const targetRight = target.left + target.width;
  const targetBottom = target.top + target.height;

  const dx = Math.max(target.left - sourceRight, source.left - targetRight, 0);
  const dy = Math.max(target.top - sourceBottom, source.top - targetBottom, 0);
  return Math.hypot(dx, dy);
}

export function findClosestRectByBorderProximity(
  draggingRect: RectLike,
  candidates: RectProximityCandidate[],
  maxDistance = DROP_BORDER_PROXIMITY_PX,
): RectProximityMatch | null {
  if (!isValidRect(draggingRect) || maxDistance < 0) return null;

  const source = normalizeRect(draggingRect);
  let best: { id: string; distance: number; centerDistance: number } | null = null;

  for (const candidate of candidates) {
    if (!candidate.id || !isValidRect(candidate.rect)) continue;

    const target = normalizeRect(candidate.rect);
    const distance = rectBorderDistance(source, target);
    if (distance > maxDistance) continue;

    const centerDistance = rectCenterDistance(source, target);
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && centerDistance < best.centerDistance)
    ) {
      best = {
        id: candidate.id,
        distance,
        centerDistance,
      };
    }
  }

  return best ? { id: best.id, distance: best.distance } : null;
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
    case 'move': {
      if (patch.nodeId === patch.newParentId) return nextTree;
      if (nextTree.root.id === patch.nodeId) return nextTree;

      if (isDescendant(nextTree.root, patch.nodeId, patch.newParentId)) return nextTree;

      const movedNode = removeNode(nextTree.root, patch.nodeId);
      if (!movedNode) return nextTree;

      clearNodePositions(movedNode);

      const newParent = findNode(nextTree.root, patch.newParentId);
      if (!newParent) return nextTree;

      newParent.children = newParent.children ?? [];
      const safeIndex = Math.max(0, Math.min(patch.newIndex, newParent.children.length));
      newParent.children.splice(safeIndex, 0, movedNode);
      break;
    }
    case 'position': {
      const target = findNode(nextTree.root, patch.nodeId);
      if (!target) return nextTree;

      target.position = patch.position;
      target.meta.editedAt = Date.now();
      target.meta.editedBy = 'user';
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

export function isDescendant(root: MindMapNode, ancestorId: string, targetId: string): boolean {
  const ancestor = findNode(root, ancestorId);
  if (!ancestor?.children?.length) return false;

  for (const child of ancestor.children) {
    if (child.id === targetId) return true;
    if (isDescendant(child, child.id, targetId)) return true;
  }
  return false;
}

export function removeNode(root: MindMapNode, nodeId: string): MindMapNode | null {
  if (!root.children?.length) return null;

  const idx = root.children.findIndex((child) => child.id === nodeId);
  if (idx >= 0) {
    const [removed] = root.children.splice(idx, 1);
    return removed;
  }

  for (const child of root.children) {
    const removed = removeNode(child, nodeId);
    if (removed) return removed;
  }
  return null;
}

export function clearNodePositions(node: MindMapNode): void {
  delete node.position;
  if (!node.children?.length) return;
  node.children.forEach((child) => clearNodePositions(child));
}

export function balanceChildren(tree: MindMapTree): MindMapTree {
  const nextTree = structuredClone(tree);
  const root = nextTree.root;

  if (!root.children?.length) return nextTree;

  const leftGroup: MindMapNode[] = [];
  const rightGroup: MindMapNode[] = [];

  root.children.forEach((child, index) => {
    if (index % 2 === 0) {
      leftGroup.push(child);
    } else {
      rightGroup.push(child);
    }
  });

  root.children = [...leftGroup, ...rightGroup.reverse()];

  nextTree.meta.updatedAt = Date.now();
  nextTree.meta.version += 1;
  return nextTree;
}

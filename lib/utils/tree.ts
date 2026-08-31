import { nanoid } from 'nanoid';
import {
  type MindMapNode,
  type MindMapTree,
  type SourceReference,
  type TreePatch,
} from '@/lib/types/mindmap';

export const MAX_TREE_DEPTH = 4;
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

/**
 * 最小骨架树：仅保留根节点（剥离全部子树），用于实时生成的首个 skeleton——
 * 客户端秒级进入编辑器时只看到根节点，其余内容经 node 事件逐个回放，
 * 避免「启发式粗稿整树预览」与最终 LLM 结果不符的观感。
 */
export function rootOnlyTree(tree: MindMapTree): MindMapTree {
  return {
    ...tree,
    root: { ...tree.root, children: [] },
    meta: { ...tree.meta },
  };
}

/**
 * 逐节点回放事件（DFS 先序，父节点先于子节点）。
 * 每个事件的 node 剥离 children——单个 add patch 只携带该节点本身，
 * 客户端按节拍逐个应用即可获得「一个一个生长」的呈现效果。
 */
export function* progressiveTreePatches(
  tree: MindMapTree,
): Generator<{ patch: TreePatch; node: MindMapNode }> {
  const flattened = flattenTree(tree.root);
  for (const item of flattened.slice(1)) {
    if (!item.parentId) continue;
    const bare: MindMapNode = { ...item.node, children: [] };
    yield {
      patch: {
        type: 'add',
        nodeId: item.node.id,
        parentId: item.parentId,
        index: item.index,
        node: bare,
        timestamp: Date.now(),
      },
      node: bare,
    };
  }
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

/** 收集节点全部后代 id（不含自身），深度优先。用于拖拽时整棵子树跟随移动。 */
export function collectDescendantIds(node: MindMapNode): string[] {
  const ids: string[] = [];
  const walk = (current: MindMapNode): void => {
    for (const child of current.children ?? []) {
      ids.push(child.id);
      walk(child);
    }
  };
  walk(node);
  return ids;
}

export function getNodeDepth(root: MindMapNode, nodeId: string): number | null {
  if (root.id === nodeId) return 0;

  for (const child of root.children || []) {
    const depth = getNodeDepth(child, nodeId);
    if (depth !== null) return depth + 1;
  }

  return null;
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

const TRAILING_DANGLING_RE = /[，、；;,.。]+$/;

/** 剥离节点末尾的悬垂标点（逗号/顿号/分号等截断残留） */
export function stripTrailingDanglingPunctuation(content: string): string {
  return content.replace(TRAILING_DANGLING_RE, '').trim();
}

const TRAILING_CONNECTIVE_RE = /(?:[是与和或及的]\s*)+$/;

/**
 * 剥离节点末尾的连接词/结构助词残尾（句中截断特征，如「不公平是」→「不公平」、
 * 「不公平的」→「不公平」）。
 * 保守条件：剥离后剩余非空白字符 ≥ 2，避免误伤「目的」「总和」「于是」等
 * 以连接字结尾的完整词（这类词剥离后只剩 1 字，会被长度守卫拦下）。
 */
export function stripTrailingConnectiveParticles(content: string): string {
  const stripped = content.replace(TRAILING_CONNECTIVE_RE, '').trim();
  if (stripped === content.trim()) return content.trim();
  if (stripped.replace(/\s/g, '').length < 2) return content.trim();
  return stripped;
}

/**
 * 剥离节点开头的孤立数字残片（OCR/解析碎片，如「06 深圳产品羽兔网…」）。
 * 保守条件：仅 1-4 位数字 + 空白 + 非数字正文，且剥离后剩余内容足够长；
 * 不影响「3-5人团队」「199万」等以数字开头的正常信息。
 */
export function stripLeadingFragmentDigits(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^(\d{1,4})(\s+)(\D.*)$/s);
  if (!match) return trimmed;
  const rest = match[3].trim();
  // 剥离后必须仍是可读内容（≥4 个非空白字符）
  if (rest.replace(/\s/g, '').length < 4) return trimmed;
  // 首位数字后紧跟的正文若以日期/时间词开头则视为时间残片，一并不可依赖——仅剥离数字本身
  return rest;
}

/** 未闭合括号尾部若为日期区间（如 `公司（2023.03-2023.06`），补齐右括号 */
export function repairUnclosedDateBracket(content: string): string {
  const fullOpen = (content.match(/（/g) ?? []).length;
  const fullClose = (content.match(/）/g) ?? []).length;
  if (
    fullOpen > fullClose &&
    /（[^（）]*\d{4}(?:\.\d{1,2})?\s*[-–—~至]\s*\d{4}(?:\.\d{1,2})?[^（）]*$/.test(content)
  ) {
    return `${content}）`;
  }
  const halfOpen = (content.match(/\(/g) ?? []).length;
  const halfClose = (content.match(/\)/g) ?? []).length;
  if (
    halfOpen > halfClose &&
    /\([^()]*\d{4}(?:\.\d{1,2})?\s*[-–—~至]\s*\d{4}(?:\.\d{1,2})?[^()]*$/.test(content)
  ) {
    return `${content})`;
  }
  return content;
}

/** 以 content + 子树结构生成签名（忽略 id/meta，用于同父去重） */
function subtreeSignature(node: MindMapNode): string {
  const children = (node.children ?? []).map(subtreeSignature).join('|');
  return `${node.content}(${children})`;
}

/** 同父节点下结构完全相同的子树去重（保留首个）——修复 LLM 重复生成问题 */
export function dedupeSiblingSubtrees(node: MindMapNode): MindMapNode {
  if (!node.children?.length) return node;
  const seen = new Set<string>();
  const children = node.children
    .map((child) => dedupeSiblingSubtrees(child))
    .filter((child) => {
      const signature = subtreeSignature(child);
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    });
  return { ...node, children };
}

/**
 * 树内容机械清理（代码层兜底，不依赖模型自检）：
 * 悬垂标点剥离 + 连接词残尾剥离 + 开头数字残片剥离 + 日期区间括号闭合 + 同父重复子树去重。
 */
export function sanitizeTreeContent(tree: MindMapTree): MindMapTree {
  const cleanNode = (node: MindMapNode): MindMapNode => ({
    ...node,
    content: repairUnclosedDateBracket(
      stripTrailingConnectiveParticles(
        stripTrailingDanglingPunctuation(stripLeadingFragmentDigits(node.content)),
      ),
    ),
    children: (node.children ?? []).map(cleanNode),
  });
  return { ...tree, root: dedupeSiblingSubtrees(cleanNode(tree.root)) };
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

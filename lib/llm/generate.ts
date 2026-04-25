import { nanoid } from 'nanoid';
import { streamObject } from 'ai';
import { openai } from '@ai-sdk/openai';

import {
  llmTreeSchema,
  mindMapTreeSchema,
  type LLMMindMapTree,
  type MindMapNode,
  type MindMapTree,
  type NormalizedDocument,
  type SourceReference,
  type TreePatch,
} from '@/lib/types/mindmap';
import {
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  applyTreePatch,
  clampTree,
  countNodes,
  createSourceRefFallback,
  flattenTree,
  getDefaultMindMapTree,
} from '@/lib/utils/tree';

export type GenerateStreamEvent =
  | { type: 'skeleton'; data: { tree: MindMapTree } }
  | { type: 'node'; data: { patch: TreePatch; node: MindMapNode } }
  | { type: 'complete'; data: { tree: MindMapTree } }
  | { type: 'error'; data: { message: string } };

interface IndexedNode {
  node: MindMapNode;
  parentId?: string;
  index: number;
}

function makeDefaultSourceRef(doc: NormalizedDocument): SourceReference {
  return createSourceRefFallback({
    type: doc.sourceMeta.type,
    url: doc.sourceMeta.sourceUrl,
    location: doc.sourceMeta.sourceFileName,
    text: doc.chunks[0]?.text?.slice(0, 240),
    page: doc.sourceMeta.type === 'pdf' ? 1 : undefined,
  });
}

function createNodeFromLLM(raw: { content: string; children?: { content: string; children?: any[] }[] }, sourceRef: SourceReference): MindMapNode {
  const now = Date.now();
  return {
    id: nanoid(),
    content: raw.content.trim(),
    collapsed: false,
    meta: {
      sourceRef,
      type: 'detail',
      confidence: 0.82,
      createdAt: now,
      createdBy: 'ai',
    },
    children: (raw.children || []).map((child) => createNodeFromLLM(child, sourceRef)),
  };
}

function sanitizePartialNode(raw: unknown): { content: string; children?: any[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as { content?: unknown; children?: unknown };
  if (typeof node.content !== 'string' || !node.content.trim()) return null;

  const normalized: { content: string; children?: any[] } = { content: node.content.trim() };
  if (Array.isArray(node.children)) {
    normalized.children = node.children
      .map((child) => sanitizePartialNode(child))
      .filter((item): item is { content: string; children?: any[] } => Boolean(item));
  }

  return normalized;
}

function llmTreeToMindMapTree(llmTree: LLMMindMapTree, doc: NormalizedDocument): MindMapTree {
  const sourceRef = makeDefaultSourceRef(doc);
  const root = createNodeFromLLM(llmTree.root, sourceRef);
  root.meta.type = 'main';

  const tree = {
    ...getDefaultMindMapTree(llmTree.title || doc.sourceMeta.title || '思维导图', sourceRef, doc.sourceMeta.type),
    root,
  };

  const clamped = clampTree(tree, MAX_TREE_DEPTH, MAX_TREE_NODES);
  return mindMapTreeSchema.parse(clamped);
}

function buildDiffPatches(prevTree: MindMapTree, nextTree: MindMapTree): TreePatch[] {
  const prevMap = new Map<string, IndexedNode>();
  const nextMap = new Map<string, IndexedNode>();

  flattenTree(prevTree.root).forEach((item) => {
    prevMap.set(item.node.id, item);
  });
  flattenTree(nextTree.root).forEach((item) => {
    nextMap.set(item.node.id, item);
  });

  const patches: TreePatch[] = [];

  for (const [id, current] of nextMap.entries()) {
    const previous = prevMap.get(id);

    if (!previous && current.parentId) {
      patches.push({
        type: 'add',
        nodeId: id,
        parentId: current.parentId,
        index: current.index,
        node: current.node,
        timestamp: Date.now(),
      });
      continue;
    }

    if (previous) {
      const contentChanged = previous.node.content !== current.node.content;
      const collapsedChanged = (previous.node.collapsed ?? false) !== (current.node.collapsed ?? false);
      if (contentChanged || collapsedChanged) {
        patches.push({
          type: 'update',
          nodeId: id,
          node: {
            content: current.node.content,
            collapsed: current.node.collapsed,
          },
          timestamp: Date.now(),
        });
      }
    }
  }

  for (const [id] of prevMap.entries()) {
    if (!nextMap.has(id) && id !== prevTree.root.id) {
      patches.push({
        type: 'delete',
        nodeId: id,
        timestamp: Date.now(),
      });
    }
  }

  return patches;
}

function heuristicTreeFromDocument(doc: NormalizedDocument): MindMapTree {
  const sourceRef = makeDefaultSourceRef(doc);
  const title = doc.sourceMeta.title || '快速生成导图';

  const sentences = doc.markdown
    .replace(/^#.*$/gm, '')
    .split(/[。！？.!?\n]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);

  const root: MindMapNode = {
    id: nanoid(),
    content: title,
    collapsed: false,
    meta: {
      sourceRef,
      type: 'main',
      confidence: 0.7,
      createdAt: Date.now(),
      createdBy: 'ai',
    },
    children: [],
  };

  const grouped = [
    { title: '核心概念', items: sentences.slice(0, 4) },
    { title: '关键细节', items: sentences.slice(4, 8) },
    { title: '行动建议', items: sentences.slice(8, 12) },
  ];

  for (const group of grouped) {
    const branch: MindMapNode = {
      id: nanoid(),
      content: group.title,
      collapsed: false,
      meta: {
        sourceRef,
        type: 'detail',
        confidence: 0.65,
        createdAt: Date.now(),
        createdBy: 'ai',
      },
      children: [],
    };

    group.items.forEach((item) => {
      branch.children?.push({
        id: nanoid(),
        content: item.slice(0, 80),
        collapsed: false,
        meta: {
          sourceRef,
          type: group.title === '行动建议' ? 'action' : 'detail',
          confidence: 0.62,
          createdAt: Date.now(),
          createdBy: 'ai',
        },
        children: [],
      });
    });

    if ((branch.children?.length ?? 0) > 0) {
      root.children?.push(branch);
    }
  }

  const tree: MindMapTree = {
    id: nanoid(),
    root,
    meta: {
      title,
      sourceType: doc.sourceMeta.type,
      sourceUrl: doc.sourceMeta.sourceUrl,
      sourceFileName: doc.sourceMeta.sourceFileName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      truncated: false,
    },
  };

  return clampTree(tree, MAX_TREE_DEPTH, MAX_TREE_NODES);
}

function buildPrompt(doc: NormalizedDocument): string {
  return [
    '你是资深知识整理助手，请把以下内容生成思维导图。',
    `约束：最大层级 ${MAX_TREE_DEPTH}，最大节点数 ${MAX_TREE_NODES}。`,
    '输出要求：',
    '1. 结构要清晰，第一层为 3~6 个主题。',
    '2. 只输出与内容相关的信息，不要捏造事实。',
    '3. 每个节点文本简洁，尽量 20 字内。',
    '',
    `标题建议：${doc.sourceMeta.title || '自动生成思维导图'}`,
    '',
    '输入内容：',
    doc.markdown.slice(0, 12000),
  ].join('\n');
}

export async function* generateMindMapStream(
  doc: NormalizedDocument,
): AsyncGenerator<GenerateStreamEvent> {
  const hasApiKey = Boolean(process.env.OPENAI_API_KEY);

  if (!hasApiKey) {
    const fallback = heuristicTreeFromDocument(doc);
    yield { type: 'skeleton', data: { tree: fallback } };

    const flattened = flattenTree(fallback.root);
    for (const item of flattened.slice(1)) {
      if (!item.parentId) continue;
      yield {
        type: 'node',
        data: {
          patch: {
            type: 'add',
            nodeId: item.node.id,
            parentId: item.parentId,
            index: item.index,
            node: item.node,
            timestamp: Date.now(),
          },
          node: item.node,
        },
      };
    }

    yield { type: 'complete', data: { tree: fallback } };
    return;
  }

  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  const prompt = buildPrompt(doc);

  let workingTree = heuristicTreeFromDocument(doc);
  let skeletonSent = false;
  let latestStableTree = workingTree;

  try {
    const result = streamObject({
      model: openai(model),
      schema: llmTreeSchema,
      prompt,
    });

    for await (const partial of result.partialObjectStream) {
      const candidateRoot = sanitizePartialNode((partial as { root?: unknown })?.root);
      const candidateTitle = (partial as { title?: unknown })?.title;

      if (!candidateRoot) {
        continue;
      }

      const parseResult = llmTreeSchema.safeParse({
        title: typeof candidateTitle === 'string' && candidateTitle.trim() ? candidateTitle.trim() : doc.sourceMeta.title || '自动生成导图',
        root: candidateRoot,
      });

      if (!parseResult.success) {
        continue;
      }

      const nextTree = llmTreeToMindMapTree(parseResult.data, doc);

      if (!skeletonSent) {
        skeletonSent = true;
        latestStableTree = nextTree;
        workingTree = nextTree;
        yield {
          type: 'skeleton',
          data: {
            tree: nextTree,
          },
        };
        continue;
      }

      const patches = buildDiffPatches(latestStableTree, nextTree);
      for (const patch of patches) {
        workingTree = applyTreePatch(workingTree, patch);

        if (patch.type === 'add') {
          yield {
            type: 'node',
            data: {
              patch,
              node: patch.node,
            },
          };
        }
      }

      latestStableTree = nextTree;
    }

    const finalObject = await result.object;
    const finalTree = llmTreeToMindMapTree(finalObject, doc);

    if (!skeletonSent) {
      yield { type: 'skeleton', data: { tree: finalTree } };
    }

    yield {
      type: 'complete',
      data: {
        tree: finalTree,
      },
    };
  } catch (error) {
    const fallback = latestStableTree;
    if (!skeletonSent) {
      yield { type: 'skeleton', data: { tree: fallback } };
    }

    yield {
      type: 'error',
      data: {
        message:
          error instanceof Error
            ? `${error.message}. 已返回本地启发式结果（节点数 ${countNodes(fallback.root)}）。`
            : '生成失败，已返回本地启发式结果。',
      },
    };

    yield {
      type: 'complete',
      data: {
        tree: fallback,
      },
    };
  }
}

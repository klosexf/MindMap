import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  mindMapRecordSchema,
  mindMapTreeSchema,
  treePatchListSchema,
  type MindMapRecord,
  type MindMapTree,
  type NormalizedDocument,
  type TreeMeta,
} from '@/lib/types/mindmap';
import { applyTreePatch } from '@/lib/utils/tree';

const DATA_DIR = path.join(process.cwd(), 'data', 'mindmaps');

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function treePath(id: string): string {
  return path.join(DATA_DIR, `${id}.json`);
}

function parsePersistedRecord(raw: unknown): MindMapRecord {
  const wrapped = mindMapRecordSchema.safeParse(raw);
  if (wrapped.success) {
    return wrapped.data;
  }

  return {
    tree: mindMapTreeSchema.parse(raw),
  };
}

export async function saveMindMap(tree: MindMapTree, normalizedDocument?: NormalizedDocument): Promise<MindMapTree> {
  const parsedTree = mindMapTreeSchema.parse(tree);
  await ensureDataDir();

  let nextRecord: MindMapRecord = {
    tree: parsedTree,
  };

  if (normalizedDocument) {
    nextRecord = {
      tree: parsedTree,
      normalizedDocument,
    };
  } else {
    try {
      const raw = await fs.readFile(treePath(parsedTree.id), 'utf8');
      const existingRecord = parsePersistedRecord(JSON.parse(raw));
      if (existingRecord.normalizedDocument) {
        nextRecord.normalizedDocument = existingRecord.normalizedDocument;
      }
    } catch {
      // No existing persisted document to preserve.
    }
  }

  await fs.writeFile(treePath(parsedTree.id), JSON.stringify(nextRecord, null, 2), 'utf8');
  return parsedTree;
}

export async function getMindMap(id: string): Promise<MindMapTree | null> {
  const record = await getMindMapRecord(id);
  return record?.tree ?? null;
}

export async function getMindMapRecord(id: string): Promise<MindMapRecord | null> {
  try {
    const raw = await fs.readFile(treePath(id), 'utf8');
    return parsePersistedRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

export interface MindMapSummary {
  id: string;
  meta: TreeMeta;
  rootContent: string;
}

export async function listMindMaps(): Promise<MindMapSummary[]> {
  await ensureDataDir();

  let entries: string[];
  try {
    entries = await fs.readdir(DATA_DIR);
  } catch {
    return [];
  }

  const summaries: MindMapSummary[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(DATA_DIR, entry), 'utf8');
      const tree = parsePersistedRecord(JSON.parse(raw)).tree;
      summaries.push({
        id: tree.id,
        meta: tree.meta,
        rootContent: tree.root.content,
      });
    } catch {
      // Skip corrupted files
    }
  }

  // Sort by updatedAt descending (most recent first)
  summaries.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt);
  return summaries;
}

export async function deleteMindMap(id: string): Promise<boolean> {
  try {
    await fs.unlink(treePath(id));
    return true;
  } catch {
    return false;
  }
}

export async function patchMindMap(id: string, patches: unknown): Promise<MindMapTree> {
  const patchList = treePatchListSchema.parse(patches);
  const currentRecord = await getMindMapRecord(id);
  const current = currentRecord?.tree ?? null;

  if (!current) {
    throw new Error('Mindmap not found');
  }

  const next = patchList.reduce((tree, patch) => applyTreePatch(tree, patch), current);
  await saveMindMap(next, currentRecord?.normalizedDocument);
  return next;
}

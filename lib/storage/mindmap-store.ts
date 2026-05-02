import { promises as fs } from 'node:fs';
import path from 'node:path';

import { mindMapTreeSchema, treePatchListSchema, type MindMapTree, type TreeMeta } from '@/lib/types/mindmap';
import { applyTreePatch } from '@/lib/utils/tree';

const DATA_DIR = path.join(process.cwd(), 'data', 'mindmaps');

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function treePath(id: string): string {
  return path.join(DATA_DIR, `${id}.json`);
}

export async function saveMindMap(tree: MindMapTree): Promise<MindMapTree> {
  const parsed = mindMapTreeSchema.parse(tree);
  await ensureDataDir();
  await fs.writeFile(treePath(parsed.id), JSON.stringify(parsed, null, 2), 'utf8');
  return parsed;
}

export async function getMindMap(id: string): Promise<MindMapTree | null> {
  try {
    const raw = await fs.readFile(treePath(id), 'utf8');
    return mindMapTreeSchema.parse(JSON.parse(raw));
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
      const tree = mindMapTreeSchema.parse(JSON.parse(raw));
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
  const current = await getMindMap(id);

  if (!current) {
    throw new Error('Mindmap not found');
  }

  const next = patchList.reduce((tree, patch) => applyTreePatch(tree, patch), current);
  await saveMindMap(next);
  return next;
}

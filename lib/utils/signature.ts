import type { MindMapNode, MindMapTree } from '@/lib/types/mindmap';

export function buildTreeSignature(tree: MindMapTree): string {
  const items: Array<{ id: string; content: string }> = [];

  function collect(node: MindMapNode): void {
    if (items.length >= 120) return;
    const content = node.content.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (content) items.push({ id: node.id, content });

    for (const child of node.children || []) {
      collect(child);
      if (items.length >= 120) return;
    }
  }

  collect(tree.root);
  items.sort((a, b) => a.id.localeCompare(b.id));
  return items.map((item) => `${item.id.slice(0, 8)}:${item.content}`).join('|');
}

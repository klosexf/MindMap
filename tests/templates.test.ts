import { describe, expect, it } from 'vitest';

import { mindMapTreeSchema } from '../lib/types/mindmap';
import {
  MINDMAP_TEMPLATES,
  buildTemplateTree,
  getTemplateById,
} from '../lib/templates';

function collectIds(node: { id: string; children?: Array<{ id: string }> }): string[] {
  return [node.id, ...(node.children || []).flatMap((child) => collectIds(child))];
}

describe('mindmap templates', () => {
  it('ships a non-empty preset list with unique ids', () => {
    expect(MINDMAP_TEMPLATES.length).toBeGreaterThan(0);

    const ids = MINDMAP_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const template of MINDMAP_TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.root.length).toBeGreaterThan(0);
      expect(template.branches.length).toBeGreaterThan(0);
    }
  });

  it('builds a schema-valid tree from each template', () => {
    for (const template of MINDMAP_TEMPLATES) {
      const tree = buildTemplateTree(template.id, 1_000);
      expect(tree).not.toBeNull();

      const parsed = mindMapTreeSchema.safeParse(tree);
      expect(parsed.error?.issues ?? []).toEqual([]);
    }
  });

  it('produces unique node ids across calls so trees never collide', () => {
    const first = buildTemplateTree('swot', 1_000);
    const second = buildTemplateTree('swot', 1_000);

    const firstIds = new Set(collectIds(first!.root).concat(first!.id));
    for (const id of collectIds(second!.root).concat(second!.id)) {
      expect(firstIds.has(id)).toBe(false);
    }
  });

  it('keeps the template skeleton structure in the built tree', () => {
    const template = getTemplateById('swot')!;
    const tree = buildTemplateTree('swot', 1_000)!;

    expect(tree.root.content).toBe(template.root);
    expect(tree.root.children?.map((child) => child.content)).toEqual(
      template.branches.map((branch) => branch.content),
    );
    // Nested children survive: first SWOT branch has 2 leaf nodes.
    expect(tree.root.children?.[0]?.children).toHaveLength(2);

    expect(tree.meta.title).toBe(template.name);
    expect(tree.meta.sourceType).toBe('prompt');
    expect(tree.meta.version).toBe(1);
  });

  it('returns null for unknown template ids', () => {
    expect(buildTemplateTree('does-not-exist')).toBeNull();
    expect(getTemplateById('does-not-exist')).toBeUndefined();
  });
});

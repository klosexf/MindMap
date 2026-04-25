import { treeToGraphData } from '@antv/g6';
import type { GraphData, NodeData } from '@antv/g6';

import type { MindMapNode, MindMapTree } from '@/lib/types/mindmap';

interface HierarchyNode {
  id: string;
  content: string;
  collapsed: boolean;
  children: HierarchyNode[];
}

function toHierarchyNode(node: MindMapNode): HierarchyNode {
  return {
    id: node.id,
    content: node.content,
    collapsed: node.collapsed ?? false,
    children: (node.children || []).map((child) => toHierarchyNode(child)),
  };
}

export function toG6GraphData(tree: MindMapTree): GraphData {
  const hierarchy = toHierarchyNode(tree.root);
  const graph = treeToGraphData(hierarchy, {
    getNodeData: (node, depth) => {
      const data = node as { id: string; content?: string; collapsed?: boolean; children?: string[] };
      const nodeData: NodeData = {
        id: data.id,
        depth,
        children: data.children,
        data: {
          label: data.content || '',
          collapsed: Boolean(data.collapsed),
        },
        style: {
          collapsed: Boolean(data.collapsed),
        },
      };
      return nodeData;
    },
  });

  return graph;
}

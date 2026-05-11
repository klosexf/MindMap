import { z } from 'zod';

export const SOURCE_TYPES = ['text', 'url', 'pdf', 'prompt', 'wechat'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const sourceReferenceSchema = z.object({
  type: z.enum(SOURCE_TYPES),
  location: z.string().optional(),
  page: z.number().int().positive().optional(),
  timestamp: z.string().optional(),
  url: z.string().url().optional(),
  text: z.string().optional(),
});

export type SourceReference = z.infer<typeof sourceReferenceSchema>;

export const nodeMetaSchema = z.object({
  sourceRef: sourceReferenceSchema,
  confidence: z.number().min(0).max(1).optional(),
  type: z.enum(['main', 'detail', 'action', 'question']).default('detail'),
  createdAt: z.number().int(),
  createdBy: z.enum(['ai', 'user']).default('ai'),
  editedAt: z.number().int().optional(),
  editedBy: z.enum(['ai', 'user']).optional(),
});

export type NodeMeta = z.infer<typeof nodeMetaSchema>;

export const nodeStyleSchema = z.object({
  fill: z.string().optional(),
  stroke: z.string().optional(),
  fontSize: z.number().optional(),
  fontWeight: z.enum(['normal', 'bold']).optional(),
  fontStyle: z.enum(['normal', 'italic']).optional(),
  icon: z.string().optional(),
  shape: z.enum(['rect', 'rounded', 'circle', 'diamond']).optional(),
});

export type NodeStyle = z.infer<typeof nodeStyleSchema>;

export const nodePositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export type NodePosition = z.infer<typeof nodePositionSchema>;

export type MindMapNode = {
  id: string;
  content: string;
  children?: MindMapNode[];
  collapsed?: boolean;
  style?: NodeStyle;
  position?: NodePosition;
  meta: NodeMeta;
};

export const mindMapNodeSchema: z.ZodType<MindMapNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    content: z.string().min(1).max(500),
    children: z.array(mindMapNodeSchema).optional(),
    collapsed: z.boolean().optional(),
    style: nodeStyleSchema.optional(),
    position: nodePositionSchema.optional(),
    meta: nodeMetaSchema,
  }),
);

export const treeMetaSchema = z.object({
  title: z.string().optional(),
  sourceType: z.enum(SOURCE_TYPES),
  sourceUrl: z.string().url().optional(),
  sourceFileName: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  version: z.number().int().min(1),
  truncated: z.boolean().default(false),
});

export type TreeMeta = z.infer<typeof treeMetaSchema>;

export const mindMapTreeSchema = z.object({
  id: z.string().min(1),
  root: mindMapNodeSchema,
  meta: treeMetaSchema,
});

export type MindMapTree = z.infer<typeof mindMapTreeSchema>;

export const llmNodeSchema: z.ZodType<{ content: string; children?: { content: string; children?: any[] }[] }> = z.lazy(() =>
  z.object({
    content: z.string().min(1).max(500),
    children: z.array(llmNodeSchema).optional(),
  }),
);

export const llmTreeSchema = z.object({
  title: z.string().min(1).max(120),
  root: llmNodeSchema,
});

export type LLMMindMapTree = z.infer<typeof llmTreeSchema>;

export type LayoutDirection = 'LR' | 'RL' | 'TB' | 'BT';

export type TreePatch =
  | {
      type: 'add';
      nodeId: string;
      parentId: string;
      index: number;
      node: MindMapNode;
      timestamp: number;
    }
  | {
      type: 'update';
      nodeId: string;
      node: Partial<Pick<MindMapNode, 'content' | 'collapsed' | 'style' | 'position' | 'meta'>>;
      timestamp: number;
    }
  | {
      type: 'delete';
      nodeId: string;
      timestamp: number;
    }
  | {
      type: 'toggleCollapse';
      nodeId: string;
      timestamp: number;
    }
  | {
      type: 'move';
      nodeId: string;
      newParentId: string;
      newIndex: number;
      timestamp: number;
    }
  | {
      type: 'position';
      nodeId: string;
      position: NodePosition;
      timestamp: number;
    };

export const treePatchSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add'),
    nodeId: z.string().min(1),
    parentId: z.string().min(1),
    index: z.number().int().min(0),
    node: mindMapNodeSchema,
    timestamp: z.number().int(),
  }),
  z.object({
    type: z.literal('update'),
    nodeId: z.string().min(1),
    node: z
      .object({
        content: z.string().min(1).max(500).optional(),
        collapsed: z.boolean().optional(),
        style: nodeStyleSchema.optional(),
        position: nodePositionSchema.optional(),
        meta: nodeMetaSchema.optional(),
      })
      .refine((v) => Object.keys(v).length > 0, 'update patch requires at least one field'),
    timestamp: z.number().int(),
  }),
  z.object({
    type: z.literal('delete'),
    nodeId: z.string().min(1),
    timestamp: z.number().int(),
  }),
  z.object({
    type: z.literal('toggleCollapse'),
    nodeId: z.string().min(1),
    timestamp: z.number().int(),
  }),
  z.object({
    type: z.literal('move'),
    nodeId: z.string().min(1),
    newParentId: z.string().min(1),
    newIndex: z.number().int().min(0),
    timestamp: z.number().int(),
  }),
  z.object({
    type: z.literal('position'),
    nodeId: z.string().min(1),
    position: nodePositionSchema,
    timestamp: z.number().int(),
  }),
]);

export const treePatchListSchema = z.array(treePatchSchema);

export interface ParsedChunk {
  id: string;
  text: string;
  tokenEstimate: number;
  sourceRef: SourceReference;
}

export interface NormalizedDocument {
  markdown: string;
  chunks: ParsedChunk[];
  sourceMeta: {
    type: SourceType;
    title?: string;
    sourceUrl?: string;
    sourceFileName?: string;
    ocrUsed?: boolean;
    ocrDebug?: {
      enabled: boolean;
      attempted: boolean;
      provider?: string;
      model?: string;
      attemptedPages: number;
      acceptedPages: number;
      errorMessages: string[];
      pages: Array<{
        page: number;
        rawText: string;
        cleanedText: string;
        accepted: boolean;
        reason?: string;
      }>;
    };
    parseWarning?: string;
  };
}

export const parsedChunkSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  tokenEstimate: z.number().int().positive(),
  sourceRef: sourceReferenceSchema,
});

export const ocrDebugPageSchema = z.object({
  page: z.number().int().positive(),
  rawText: z.string(),
  cleanedText: z.string(),
  accepted: z.boolean(),
  reason: z.string().optional(),
});

export const ocrDebugSchema = z.object({
  enabled: z.boolean(),
  attempted: z.boolean(),
  provider: z.string().optional(),
  model: z.string().optional(),
  attemptedPages: z.number().int().nonnegative(),
  acceptedPages: z.number().int().nonnegative(),
  errorMessages: z.array(z.string()),
  pages: z.array(ocrDebugPageSchema),
});

export const normalizedDocumentSchema = z.object({
  markdown: z.string().min(1),
  chunks: z.array(parsedChunkSchema).min(1),
  sourceMeta: z.object({
    type: z.enum(SOURCE_TYPES),
    title: z.string().optional(),
    sourceUrl: z.string().url().optional(),
    sourceFileName: z.string().optional(),
    ocrUsed: z.boolean().optional(),
    ocrDebug: ocrDebugSchema.optional(),
    parseWarning: z.string().optional(),
  }),
});

export const mindMapRecordSchema = z.object({
  tree: mindMapTreeSchema,
  normalizedDocument: normalizedDocumentSchema.optional(),
});

export type MindMapRecord = z.infer<typeof mindMapRecordSchema>;

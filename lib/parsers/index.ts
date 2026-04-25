import { parsePdfInput } from '@/lib/parsers/pdf';
import { parseTextInput } from '@/lib/parsers/text';
import { parseUrlInput } from '@/lib/parsers/url';
import type { NormalizedDocument, SourceType } from '@/lib/types/mindmap';

export interface ParseInputParams {
  type: SourceType;
  content: string;
  fileName?: string;
}

export async function parseInput(params: ParseInputParams): Promise<NormalizedDocument> {
  switch (params.type) {
    case 'text':
    case 'prompt':
      return parseTextInput(params.content);
    case 'url':
      return parseUrlInput(params.content);
    case 'pdf':
      return parsePdfInput(params.content, params.fileName);
    default:
      throw new Error(`Unsupported input type: ${params.type as string}`);
  }
}

import { parsePdfInput } from '@/lib/parsers/pdf';
import { parseTextInput } from '@/lib/parsers/text';
import { parseUrlInput } from '@/lib/parsers/url';
import { parseWeChatUrl, isWeChatArticleUrl } from '@/lib/parsers/wechat';
import { normalizeOcrDocument } from '@/lib/parsers/normalize';
import type { NormalizedDocument, SourceType } from '@/lib/types/mindmap';
import type { PdfParseOptions } from '@/lib/parsers/pdf';

export interface ParseInputParams {
  type: SourceType;
  content: string;
  fileName?: string;
  pdfOptions?: PdfParseOptions;
  /** wechat 类型的可选认证参数 */
  wechatOptions?: {
    authKey?: string;
    token?: string;
  };
}

export async function parseInput(params: ParseInputParams): Promise<NormalizedDocument> {
  switch (params.type) {
    case 'text':
    case 'prompt':
      return parseTextInput(params.content);
    case 'url':
      // 自动检测微信公众号链接，路由到 wechat 解析器
      if (isWeChatArticleUrl(params.content)) {
        return parseWeChatUrl(params.content, params.wechatOptions);
      }
      return parseUrlInput(params.content);
    case 'pdf':
      // OCR 输出归一化：康熙部首还原 + CJK 空格折叠（仅 PDF 链路需要）
      return normalizeOcrDocument(await parsePdfInput(params.content, params.fileName, params.pdfOptions));
    case 'wechat':
      return parseWeChatUrl(params.content, params.wechatOptions);
    default:
      throw new Error(`Unsupported input type: ${params.type as string}`);
  }
}

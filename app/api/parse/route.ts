import { NextResponse } from 'next/server';
import { z } from 'zod';

import { parseInput } from '@/lib/parsers';

export const runtime = 'nodejs';

const parseRequestSchema = z.object({
  type: z.enum(['text', 'url', 'pdf', 'prompt', 'wechat']),
  content: z.string().min(1),
  fileName: z.string().optional(),
  pdfOptions: z.object({
    forceOcr: z.boolean().optional(),
    forceOcrMaxPages: z.number().int().positive().optional(),
  }).optional(),
  wechatOptions: z.object({
    authKey: z.string().optional(),
    token: z.string().optional(),
  }).optional(),
});

/** 判断错误是否为客户端输入错误（4xx 语义） */
function isClientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  // URL 格式错误、无法访问、403/404 等都属于客户端输入问题
  const clientHints = [
    '链接格式不正确',
    '仅支持 http',
    '无法访问',
    '访问被拒绝',
    '页面不存在',
    '请求过于频繁',
    '获取页面失败',
    '微信文章',
    '知乎反爬',
    '简书反爬',
    '微博访问受限',
    'Twitter/X',
    '页面返回内容为空',
    '页面解析失败',
    '无法从该页面提取',
    '该链接指向的不是网页',
    '读取页面内容失败',
    'DNS 解析失败',
    '连接被拒绝',
    'SSL 证书错误',
    '请求超时',
    'No readable content',
    'URL fetch failed',
    'Parse failed',
  ];
  return clientHints.some((hint) => msg.includes(hint));
}

export async function POST(req: Request) {
  try {
    const payload = parseRequestSchema.parse(await req.json());
    const normalizedDocument = await parseInput(payload);

    return NextResponse.json({ normalizedDocument });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Parse failed';
    const status = isClientError(error) ? 400 : 500;

    return NextResponse.json(
      {
        error: message,
        code: status === 400 ? 'PARSE_CLIENT_ERROR' : 'PARSE_SERVER_ERROR',
      },
      { status },
    );
  }
}

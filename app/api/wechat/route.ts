import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  searchAccount,
  getArticleList,
  getAccountByUrl,
  checkServiceAvailability,
  isWeChatArticleUrl,
  type WeChatAccount,
  type WeChatArticle,
} from '@/lib/wechat/client';
import { parseWeChatUrl, parseWeChatArticleList, searchAndFetchArticles } from '@/lib/parsers/wechat';

export const runtime = 'nodejs';

// ========== 请求 Schema ==========

const searchSchema = z.object({
  action: z.literal('search'),
  keyword: z.string().min(1).max(100),
  authKey: z.string().optional(),
});

const articleListSchema = z.object({
  action: z.literal('articleList'),
  fakeid: z.string().min(1),
  begin: z.number().int().min(0).optional().default(0),
  size: z.number().int().min(1).max(20).optional().default(20),
  authKey: z.string().optional(),
});

const parseUrlSchema = z.object({
  action: z.literal('parseUrl'),
  url: z.string().url().refine(isWeChatArticleUrl, {
    message: '不是有效的微信公众号文章链接',
  }),
  authKey: z.string().optional(),
});

const searchAndParseSchema = z.object({
  action: z.literal('searchAndParse'),
  keyword: z.string().min(1).max(100),
  maxArticles: z.number().int().min(1).max(50).optional().default(20),
  authKey: z.string().optional(),
});

const checkSchema = z.object({
  action: z.literal('check'),
});

const requestSchema = z.discriminatedUnion('action', [
  searchSchema,
  articleListSchema,
  parseUrlSchema,
  searchAndParseSchema,
  checkSchema,
]);

// ========== 响应类型 ==========

interface SearchResponse {
  accounts: WeChatAccount[];
}

interface ArticleListResponse {
  articles: WeChatArticle[];
  nextBegin: number;
  hasMore: boolean;
  document?: ReturnType<typeof parseWeChatArticleList>;
}

interface ParseUrlResponse {
  normalizedDocument: Awaited<ReturnType<typeof parseWeChatUrl>>;
}

interface SearchAndParseResponse {
  accounts: WeChatAccount[];
  articlesByAccount: Array<{
    account: WeChatAccount;
    articles: WeChatArticle[];
  }>;
}

interface CheckResponse {
  available: boolean;
  message: string;
  baseUrl: string;
}

// ========== API 处理 ==========

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = requestSchema.parse(body);

    switch (parsed.action) {
      case 'search': {
        const accounts = await searchAccount(parsed.keyword, {
          authKey: parsed.authKey,
        });
        return NextResponse.json({ accounts } satisfies SearchResponse);
      }

      case 'articleList': {
        const result = await getArticleList(parsed.fakeid, {
          begin: parsed.begin,
          size: parsed.size,
          authKey: parsed.authKey,
        });

        // 同时生成 NormalizedDocument 格式的数据
        const document = parseWeChatArticleList(result.articles, '');

        return NextResponse.json({
          articles: result.articles,
          nextBegin: result.nextBegin,
          hasMore: result.hasMore,
          document,
        } satisfies ArticleListResponse);
      }

      case 'parseUrl': {
        const normalizedDocument = await parseWeChatUrl(parsed.url, {
          authKey: parsed.authKey,
        });
        return NextResponse.json({ normalizedDocument } satisfies ParseUrlResponse);
      }

      case 'searchAndParse': {
        const result = await searchAndFetchArticles(parsed.keyword, {
          maxArticles: parsed.maxArticles,
          authKey: parsed.authKey,
        });

        return NextResponse.json({
          accounts: result.accounts,
          articlesByAccount: result.articlesByAccount.map(({ account, articles }) => ({
            account,
            articles,
          })),
        } satisfies SearchAndParseResponse);
      }

      case 'check': {
        const status = await checkServiceAvailability();
        return NextResponse.json(status satisfies CheckResponse);
      }

      default:
        return NextResponse.json({ error: '未知操作' }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '请求处理失败';
    const isClientError =
      message.includes('不是有效的') ||
      message.includes('未找到') ||
      message.includes('无法获取') ||
      message.includes('已过期') ||
      message.includes('为空') ||
      message.includes('无法从');

    return NextResponse.json(
      {
        error: message,
        code: isClientError ? 'WECHAT_CLIENT_ERROR' : 'WECHAT_SERVER_ERROR',
      },
      { status: isClientError ? 400 : 500 },
    );
  }
}

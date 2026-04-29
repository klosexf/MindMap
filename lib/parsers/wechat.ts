/**
 * 微信公众号文章解析器
 *
 * 解析策略（按优先级，逐步降级）：
 * 1. 通过 mptext download API 获取 — 需 auth-key，成功率最高
 * 2. 直接 fetch 微信文章 URL — 文章本身公开可访问，但正文为 JS 动态渲染
 * 3. 通过搜狗微信搜索获取 — 无需配置，通过搜狗搜索引擎查找并获取文章
 * 4. 通过腾讯混元（元宝）搜索增强获取 — 需 HUNYUAN_API_KEY，微信生态独家资源
 * 5. 通过智谱AI联网搜索获取摘要 — 需 ZHIPU_API_KEY，获取文章摘要
 * 6. 均失败则给出配置指引
 *
 * 重要说明：
 * - 微信文章正文通过 JavaScript 动态渲染，服务端直接 fetch 只能获取空壳 HTML
 * - mptext download API 通过代理节点获取完整内容，但需要 auth-key
 * - 搜狗微信搜索是腾讯官方的微信文章搜索引擎，零配置可用
 * - 腾讯混元（元宝）是腾讯自家AI，拥有微信生态数据权限，成功率最高
 * - 如果以上方式均不可用，建议浏览器复制粘贴
 */

import https from 'node:https';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

import { chunkMarkdown } from '@/lib/utils/chunk';
import { createSourceRefFallback } from '@/lib/utils/tree';
import type { NormalizedDocument } from '@/lib/types/mindmap';
import {
  isWeChatArticleUrl,
  fetchArticleViaDownload,
  fetchArticleViaSogou,
  summarizeWeChatArticleViaHunyuan,
  searchAccount,
  getArticleList,
  searchWeChatArticleViaZhipu,
  summarizeWeChatArticleViaZhipuChat,
  type WeChatArticle,
  type WeChatAccount,
  type ZhipuWebSearchResult,
} from '@/lib/wechat/client';

// Re-export for use by url.ts auto-routing
export { isWeChatArticleUrl } from '@/lib/wechat/client';

/** 将微信文章 HTML 转换为 Markdown 格式 */
function wechatHtmlToMarkdown(title: string, content: string): string {
  return `# ${title}\n\n${content}`.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 从 HTML 中提取可读文本
 *
 * 优先使用 Readability，失败则降级为纯文本提取
 */
function extractTextFromHtml(html: string, url: string): { title: string; plainText: string } {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    const title = article?.title?.trim() || dom.window.document.title || '微信公众号文章';
    const plainText = (article?.textContent || dom.window.document.body?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();

    return { title, plainText };
  } catch {
    // 降级：直接从 HTML 中提取文本
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    return { title: '微信公众号文章', plainText: textContent };
  }
}

/**
 * 检测 HTML 是否包含微信文章正文内容
 *
 * 微信文章页面一定包含 rich_media_content 这个关键 ID
 * 如果没有，说明是空壳页面（正文通过 JS 动态渲染）
 */
function isWeChatArticleContent(html: string): boolean {
  return html.includes('rich_media_content') || html.includes('js_content');
}

/**
 * 检测是否为微信的拦截/验证页面
 */
function isWeChatBlockPage(html: string): boolean {
  const blockKeywords = ['环境异常', '频繁访问', '请在微信客户端打开', 'verify_ticket'];
  return blockKeywords.some((kw) => html.includes(kw)) && !isWeChatArticleContent(html);
}

/**
 * 检测是否为 Cloudflare Challenge 页面
 */
function isCloudflareChallenge(html: string): boolean {
  return html.includes('challenge-platform') || html.includes('__CF$cv$params');
}

/**
 * 检测是否为 TLS 证书错误
 */
function isTlsCertificateError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const errMsg = error.message || '';
  const causeMsg = (error.cause instanceof Error) ? error.cause.message : '';
  const causeCode = (error.cause instanceof Error && 'code' in error.cause)
    ? String((error.cause as { code: unknown }).code) : '';
  const combined = `${errMsg} ${causeMsg} ${causeCode}`.toUpperCase();

  return combined.includes('CERTIFICATE') ||
    combined.includes('UNABLE_TO_GET') ||
    combined.includes('ERR_TLS') ||
    combined.includes('SELF_SIGNED') ||
    combined.includes('ISSUER_CERT');
}

/** 桌面 Chrome 请求头 */
const DESKTOP_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  Referer: 'https://mp.weixin.qq.com/',
};

/** 移动端微信内置浏览器请求头 */
const MOBILE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.47(0x18002f2f) NetType/WIFI Language/zh_CN',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  Referer: 'https://mp.weixin.qq.com/',
};

/**
 * 单次 fetch 请求（优先标准 fetch，TLS 错误时回退到 node:https）
 */
async function singleFetch(url: string, headers: Record<string, string>, timeoutMs = 15_000): Promise<string> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('timeout'), timeoutMs);

    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const html = await response.text();

    if (!html || html.trim().length === 0) {
      throw new Error('返回内容为空');
    }

    if (isWeChatBlockPage(html)) {
      throw new Error('微信返回拦截/验证页面');
    }

    return html;
  } catch (fetchError) {
    if (!isTlsCertificateError(fetchError)) {
      throw fetchError;
    }

    // TLS 错误回退到 node:https
    return singleFetchHttpsFallback(url, headers, timeoutMs);
  }
}

/**
 * 使用 node:https 的回退请求（跳过 SSL 证书验证）
 */
function singleFetchHttpsFallback(url: string, headers: Record<string, string>, timeoutMs = 15_000): Promise<string> {
  const urlObj = new URL(url);

  return new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      req.destroy();
      reject(new Error(`请求超时（${timeoutMs}ms）`));
    }, timeoutMs);

    const req = https.request(
      urlObj,
      {
        method: 'GET',
        headers,
        agent: new https.Agent({ rejectUnauthorized: false }),
      },
      (res) => {
        clearTimeout(timeoutId);

        // 处理重定向
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          singleFetchHttpsFallback(redirectUrl, headers, timeoutMs).then(resolve).catch(reject);
          return;
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const html = Buffer.concat(chunks).toString('utf-8');

          if (!html || html.trim().length === 0) {
            reject(new Error('返回内容为空'));
            return;
          }

          if (isWeChatBlockPage(html)) {
            reject(new Error('微信返回拦截/验证页面'));
            return;
          }

          resolve(html);
        });
        res.on('error', reject);
      },
    );

    req.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    req.end();
  });
}

/**
 * 直接 fetch 微信文章 HTML（多策略重试）
 *
 * 注意：微信文章正文通过 JavaScript 动态渲染，
 * 服务端直接 fetch 只能获取空壳 HTML（不含文章正文）。
 * 此方法作为 download API 的备选方案，成功率较低。
 */
async function directFetchWeChatHtml(url: string): Promise<string> {
  const strategies: Array<{ name: string; headers: Record<string, string>; delay?: number }> = [
    { name: '桌面 Chrome', headers: DESKTOP_HEADERS },
    { name: '移动端微信', headers: MOBILE_HEADERS },
    { name: '桌面 Chrome (重试)', headers: DESKTOP_HEADERS, delay: 1500 },
  ];

  const errors: string[] = [];

  for (const strategy of strategies) {
    try {
      if (strategy.delay) {
        await new Promise((resolve) => setTimeout(resolve, strategy.delay));
      }

      const html = await singleFetch(url, strategy.headers);

      // 验证确实拿到了文章内容
      if (isWeChatArticleContent(html)) {
        return html;
      }

      // 微信文章正文通过 JS 动态渲染，服务端获取到的是空壳
      errors.push(`${strategy.name}：页面无文章正文（微信文章正文为 JS 动态渲染，服务端无法获取）`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '未知错误';
      errors.push(`${strategy.name}：${msg}`);
    }
  }

  throw new Error(
    `直接访问微信文章失败（尝试了 ${strategies.length} 种策略）：\n` +
    errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
  );
}

/**
 * 解析微信文章 URL，获取文章内容并转换为 NormalizedDocument
 *
 * 解析策略：
 * 1. 优先通过 mptext download API（需 auth-key，成功率最高）
 * 2. 失败后尝试直接 fetch（成功率低，微信正文为 JS 动态渲染）
 * 3. 均失败则给出配置指引
 *
 * @param url 微信公众号文章 URL（mp.weixin.qq.com/s?...）
 * @param options 可选配置
 * @returns NormalizedDocument 格式的文档
 */
export async function parseWeChatUrl(
  url: string,
  options: {
    authKey?: string;
  } = {},
): Promise<NormalizedDocument> {
  // 1. URL 格式校验
  if (!isWeChatArticleUrl(url)) {
    throw new Error('不是有效的微信公众号文章链接，链接应为 mp.weixin.qq.com/s?... 格式');
  }

  // 2. 尝试获取文章 HTML（逐步降级策略）
  let html: string | null = null;
  let fetchMethod = '';
  const errors: string[] = [];

  // 策略一：通过 mptext download API（需 auth-key，成功率最高）
  try {
    html = await fetchArticleViaDownload(url, options);
    fetchMethod = 'download API';
  } catch (downloadError) {
    const downloadMsg = downloadError instanceof Error ? downloadError.message : 'download API 失败';
    errors.push(`download API：${downloadMsg}`);

    // 策略二：直接 fetch（成功率低，微信正文为 JS 动态渲染）
    try {
      html = await directFetchWeChatHtml(url);
      fetchMethod = '直接访问';
    } catch (directError) {
      const directMsg = directError instanceof Error ? directError.message : '直接访问失败';
      errors.push(`直接访问：${directMsg}`);

      // 策略三：通过搜狗微信搜索获取（零配置，腾讯官方搜索引擎）
      try {
        const sogouResult = await fetchArticleViaSogou(url);
        if (sogouResult?.html) {
          html = sogouResult.html;
          fetchMethod = '搜狗微信搜索';
        } else {
          throw new Error('搜狗搜索未找到该文章或无法获取完整内容');
        }
      } catch (sogouError) {
        const sogouMsg = sogouError instanceof Error ? sogouError.message : '搜狗微信搜索失败';
        errors.push(`搜狗微信搜索：${sogouMsg}`);

        // 策略四：通过腾讯混元（元宝）搜索增强获取（腾讯自家产品，微信生态独家资源）
        try {
          const { title: hunyuanTitle, summary: hunyuanSummary } = await summarizeWeChatArticleViaHunyuan(url);
          const hunyuanMarkdown = wechatHtmlToMarkdown(hunyuanTitle, hunyuanSummary);
          const hunyuanSourceRef = createSourceRefFallback({
            type: 'wechat',
            url,
            location: 'hunyuan_search_enhancement',
            text: hunyuanSummary.slice(0, 240),
          });

          return {
            markdown: hunyuanMarkdown,
            chunks: chunkMarkdown(hunyuanMarkdown, hunyuanSourceRef),
            sourceMeta: {
              type: 'wechat',
              title: hunyuanTitle,
              sourceUrl: url,
            },
          };
        } catch (hunyuanError) {
          const hunyuanMsg = hunyuanError instanceof Error ? hunyuanError.message : '腾讯混元搜索增强失败';
          errors.push(`腾讯混元搜索增强：${hunyuanMsg}`);

          // 策略五：通过智谱AI联网搜索获取文章内容
          try {
            const { title: zhipuTitle, summary } = await summarizeWeChatArticleViaZhipuChat(url);
            const zhipuMarkdown = wechatHtmlToMarkdown(zhipuTitle, summary);
            const zhipuSourceRef = createSourceRefFallback({
              type: 'wechat',
              url,
              location: 'zhipu_web_search',
              text: summary.slice(0, 240),
            });

            return {
              markdown: zhipuMarkdown,
              chunks: chunkMarkdown(zhipuMarkdown, zhipuSourceRef),
              sourceMeta: {
                type: 'wechat',
                title: zhipuTitle,
                sourceUrl: url,
              },
            };
          } catch (zhipuError) {
            const zhipuMsg = zhipuError instanceof Error ? zhipuError.message : '智谱AI联网搜索失败';
            errors.push(`智谱AI联网搜索：${zhipuMsg}`);

            // 所有方式都失败，给出详细配置指引
            throw new Error(
              `无法获取微信文章内容，所有方式均失败：\n` +
              errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n') +
              '\n\n' +
              `💡 解决方案（推荐，无需扫码）：\n` +
              `  在浏览器中打开微信文章链接 → 全选复制 → 粘贴到「文本」模式生成思维导图\n\n` +
              `推荐：使用腾讯混元（元宝）搜索增强（微信生态独家，成功率最高）：\n` +
              `  1. 访问 https://console.cloud.tencent.com/hunyuan/start 创建 API Key\n` +
              `  2. 在 .env 文件中设置：\n` +
              `     HUNYUAN_API_KEY=你的腾讯混元API Key\n` +
              `     HUNYUAN_BASE_URL=https://api.hunyuan.cloud.tencent.com/v1\n\n` +
              `或使用智谱AI联网搜索（配置简单）：\n` +
              `  在 .env 文件中设置：\n` +
              `     ZHIPU_API_KEY=你的智谱AI API Key\n` +
              `     LLM_PROVIDER=zhipu\n\n` +
              `如果希望通过 URL 直接获取（需配置认证，4天有效）：\n` +
              `  1. 用浏览器打开 https://down.mptext.top\n` +
              `  2. 使用微信扫码登录\n` +
              `  3. 登录成功后，按 F12 打开开发者工具\n` +
              `  4. 在 Application → Local Storage 中复制 auth-key 的值\n` +
              `  5. 在 .env 文件中设置：\n` +
              `     WECHAT_EXPORTER_AUTH_KEY=你的auth-key\n` +
              `     WECHAT_EXPORTER_BASE_URL=https://down.mptext.top\n\n` +
              `注意：auth-key 有效期 4 天，过期后需重新扫码获取。`
            );
          }
        }
      }
    }
  }

  if (!html || html.trim().length === 0) {
    throw new Error('获取到的微信文章内容为空，请检查链接是否有效。');
  }

  // 3. 提取文章正文
  const { title, plainText } = extractTextFromHtml(html, url);

  if (!plainText) {
    throw new Error(
      '无法从微信文章中提取到可读文本内容，可能该文章需要登录或是动态加载，建议复制文章内容粘贴到「文本」模式生成。'
    );
  }

  // 4. 组装 NormalizedDocument
  const markdown = wechatHtmlToMarkdown(title, plainText);
  const sourceRef = createSourceRefFallback({
    type: 'wechat',
    url,
    location: 'body',
    text: plainText.slice(0, 240),
  });

  return {
    markdown,
    chunks: chunkMarkdown(markdown, sourceRef),
    sourceMeta: {
      type: 'wechat',
      title,
      sourceUrl: url,
    },
  };
}

/**
 * 解析公众号文章列表数据为 NormalizedDocument
 *
 * @param articles 文章列表
 * @param accountName 公众号名称
 * @returns NormalizedDocument 格式的文档
 */
export function parseWeChatArticleList(
  articles: WeChatArticle[],
  accountName: string,
): NormalizedDocument {
  const lines: string[] = [`# ${accountName} 文章列表\n`];

  for (const article of articles) {
    const date = article.create_time
      ? new Date(article.create_time * 1000).toLocaleDateString('zh-CN')
      : '';
    const original = article.is_original ? '[原创] ' : '';

    lines.push(`## ${original}${article.title}`);
    if (article.author) {
      lines.push(`作者：${article.author}`);
    }
    if (date) {
      lines.push(`发布日期：${date}`);
    }
    if (article.digest) {
      lines.push(`摘要：${article.digest}`);
    }
    lines.push(`链接：${article.url}`);
    lines.push('');
  }

  const markdown = lines.join('\n');
  const sourceRef = createSourceRefFallback({
    type: 'wechat',
    location: 'article_list',
    text: markdown.slice(0, 240),
  });

  return {
    markdown,
    chunks: chunkMarkdown(markdown, sourceRef),
    sourceMeta: {
      type: 'wechat',
      title: `${accountName} 文章列表`,
    },
  };
}

/**
 * 搜索公众号并获取文章列表
 *
 * @param keyword 搜索关键词
 * @param options 可选配置
 * @returns 公众号列表和文章数据
 */
export async function searchAndFetchArticles(
  keyword: string,
  options: {
    maxArticles?: number;
    authKey?: string;
  } = {},
): Promise<{
  accounts: WeChatAccount[];
  articlesByAccount: Array<{
    account: WeChatAccount;
    articles: WeChatArticle[];
    document: NormalizedDocument;
  }>;
}> {
  // 1. 搜索公众号
  const accounts = await searchAccount(keyword, {
    authKey: options.authKey,
  });

  if (accounts.length === 0) {
    throw new Error(`未找到与"${keyword}"匹配的公众号，请尝试其他关键词。`);
  }

  // 2. 获取匹配公众号的文章列表
  const maxArticles = options.maxArticles ?? 20;
  const articlesByAccount: Array<{
    account: WeChatAccount;
    articles: WeChatArticle[];
    document: NormalizedDocument;
  }> = [];

  for (const account of accounts.slice(0, 3)) {
    try {
      const result = await getArticleList(account.fakeid, {
        size: Math.min(maxArticles, 20),
        authKey: options.authKey,
      });

      if (result.articles.length > 0) {
        const document = parseWeChatArticleList(result.articles, account.nickname);
        articlesByAccount.push({ account, articles: result.articles, document });
      }
    } catch {
      // 单个账号获取失败不影响其他账号
      continue;
    }
  }

  if (articlesByAccount.length === 0) {
    throw new Error('搜索到的公众号均无法获取文章列表，可能认证已过期，请检查 WECHAT_EXPORTER_AUTH_KEY 配置。');
  }

  return { accounts, articlesByAccount };
}

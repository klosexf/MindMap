/**
 * WeChat Article Exporter API 客户端
 *
 * 基于开源项目 https://github.com/wechat-article/wechat-article-exporter
 * 通过其提供的 API 接口实现公众号文章数据的抓取功能。
 *
 * API 文档：https://documenter.getpostman.com/view/1276582/2sB3QDuXUa
 *
 * 认证方式：
 * - 所有 API 均需在 Header 中携带 X-Auth-Key
 * - auth-key 通过微信扫码登录 https://down.mptext.top 获取
 * - 有效期 4 天，过期需重新扫码
 *
 * 重要技术细节：
 * - Node.js 环境中访问微信/mptext 域名存在 TLS 证书问题，
 *   需检测 error.cause 中的 TLS 错误并回退到 node:https
 * - mptext 部署在 Cloudflare 上，部分请求可能触发 JS Challenge
 * - 微信文章内容为 JS 动态渲染，服务端直接 fetch 无法获取正文
 *
 * 部署方式：
 * - 公共实例：https://down.mptext.top
 * - Docker 私有化部署
 * - Cloudflare Workers 部署
 */

import https from 'node:https';

// ========== 类型定义 ==========

/** 搜索公众号返回的账号信息 */
export interface WeChatAccount {
  fakeid: string;
  nickname: string;
  alias: string;
  round_head_img: string;
  service_type: number;
  signature: string;
  username: string;
}

/** 文章列表中的单篇文章信息 */
export interface WeChatArticle {
  aid: string;
  title: string;
  digest: string;
  url: string;
  cover: string;
  author: string;
  create_time: number;
  update_time: number;
  is_original: number;
  copyright_stat: number;
  item_show_type: number;
  itemidx: number;
  appmsgid: string;
  publish_time?: number;
}

/** 搜索公众号的 API 响应（新 API /api/public/v1/account） */
export interface SearchAccountResponse {
  base_resp: { ret: number; err_msg?: string };
  list?: WeChatAccount[];
}

/** 获取文章列表的 API 响应（新 API /api/public/v1/article） */
export interface ArticleListResponse {
  ret: number;
  base_resp: { ret: number };
  publish_page: {
    list: Array<{
      publish_info: {
        article_list: WeChatArticle[];
        publish_time: number;
      };
      appmsgid: string;
    }>;
  };
  next_begin?: number;
}

/** auth-key 验证响应 */
export interface AuthKeyCheckResponse {
  code: number;
  msg: string;
}

/** 通过文章 URL 获取公众号信息响应 */
export interface AccountByUrlResponse {
  base_resp: { ret: number; err_msg?: string };
  fakeid?: string;
  nickname?: string;
  alias?: string;
  round_head_img?: string;
  signature?: string;
}

// ========== 客户端实现 ==========

const DEFAULT_BASE_URL = 'https://down.mptext.top';
const REQUEST_TIMEOUT_MS = 30_000;
const ARTICLE_LIST_PAGE_SIZE = 20;

function getBaseUrl(): string {
  return process.env.WECHAT_EXPORTER_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

function getAuthKey(): string | null {
  return process.env.WECHAT_EXPORTER_AUTH_KEY?.trim() || null;
}

/** 检测 URL 是否为微信公众号文章链接 */
export function isWeChatArticleUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname === 'mp.weixin.qq.com' && urlObj.pathname.startsWith('/s');
  } catch {
    return false;
  }
}

/** 从微信文章 URL 中提取参数 */
export function extractWeChatUrlParams(url: string): { biz: string; mid: string; idx: string; sn: string } | null {
  try {
    const urlObj = new URL(url);
    const biz = urlObj.searchParams.get('__biz');
    const mid = urlObj.searchParams.get('mid');
    const idx = urlObj.searchParams.get('idx');
    const sn = urlObj.searchParams.get('sn');

    if (!biz || !mid || !idx || !sn) return null;
    return { biz, mid, idx, sn };
  } catch {
    return null;
  }
}

/**
 * 构建请求头，包含认证信息
 */
function buildHeaders(authKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const key = authKey || getAuthKey();
  if (key) {
    headers['X-Auth-Key'] = key;
  }

  return headers;
}

/**
 * 检测是否为 TLS 证书错误
 *
 * Node.js 的 fetch 在 TLS 错误时 error.message 只有 "fetch failed"，
 * 真正的错误信息在 error.cause.message / error.cause.code 中。
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

/**
 * 带超时的 HTTPS GET 请求
 *
 * 优先使用标准 fetch（在测试环境中可被 mock）；
 * 如果遇到 TLS 证书错误（Node.js 环境常见于微信/mptext 域名），
 * 则回退到 node:https 模块并设置 rejectUnauthorized: false。
 */
async function httpsGet(url: string, headers: Record<string, string>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ status: number; statusText: string; text: () => Promise<string>; json: () => Promise<unknown> }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('timeout'), timeoutMs);
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeoutId);
    return response;
  } catch (fetchError) {
    if (!isTlsCertificateError(fetchError)) {
      throw fetchError;
    }
    // TLS 错误回退到 node:https（跳过证书验证）
    return httpsGetFallback(url, headers, timeoutMs);
  }
}

/**
 * 使用 node:https 的回退请求（跳过 SSL 证书验证）
 */
function httpsGetFallback(url: string, headers: Record<string, string>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ status: number; statusText: string; text: () => Promise<string>; json: () => Promise<unknown> }> {
  const urlObj = new URL(url);

  return new Promise((resolve, reject) => {
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
          httpsGetFallback(redirectUrl, headers, timeoutMs).then(resolve).catch(reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve({
            status: res.statusCode || 0,
            statusText: res.statusMessage || '',
            text: async () => body,
            json: async () => JSON.parse(body),
          });
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
 * 搜索公众号（新 API）
 *
 * @param keyword 搜索关键词（公众号名称）
 * @param options 可选参数
 * @returns 匹配的公众号列表
 */
export async function searchAccount(
  keyword: string,
  options: {
    authKey?: string;
  } = {},
): Promise<WeChatAccount[]> {
  const baseUrl = getBaseUrl();
  const params = new URLSearchParams({ keyword });
  const url = `${baseUrl}/api/public/v1/account?${params}`;

  const response = await httpsGet(url, buildHeaders(options.authKey));

  if (response.status < 200 || response.status >= 400) {
    throw new Error(`搜索公众号失败：HTTP ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as SearchAccountResponse;

  if (data.base_resp.ret !== 0) {
    if (data.base_resp.err_msg?.includes('认证') || data.base_resp.err_msg?.includes('auth')) {
      throw new Error('认证信息无效或已过期，请更新 WECHAT_EXPORTER_AUTH_KEY。');
    }
    throw new Error(`搜索公众号失败：${data.base_resp.err_msg || `ret=${data.base_resp.ret}`}`);
  }

  return data.list || [];
}

/**
 * 获取公众号文章列表（新 API）
 *
 * @param fakeid 公众号的 fakeid（通过 searchAccount 获取）
 * @param options 可选参数
 * @returns 文章列表及分页信息
 */
export async function getArticleList(
  fakeid: string,
  options: {
    begin?: number;
    size?: number;
    keyword?: string;
    authKey?: string;
  } = {},
): Promise<{ articles: WeChatArticle[]; nextBegin: number; hasMore: boolean }> {
  const baseUrl = getBaseUrl();
  const params = new URLSearchParams({
    fakeid,
    begin: String(options.begin ?? 0),
    size: String(options.size ?? ARTICLE_LIST_PAGE_SIZE),
  });

  if (options.keyword) {
    params.set('keyword', options.keyword);
  }

  const url = `${baseUrl}/api/public/v1/article?${params}`;
  const response = await httpsGet(url, buildHeaders(options.authKey));

  if (response.status < 200 || response.status >= 400) {
    throw new Error(`获取文章列表失败：HTTP ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as ArticleListResponse;

  if (data.ret !== 0) {
    if (data.ret === 200003 || data.ret === 200002) {
      throw new Error('微信会话已过期，请重新登录 wechat-article-exporter 获取新的 auth-key。');
    }
    throw new Error(`获取文章列表失败：ret=${data.ret}`);
  }

  const articles: WeChatArticle[] = [];
  const publishList = data.publish_page?.list || [];

  for (const item of publishList) {
    const articleList = item.publish_info?.article_list || [];
    for (const article of articleList) {
      articles.push({
        ...article,
        publish_time: item.publish_info.publish_time,
      });
    }
  }

  const nextBegin = data.next_begin ?? 0;
  const hasMore = nextBegin > (options.begin ?? 0) && articles.length >= (options.size ?? ARTICLE_LIST_PAGE_SIZE);

  return { articles, nextBegin, hasMore };
}

/**
 * 通过文章 URL 获取公众号信息
 *
 * @param articleUrl 微信文章 URL
 * @param options 可选参数
 */
export async function getAccountByUrl(
  articleUrl: string,
  options: {
    authKey?: string;
  } = {},
): Promise<AccountByUrlResponse> {
  const baseUrl = getBaseUrl();
  const params = new URLSearchParams({ url: articleUrl });
  const url = `${baseUrl}/api/public/v1/accountbyurl?${params}`;

  const response = await httpsGet(url, buildHeaders(options.authKey));

  if (response.status < 200 || response.status >= 400) {
    throw new Error(`获取公众号信息失败：HTTP ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as AccountByUrlResponse;
}

/**
 * 通过 mptext download API 下载微信文章内容
 *
 * 注意：此接口需要 auth-key（通过 X-Auth-Key 头传递）。
 * 如果无 auth-key，mptext 可能返回 Cloudflare Challenge 页面。
 *
 * @param articleUrl 微信文章 URL
 * @param options 可选参数
 * @returns 文章 HTML 内容
 */
export async function fetchArticleViaDownload(
  articleUrl: string,
  options: {
    authKey?: string;
    format?: 'html' | 'markdown' | 'text' | 'json';
  } = {},
): Promise<string> {
  const baseUrl = getBaseUrl();
  const params = new URLSearchParams({
    url: articleUrl,
    format: options.format || 'html',
  });

  const url = `${baseUrl}/api/public/v1/download?${params}`;
  const headers = buildHeaders(options.authKey);
  // download API 返回 HTML 时需要设置 Accept 为 html
  headers.Accept = 'text/html,application/json';
  const response = await httpsGet(url, headers);

  if (response.status < 200 || response.status >= 400) {
    throw new Error(`download API 失败：HTTP ${response.status} ${response.statusText}`);
  }

  const text = await response.text();

  // 检测 Cloudflare Challenge 拦截
  if (text.includes('challenge-platform') || text.includes('__CF$cv$params')) {
    throw new Error('download API 被 Cloudflare 拦截，请配置有效的 WECHAT_EXPORTER_AUTH_KEY。');
  }

  // html 格式直接返回
  if (options.format === 'html' || !options.format) {
    return text;
  }

  // 其他格式尝试解析 JSON
  try {
    const data = JSON.parse(text);
    return typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    return text;
  }
}

/**
 * 批量获取公众号文章列表（自动翻页）
 *
 * @param fakeid 公众号的 fakeid
 * @param options 可选参数
 * @returns 所有文章列表
 */
export async function getAllArticles(
  fakeid: string,
  options: {
    maxPages?: number;
    keyword?: string;
    authKey?: string;
  } = {},
): Promise<WeChatArticle[]> {
  const maxPages = options.maxPages ?? 5;
  const allArticles: WeChatArticle[] = [];
  let begin = 0;
  let pageCount = 0;

  while (pageCount < maxPages) {
    const result = await getArticleList(fakeid, {
      begin,
      keyword: options.keyword,
      authKey: options.authKey,
    });

    allArticles.push(...result.articles);
    pageCount++;

    if (!result.hasMore) break;
    begin = result.nextBegin;
  }

  return allArticles;
}

/**
 * 检查 wechat-article-exporter 服务是否可用
 */
export async function checkServiceAvailability(): Promise<{
  available: boolean;
  message: string;
  baseUrl: string;
}> {
  const baseUrl = getBaseUrl();

  try {
    const response = await httpsGet(
      `${baseUrl}/api/public/v1/authkey`,
      buildHeaders(),
      10_000,
    );

    if (response.status < 200 || response.status >= 400) {
      return {
        available: false,
        message: `wechat-article-exporter 服务返回异常状态：HTTP ${response.status}`,
        baseUrl,
      };
    }

    const data = (await response.json()) as AuthKeyCheckResponse;

    if (data.code === 0) {
      return {
        available: true,
        message: 'wechat-article-exporter 服务可用，且 auth-key 有效。',
        baseUrl,
      };
    }

    return {
      available: false,
      message: 'wechat-article-exporter 服务可用，但 auth-key 无效或已过期。请更新 WECHAT_EXPORTER_AUTH_KEY。',
      baseUrl,
    };
  } catch (error) {
    return {
      available: false,
      message: `无法连接 wechat-article-exporter 服务：${error instanceof Error ? error.message : '未知错误'}`,
      baseUrl,
    };
  }
}

// ========== 搜狗微信搜索相关 ==========

/** 搜狗微信搜索结果项 */
export interface SogouSearchResult {
  title: string;
  url: string; // 搜狗跳转链接（http://mp.weixin.qq.com/... 经过搜狗中转）
  snippet: string; // 文章摘要
  author: string; // 公众号名称
}

/**
 * 从微信文章 URL 中提取可用于搜索的关键词
 *
 * 优先使用 URL 中的 ch 参数（微信文章的 checksum，通常与标题相关），
 * 否则使用 sn 参数，最后降级为整个 URL 的参数部分
 */
function extractSearchKeywordsFromWeChatUrl(articleUrl: string): string {
  const urlParams = extractWeChatUrlParams(articleUrl);

  // 尝试用 URL 中的参数构建搜索词
  // sn 是文章唯一标识，虽然不是可读关键词，但搜狗有时能通过它找到对应文章
  if (urlParams?.sn) {
    // sn 太长不适合直接搜索，截取前 8 位
    return urlParams.sn.slice(0, 8);
  }

  return '';
}

/**
 * 通过搜狗微信搜索查找微信公众号文章
 *
 * 利用搜狗微信搜索（weixin.sogou.com）搜索文章标题或关键词，
 * 返回匹配的搜索结果列表。
 *
 * 搜狗微信搜索是腾讯提供的官方微信文章搜索引擎，
 * 可以搜索到大量微信公众号发布的文章。
 *
 * @param query 搜索关键词（文章标题或关键词）
 * @param options 可选参数
 * @returns 搜索结果列表
 */
export async function searchWeChatArticleViaSogou(
  query: string,
  options: {
    page?: number;
  } = {},
): Promise<SogouSearchResult[]> {
  const page = options.page ?? 1;
  const searchUrl = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(query)}&ie=utf8&s_from=input&_sug_=n&_sug_type=&page=${page}`;

  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    Referer: 'https://weixin.sogou.com/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('timeout'), 15_000);

    const response = await fetch(searchUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`搜狗微信搜索请求失败：HTTP ${response.status}`);
    }

    const html = await response.text();

    // 检测是否被搜狗反爬拦截
    if (html.includes('用户您好，您的访问过于频繁') || html.includes('antispider') || html.includes('验证码')) {
      throw new Error('搜狗微信搜索触发反爬验证，请稍后重试。');
    }

    // 解析搜索结果
    return parseSogouSearchResults(html);
  } catch (error) {
    if (error instanceof Error && error.message.includes('搜狗')) {
      throw error;
    }
    throw new Error(`搜狗微信搜索失败：${error instanceof Error ? error.message : '未知错误'}`);
  }
}

/**
 * 解析搜狗微信搜索结果页面 HTML
 *
 * 从搜狗搜索结果页面中提取文章标题、链接、摘要和作者信息。
 */
function parseSogouSearchResults(html: string): SogouSearchResult[] {
  const results: SogouSearchResult[] = [];

  // 搜狗微信搜索结果在 <div class="txt-box"> 中
  // 每个结果包含：<h3><a href="链接">标题</a></h3>、<p class="txt-info">摘要</p>、<div class="s-p">作者信息</div>
  const resultRegex = /<div\s+class="txt-box"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let match: RegExpExecArray | null;

  while ((match = resultRegex.exec(html)) !== null) {
    const block = match[1];

    // 提取标题和链接
    const titleMatch = block.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;

    const url = titleMatch[1].replace(/&amp;/g, '&');
    const title = titleMatch[2]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();

    if (!title || !url) continue;

    // 提取摘要
    const snippetMatch = block.match(/<p\s+class="txt-info"[^>]*>([\s\S]*?)<\/p>/);
    const snippet = snippetMatch
      ? snippetMatch[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .trim()
      : '';

    // 提取作者/公众号名称
    const authorMatch = block.match(/<a[^>]*class="account"[^>]*>([\s\S]*?)<\/a>/) ||
      block.match(/<span\s+class="s2"[^>]*>([\s\S]*?)<\/span>/);
    const author = authorMatch
      ? authorMatch[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .trim()
      : '';

    results.push({ title, url, snippet, author });
  }

  return results;
}

/**
 * 通过搜狗微信搜索获取微信公众号文章内容
 *
 * 策略：
 * 1. 从微信文章 URL 中提取搜索关键词
 * 2. 在搜狗微信搜索中搜索该文章
 * 3. 如果搜到匹配的文章，尝试通过搜狗跳转链接访问文章
 * 4. 如果搜狗跳转链接可获取到完整 HTML，返回 HTML 内容
 *
 * 注意：
 * - 搜狗微信搜索是腾讯官方的微信文章搜索引擎
 * - 搜索结果中的链接是搜狗的中转链接，有时可以绕过微信的直接反爬
 * - 但搜狗自身也有反爬机制，频繁请求会触发验证码
 * - 不需要 auth-key 或 API Key，零配置即可使用
 *
 * @param articleUrl 微信文章 URL（mp.weixin.qq.com/s?...）
 * @returns 文章 HTML 内容，如果无法获取则返回 null
 */
export async function fetchArticleViaSogou(
  articleUrl: string,
): Promise<{ html: string; title: string } | null> {
  // 1. 从微信文章 URL 提取搜索关键词
  const urlParams = extractWeChatUrlParams(articleUrl);
  const snParam = urlParams?.sn || '';

  if (!snParam) {
    return null; // 没有 sn 参数无法搜索
  }

  // 2. 使用 sn 前缀作为搜索关键词（搜狗有时能根据 sn 找到文章）
  // 但 sn 本身不太可读，所以也尝试直接搜索 URL
  const searchStrategies = [
    // 策略一：直接用微信文章的 sn 参数搜索
    `site:mp.weixin.qq.com ${snParam.slice(0, 12)}`,
    // 策略二：搜全文链接中的关键参数
    snParam.slice(0, 16),
  ];

  for (const query of searchStrategies) {
    try {
      const results = await searchWeChatArticleViaSogou(query);
      if (results.length === 0) continue;

      // 3. 在搜索结果中查找匹配的文章
      // 通过 sn 参数匹配（微信文章 URL 中的 sn 是文章唯一标识）
      const matchedResult = results.find((r) => {
        // 检查搜索结果链接是否包含相同的 sn 参数
        try {
          const resultUrl = r.url;
          // 搜狗返回的链接可能是跳转链接，也可能包含原始链接参数
          return resultUrl.includes(snParam) || resultUrl.includes('mp.weixin.qq.com');
        } catch {
          return false;
        }
      });

      // 如果没有精确匹配，取第一个结果
      const targetResult = matchedResult || results[0];

      // 4. 通过搜狗跳转链接尝试获取文章内容
      if (targetResult.url) {
        try {
          const articleHtml = await fetchArticleViaSogouLink(targetResult.url);
          if (articleHtml && (articleHtml.includes('rich_media_content') || articleHtml.includes('js_content'))) {
            return {
              html: articleHtml,
              title: targetResult.title,
            };
          }
        } catch {
          // 跳转链接获取失败，继续下一个策略
          continue;
        }
      }
    } catch {
      // 搜索失败，继续下一个策略
      continue;
    }
  }

  return null;
}

/**
 * 通过搜狗跳转链接获取微信文章内容
 *
 * 搜狗搜索结果中的链接是搜狗的中转链接，格式类似：
 * https://weixin.sogou.com/link?url=...&type=2...
 * 这个链接会跳转到真实的微信文章 URL
 *
 * 我们可以直接请求搜狗的跳转链接，尝试获取文章内容。
 * 搜狗链接有时能绕过微信的直接反爬。
 */
async function fetchArticleViaSogouLink(sogouUrl: string): Promise<string | null> {
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    Referer: 'https://weixin.sogou.com/',
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('timeout'), 15_000);

    const response = await fetch(sogouUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const html = await response.text();

    // 检测是否为微信拦截页面
    if (html.includes('环境异常') || html.includes('频繁访问') || html.includes('请在微信客户端打开')) {
      return null;
    }

    // 检测是否包含文章正文内容
    if (html.includes('rich_media_content') || html.includes('js_content')) {
      return html;
    }

    return null;
  } catch {
    return null;
  }
}

// ========== 腾讯混元（元宝）搜索增强相关 ==========

/** 腾讯混元搜索增强响应中的搜索结果项 */
export interface HunyuanSearchResult {
  title: string;
  url: string;
  snippet: string;
  site: string;
}

/** 腾讯混元 ChatCompletions + 搜索增强 的响应结构 */
interface HunyuanChatResponse {
  id: string;
  choices: Array<{
    message: {
      content: string;
      role: string;
    };
    finish_reason: string;
  }>;
  search_info?: {
    search_results: Array<{
      title: string;
      url: string;
      snippet: string;
      site: string;
    }>;
  };
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * 通过腾讯混元（元宝）搜索增强获取微信公众号文章内容
 *
 * 腾讯混元大模型是腾讯自研的大语言模型，拥有微信生态独家资源：
 * - 整合微信公众号和视频号内容
 * - 通过 EnableEnhancement 开启搜索增强，模型可自动搜索微信文章
 * - ForceSearchEnhancement 强制走 AI 搜索，确保命中微信生态内容
 *
 * 这是目前获取微信公众号文章最可靠的 AI 方案，因为：
 * 1. 腾讯混元是腾讯自家产品，拥有微信生态数据权限
 * 2. 搜索增强功能可搜索到微信公众号文章
 * 3. 无需 auth-key，只需腾讯云 API Key
 *
 * API 接入：
 * - base_url: https://api.hunyuan.cloud.tencent.com/v1
 * - 接口: /chat/completions（OpenAI 兼容格式）
 * - API Key: 在腾讯云控制台 https://console.cloud.tencent.com/hunyuan/start 创建
 *
 * @param articleUrl 微信文章 URL
 * @param options 可选参数
 * @returns 文章标题和摘要内容
 */
export async function summarizeWeChatArticleViaHunyuan(
  articleUrl: string,
  options: {
    model?: string;
  } = {},
): Promise<{ title: string; summary: string; searchResults?: HunyuanSearchResult[] }> {
  const apiKey = process.env.HUNYUAN_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('腾讯混元 API Key 未配置，请设置 HUNYUAN_API_KEY 环境变量。');
  }

  const baseUrl = process.env.HUNYUAN_BASE_URL?.trim() || 'https://api.hunyuan.cloud.tencent.com/v1';
  const chatUrl = `${baseUrl}/chat/completions`;
  const model = options.model || process.env.HUNYUAN_MODEL?.trim() || 'hunyuan-turbos-latest';

  // 从微信文章 URL 中提取标识信息
  const urlParams = extractWeChatUrlParams(articleUrl);
  const snParam = urlParams?.sn || '';

  const body = {
    model,
    messages: [
      {
        role: 'system',
        content: '你是一个专业的内容分析助手。你的任务是通过联网搜索获取指定微信公众号文章的完整内容，然后给出详细的中文摘要。摘要应包含：1）文章标题；2）核心观点和论述；3）关键细节和数据。要求忠实原文，不编造内容。',
      },
      {
        role: 'user',
        content: `请通过联网搜索，获取以下微信公众号文章的完整内容并给出详细摘要：\n\n文章链接：${articleUrl}${snParam ? `\n文章标识：sn=${snParam}` : ''}\n\n请务必使用搜索功能来获取这篇文章的内容，然后基于搜索结果输出摘要。如果搜索结果中包含了文章全文，请尽量完整地总结；如果只有部分内容，则基于已有信息总结。`,
      },
    ],
    // 腾讯混元搜索增强参数
    enable_enhancement: true,       // 开启功能增强（搜索）
    search_info: true,              // 返回搜索来源信息
    citation: true,                 // 开启引文角标
    force_search_enhancement: true, // 强制走AI搜索，确保搜索微信生态内容
    temperature: 0.2,
    max_tokens: 4096,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const response = await httpsGetWithPost(chatUrl, headers, body, 60_000);

  if (response.status < 200 || response.status >= 400) {
    throw new Error(`腾讯混元 Chat API 失败：HTTP ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as HunyuanChatResponse;

  const content = data.choices?.[0]?.message?.content;
  if (!content || content.trim().length === 0) {
    throw new Error('腾讯混元返回内容为空，可能无法搜索到该微信文章。');
  }

  // 提取标题
  let title = '微信公众号文章';

  // 优先从 search_info 中获取标题
  const searchResults: HunyuanSearchResult[] = (data.search_info?.search_results || []).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.snippet || '',
    site: r.site || '',
  }));

  if (searchResults.length > 0 && searchResults[0].title) {
    title = searchResults[0].title;
  }

  // 如果摘要内容中包含标题格式，尝试提取
  const titleMatch = content.match(/^#\s+(.+)$/m) || content.match(/^标题[：:]\s*(.+)$/m);
  if (titleMatch && titleMatch[1]) {
    title = titleMatch[1].trim();
  }

  return { title, summary: content.trim(), searchResults: searchResults.length > 0 ? searchResults : undefined };
}

function buildWeChatMindMapSearchMessages(articleUrl: string, snParam = ''): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        '你是一个严格的知识提取工具，不是创作助手。',
        '你的唯一工作是通过联网搜索获取指定微信公众号文章的内容，然后组织为思维导图结构。',
        '绝对禁止编造、推测、补充、合理化任何文章中未明确出现的信息。',
        '遇到模糊或无法识别的内容，直接忽略，不要猜测。',
        '文章中没有的分类维度，不要创建节点。',
        '你必须优先提炼高信息密度内容：核心结论、关键事实、数字、因果、步骤、案例、风险、限制、建议。',
        '不要把输出重点放在泛化章节名或空洞分类上。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '请通过联网搜索，获取以下微信公众号文章的完整内容，然后从中提取信息组织为思维导图。',
        '',
        `文章链接：${articleUrl}${snParam ? `\n文章标识：sn=${snParam}` : ''}`,
        '',
        '## 搜索与提炼流程（内部执行，不要输出过程）',
        '1. 优先定位文章标题、核心结论、关键论点与原文中的高价值细节。',
        '2. 如果搜索结果来自多个片段，先在内部拼合与交叉核对，再生成导图；片段不足时宁可少写，也不要猜测。',
        '3. 先判断文章主要在回答什么问题，再提炼“是什么 / 为什么 / 怎么做 / 结果如何 / 有何限制”等真正帮助理解的内容。',
        '4. 优先保留原文中的专有名词、人名、公司名、时间、数字、比例、条件、对比项与结论性表达。',
        '5. 先区分信息角色：结论放父节点，证据/案例/方法/数据/限制放子节点，不要混成一层。',
        '',
        '## 绝对规则（违反任何一条即视为失败）',
        '1. 只输出文章中明确出现的信息。文章没写的，一个字也不许加。',
        '2. 文章中模糊、无法识别或证据不足的内容，直接忽略，不要猜测其含义。',
        '3. 文章中不存在的分类/维度，不要创建对应节点。',
        '4. 不许编造数据、案例、人名、公司名、观点归因等任何原文未提及的细节。',
        '5. 不要只复述小标题或章节名，必须提炼出这些段落真正表达的判断、动作、结果或限制。',
        '',
        '## 结构与质量要求',
        '- 忠实原文：所有节点内容必须源自文章原文，可概括和重组，但绝不可添加原文没有的信息。',
        '- 高价值优先：优先保留核心主张、关键事实、步骤方法、数据证据、结果影响、风险限制、建议动作。',
        '- 按需提取：只创建文章中确实有内容的分类，2-8 个一级节点均可，不凑数。',
        '- 语义聚合：关联紧密且属于同一逻辑角色的信息才能合并；不要把“原因/做法/结果”混在同一父节点下。',
        '- 逻辑递进：同级节点按时间、结构、因果、重要性四者之一排序，不得随机排列。',
        '- 覆盖检查：如果原文中明确出现了问题、原因、方法、结果、风险、建议、数据、案例中的任意类型，应尽量在导图中保留对应关键信息。',
        '- 节点写法：优先写成“对象 + 判断/动作/结果”，避免“背景”“分析”“启示”“其他”等空泛词。',
        '- 用户可读性：节点应脱离上下文也能理解，尽量保留对象、动作、条件和结果。',
        '',
        '## 输出规则',
        '1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。',
        '2. JSON 结构：{"title":"文章标题","root":{"content":"主题","children":[...]}}。',
        '3. 每个节点只有 content（字符串）和 children（数组）。',
        '4. 一级主题数量由文章实际内容决定（2-8 个），不凑数。',
        '5. 专业名词、人名、数据必须原样保留。',
        '6. 如果某个维度文章中没有相关信息，就不创建该节点。',
        '7. 禁止空标签节点（仅写分类名称而无实质内容）。',
        '8. 节点文本控制在 35 字以内；超长时拆成父子节点，不要截断关键信息。',
        '9. 输出前做一次遗漏扫描：是否漏掉最重要的结论、数据、方法、风险或案例。',
        '',
        '请务必使用搜索功能来获取这篇文章的内容！',
      ].join('\n'),
    },
  ];
}

/**
 * 通过腾讯混元（元宝）搜索增强直接生成微信文章思维导图 JSON
 *
 * 这是最优方案：让混元在搜索增强模式下自动搜索微信文章内容，
 * 然后直接输出思维导图 JSON。完全跳过"先获取全文再生成"的两步流程。
 *
 * 优势：
 * - 腾讯混元是腾讯自家产品，拥有微信生态独家数据权限
 * - 搜索增强功能可搜索到微信公众号文章
 * - 一步到位，效率最高
 *
 * @param articleUrl 微信文章 URL
 * @returns 思维导图 JSON 字符串和标题
 */
export async function generateWeChatMindMapViaHunyuan(
  articleUrl: string,
): Promise<{ json: string; title: string }> {
  const apiKey = process.env.HUNYUAN_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('腾讯混元 API Key 未配置，请设置 HUNYUAN_API_KEY 环境变量。');
  }

  const baseUrl = process.env.HUNYUAN_BASE_URL?.trim() || 'https://api.hunyuan.cloud.tencent.com/v1';
  const chatUrl = `${baseUrl}/chat/completions`;
  const model = process.env.HUNYUAN_MODEL?.trim() || 'hunyuan-turbos-latest';

  // 从微信文章 URL 中提取标识信息
  const urlParams = extractWeChatUrlParams(articleUrl);
  const snParam = urlParams?.sn || '';

  const body = {
    model,
    messages: buildWeChatMindMapSearchMessages(articleUrl, snParam),
    // 腾讯混元搜索增强参数
    enable_enhancement: true,
    search_info: true,
    citation: true,
    force_search_enhancement: true,
    temperature: 0.2,
    max_tokens: 8000,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const response = await httpsGetWithPost(chatUrl, headers, body, 90_000);

  if (response.status < 200 || response.status >= 400) {
    throw new Error(`腾讯混元 Chat API 失败：HTTP ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as HunyuanChatResponse;

  const content = data.choices?.[0]?.message?.content;
  if (!content || content.trim().length === 0) {
    throw new Error('腾讯混元返回内容为空，可能无法搜索到该微信文章。');
  }

  // 提取标题
  let title = '微信公众号文章';
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.title && typeof parsed.title === 'string') {
        title = parsed.title;
      }
    }
  } catch {
    // JSON 解析失败，降级
  }

  // 优先从 search_info 中获取标题
  const searchResults = data.search_info?.search_results;
  if (searchResults && searchResults.length > 0 && searchResults[0].title) {
    title = searchResults[0].title;
  }

  return { json: content.trim(), title };
}

// ========== 智谱AI Web Search 相关 ==========

/** 智谱AI web_search API 响应中的搜索结果项 */
export interface ZhipuWebSearchResult {
  title: string;
  content: string;
  link: string;
  media: string;
  icon: string;
  refer: string;
  publish_date?: string;
}

/** 智谱AI web_search API 响应 */
export interface ZhipuWebSearchResponse {
  id: string;
  created: number;
  request_id?: string;
  search_intent?: Array<{
    query: string;
    intent: string;
    keywords: string;
  }>;
  search_result: ZhipuWebSearchResult[];
}

/**
 * 通过智谱AI web_search API 搜索微信公众号文章内容
 *
 * 利用智谱AI的联网搜索能力，搜索微信文章的相关内容。
 * 这可以作为 mptext download API 的替代方案，无需配置 auth-key。
 *
 * @param articleUrl 微信文章 URL
 * @param options 可选参数
 * @returns 搜索结果列表
 */
export async function searchWeChatArticleViaZhipu(
  articleUrl: string,
  options: {
    count?: number;
    contentSize?: 'medium' | 'high';
  } = {},
): Promise<ZhipuWebSearchResult[]> {
  const apiKey = process.env.ZHIPU_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('智谱AI API Key 未配置，请设置 ZHIPU_API_KEY 环境变量。');
  }

  const baseUrl = process.env.ZHIPU_BASE_URL?.trim() || 'https://open.bigmodel.cn/api/paas/v4';
  const url = `${baseUrl}/web_search`;

  // 从微信文章 URL 中提取文章标识信息用于搜索
  const urlParams = extractWeChatUrlParams(articleUrl);
  const snParam = urlParams?.sn || '';

  // 构建搜索查询 — 使用文章 URL 的 sn 参数 + 域名过滤
  const searchQuery = `微信公众号文章 ${snParam} site:mp.weixin.qq.com`;

  const body = {
    search_query: searchQuery.slice(0, 70), // web_search 最大 70 字符
    search_engine: 'search_pro',
    search_intent: false,
    count: options.count ?? 10,
    search_domain_filter: 'mp.weixin.qq.com',
    content_size: options.contentSize ?? 'high',
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const response = await httpsGetWithPost(url, headers, body, 30_000);

  if (response.status < 200 || response.status >= 400) {
    throw new Error(`智谱AI web_search 失败：HTTP ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as ZhipuWebSearchResponse;

  if (!data.search_result || data.search_result.length === 0) {
    throw new Error('智谱AI web_search 未返回搜索结果，可能该文章未被搜索引擎收录。');
  }

  return data.search_result;
}

/**
 * 通过智谱AI Chat Completions + web_search tool 直接总结微信文章内容
 *
 * 这是最优方案：让智谱AI在对话中自动联网搜索文章内容，然后输出结构化摘要。
 * 不需要先获取全文，智谱AI会自行搜索并总结。
 *
 * @param articleUrl 微信文章 URL
 * @param options 可选参数
 * @returns 文章标题和摘要内容
 */
export async function summarizeWeChatArticleViaZhipuChat(
  articleUrl: string,
  options: {
    model?: string;
  } = {},
): Promise<{ title: string; summary: string }> {
  const apiKey = process.env.ZHIPU_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('智谱AI API Key 未配置，请设置 ZHIPU_API_KEY 环境变量。');
  }

  const baseUrl = process.env.ZHIPU_BASE_URL?.trim() || 'https://open.bigmodel.cn/api/paas/v4';
  const chatUrl = `${baseUrl}/chat/completions`;
  const model = options.model || process.env.LLM_MODEL?.trim() || 'glm-4';

  const body = {
    model,
    messages: [
      {
        role: 'system',
        content: '你是一个专业的内容分析助手。你的任务是通过联网搜索获取指定微信公众号文章的完整内容，然后给出详细的中文摘要。摘要应包含：1）文章标题；2）核心观点和论述；3）关键细节和数据。要求忠实原文，不编造内容。',
      },
      {
        role: 'user',
        content: `请通过联网搜索，获取以下微信公众号文章的完整内容并给出详细摘要：\n\n文章链接：${articleUrl}\n\n请务必使用搜索工具来获取这篇文章的内容，然后基于搜索结果输出摘要。如果搜索结果中包含了文章全文，请尽量完整地总结；如果只有部分内容，则基于已有信息总结。`,
      },
    ],
    tools: [
      {
        type: 'web_search',
        web_search: {
          enable: true,
          search_engine: 'search_pro',
          search_result: true,
          count: 5,
          search_domain_filter: 'mp.weixin.qq.com',
          content_size: 'high',
        },
      },
    ],
    temperature: 0.2,
    max_tokens: 4096,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const response = await httpsGetWithPost(chatUrl, headers, body, 60_000);

  if (response.status < 200 || response.status >= 400) {
    throw new Error(`智谱AI Chat API 失败：HTTP ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{
      message: {
        content: string;
        tool_calls?: Array<{
          type: string;
          web_search?: {
            search_result: ZhipuWebSearchResult[];
          };
        }>;
      };
    }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content || content.trim().length === 0) {
    throw new Error('智谱AI 返回内容为空，可能无法搜索到该文章。');
  }

  // 尝试从搜索结果中提取标题
  const toolCalls = data.choices?.[0]?.message?.tool_calls;
  let title = '微信公众号文章';
  if (toolCalls && toolCalls.length > 0) {
    const searchResults = toolCalls
      .filter((tc) => tc.web_search?.search_result)
      .flatMap((tc) => tc.web_search!.search_result);
    if (searchResults.length > 0 && searchResults[0].title) {
      title = searchResults[0].title;
    }
  }

  // 如果摘要内容中包含标题格式，尝试提取
  const titleMatch = content.match(/^#\s+(.+)$/m) || content.match(/^标题[：:]\s*(.+)$/m);
  if (titleMatch && titleMatch[1]) {
    title = titleMatch[1].trim();
  }

  return { title, summary: content.trim() };
}

/**
 * 带超时的 HTTPS POST 请求
 */
async function httpsGetWithPost(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; statusText: string; text: () => Promise<string>; json: () => Promise<unknown> }> {
  const bodyStr = JSON.stringify(body);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('timeout'), timeoutMs);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeoutId);
    return response;
  } catch (fetchError) {
    if (!isTlsCertificateError(fetchError)) {
      throw fetchError;
    }
    // TLS 错误回退到 node:https
    return httpsPostFallback(url, headers, bodyStr, timeoutMs);
  }
}

/**
 * 使用 node:https 的 POST 回退请求（跳过 SSL 证书验证）
 */
function httpsPostFallback(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; statusText: string; text: () => Promise<string>; json: () => Promise<unknown> }> {
  const urlObj = new URL(url);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      req.destroy();
      reject(new Error(`请求超时（${timeoutMs}ms）`));
    }, timeoutMs);

    const req = https.request(
      urlObj,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        agent: new https.Agent({ rejectUnauthorized: false }),
      },
      (res) => {
        clearTimeout(timeoutId);

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf-8');
          resolve({
            status: res.statusCode || 0,
            statusText: res.statusMessage || '',
            text: async () => responseBody,
            json: async () => JSON.parse(responseBody),
          });
        });
        res.on('error', reject);
      },
    );

    req.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

/**
 * 通过智谱AI Chat Completions + web_search tool 直接生成微信文章思维导图
 *
 * 这是最优方案：让智谱AI在对话中自动联网搜索文章内容，然后直接输出思维导图 JSON。
 * 完全跳过"先获取全文再生成"的两步流程，一步到位。
 *
 * 优势：
 * - 无需 mptext download API / auth-key
 * - 无需直接 fetch 微信文章
 * - 智谱AI通过联网搜索自动获取文章内容
 * - 直接输出思维导图 JSON，效率最高
 *
 * @param articleUrl 微信文章 URL
 * @param options 可选参数
 * @returns 思维导图 JSON 字符串
 */
export async function generateWeChatMindMapViaZhipuWebSearch(
  articleUrl: string,
  options: {
    model?: string;
  } = {},
): Promise<{ json: string; title: string }> {
  const apiKey = process.env.ZHIPU_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('智谱AI API Key 未配置，请设置 ZHIPU_API_KEY 环境变量。');
  }

  const baseUrl = process.env.ZHIPU_BASE_URL?.trim() || 'https://open.bigmodel.cn/api/paas/v4';
  const chatUrl = `${baseUrl}/chat/completions`;
  const model = options.model || process.env.LLM_MODEL?.trim() || 'glm-4';

  const body = {
    model,
    messages: buildWeChatMindMapSearchMessages(articleUrl),
    tools: [
      {
        type: 'web_search',
        web_search: {
          enable: true,
          search_engine: 'search_pro',
          search_result: true,
          count: 5,
          search_domain_filter: 'mp.weixin.qq.com',
          content_size: 'high',
        },
      },
    ],
    temperature: 0.2,
    max_tokens: 8000,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const response = await httpsGetWithPost(chatUrl, headers, body, 90_000);

  if (response.status < 200 || response.status >= 400) {
    throw new Error(`智谱AI Chat API 失败：HTTP ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices: Array<{
      message: {
        content: string;
      };
    }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content || content.trim().length === 0) {
    throw new Error('智谱AI 返回内容为空，可能无法搜索到该微信文章。');
  }

  // 提取标题（优先从 JSON 中提取，降级为从内容中提取）
  let title = '微信公众号文章';
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.title && typeof parsed.title === 'string') {
        title = parsed.title;
      }
    }
  } catch {
    // JSON 解析失败，降级
  }

  return { json: content.trim(), title };
}

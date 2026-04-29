import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { chunkMarkdown } from '@/lib/utils/chunk';
import { createSourceRefFallback } from '@/lib/utils/tree';
import type { NormalizedDocument } from '@/lib/types/mindmap';
import { isWeChatArticleUrl, parseWeChatUrl } from '@/lib/parsers/wechat';

function htmlToMarkdownFallback(title: string, content: string): string {
  return `# ${title}\n\n${content}`.replace(/\n{3,}/g, '\n\n').trim();
}

/** 解析 fetch 失败原因，返回用户友好的错误信息 */
function resolveFetchErrorMessage(url: string, error: unknown): string {
  const urlObj = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();

  const hostname = urlObj?.hostname ?? '';

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();

    // 超时
    if (msg.includes('timeout') || msg.includes('abort') || msg.includes('signal')) {
      return `请求超时：目标页面响应时间过长，请稍后重试或更换链接。`;
    }

    // DNS / 网络不可达
    if (
      msg.includes('eai_again') ||
      msg.includes('enotfound') ||
      msg.includes('getaddrinfo') ||
      msg.includes('dns') ||
      msg.includes('network') ||
      msg.includes('unreachable')
    ) {
      return `无法访问该链接：DNS 解析失败或网络不可达，请检查链接是否正确。`;
    }

    // 连接被拒绝 / 重置
    if (
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('connection refused') ||
      msg.includes('connection reset')
    ) {
      return `连接被拒绝：目标服务器拒绝了连接请求，可能该链接已失效。`;
    }

    // SSL / 证书错误
    if (
      msg.includes('certificate') ||
      msg.includes('ssl') ||
      msg.includes('tls') ||
      msg.includes('self signed') ||
      msg.includes('unable to verify')
    ) {
      return `SSL 证书错误：目标网站证书存在问题，无法建立安全连接。`;
    }

    // 常见平台拦截提示
    if (hostname.includes('mp.weixin.qq.com')) {
      if (msg.includes('403') || msg.includes('forbidden') || msg.includes('blocked')) {
        return `微信文章拦截：微信公众号文章对非浏览器访问有限制，建议复制文章内容粘贴到「文本」模式生成。`;
      }
      return `无法获取微信文章内容：微信公众号文章通常需要浏览器环境才能访问，建议复制文章内容粘贴到「文本」模式生成。`;
    }

    if (hostname.includes('zhihu.com')) {
      return `知乎反爬拦截：知乎对自动化访问有限制，建议复制文章内容粘贴到「文本」模式生成。`;
    }

    if (hostname.includes('jianshu.com')) {
      return `简书反爬拦截：简书对自动化访问有限制，建议复制文章内容粘贴到「文本」模式生成。`;
    }

    if (hostname.includes('weibo.com') || hostname.includes('weibo.cn')) {
      return `微博访问受限：微博对自动化访问有限制，建议复制文章内容粘贴到「文本」模式生成。`;
    }

    if (hostname.includes('x.com') || hostname.includes('twitter.com')) {
      return `Twitter/X 需要登录：该平台内容通常需要登录后才能访问，建议复制文章内容粘贴到「文本」模式生成。`;
    }

    // 通用 fetch failed
    if (msg.includes('fetch failed')) {
      return `获取页面失败：目标网站可能禁止了自动化访问，建议复制文章内容粘贴到「文本」模式生成。`;
    }
  }

  return `获取页面失败：无法访问该链接，请检查链接是否有效，或尝试复制文章内容粘贴到「文本」模式生成。`;
}

/** 根据 HTTP 状态码返回友好错误 */
function resolveHttpErrorMessage(status: number, statusText: string, url: string): string {
  const hostname = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();

  if (status === 403 || status === 401) {
    if (hostname.includes('mp.weixin.qq.com')) {
      return `微信文章访问受限（403）：微信公众号文章对非浏览器访问有限制，建议复制文章内容粘贴到「文本」模式生成。`;
    }
    return `访问被拒绝（${status}）：目标网站禁止了自动化访问，建议复制文章内容粘贴到「文本」模式生成。`;
  }

  if (status === 404) {
    return `页面不存在（404）：该链接可能已失效或被删除，请检查链接是否正确。`;
  }

  if (status === 429) {
    return `请求过于频繁（429）：目标网站限流，请稍后重试。`;
  }

  if (status >= 500) {
    return `目标服务器错误（${status}）：对方服务器暂时不可用，请稍后重试。`;
  }

  return `获取页面失败（${status} ${statusText}）：无法访问该链接，请检查链接是否有效。`;
}

export async function parseUrlInput(url: string): Promise<NormalizedDocument> {
  // 1. URL 格式校验
  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    throw new Error('链接格式不正确，请输入以 http:// 或 https:// 开头的有效 URL');
  }

  const allowedProtocols = ['http:', 'https:'];
  if (!allowedProtocols.includes(urlObj.protocol)) {
    throw new Error('仅支持 http:// 或 https:// 开头的链接');
  }

  // 1.5 自动检测微信公众号文章链接，路由到 wechat 解析器
  if (isWeChatArticleUrl(url)) {
    return parseWeChatUrl(url);
  }

  // 2. 执行 fetch，带超时和完善的错误捕获
  const FETCH_TIMEOUT_MS = 15_000;
  let response: Response;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);

    response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
  } catch (fetchError) {
    throw new Error(resolveFetchErrorMessage(url, fetchError));
  }

  // 3. HTTP 状态码校验
  if (!response.ok) {
    throw new Error(resolveHttpErrorMessage(response.status, response.statusText, url));
  }

  // 4. 内容类型校验（避免下载二进制文件）
  const contentType = response.headers.get('content-type') || '';
  if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    // 允许无 content-type 的情况（部分服务器不返回），但如果是明确的非 HTML 则拒绝
    if (contentType.includes('application/pdf') || contentType.includes('image/') || contentType.includes('video/')) {
      throw new Error(`该链接指向的不是网页（类型：${contentType}），请输入文章链接。`);
    }
  }

  // 5. 读取并解析 HTML
  let html: string;
  try {
    html = await response.text();
  } catch {
    throw new Error('读取页面内容失败，请稍后重试。');
  }

  if (!html || html.trim().length === 0) {
    throw new Error('页面返回内容为空，请检查链接是否有效。');
  }

  // 6. 使用 Readability 提取正文
  let title: string;
  let plainText: string;

  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    title = article?.title?.trim() || dom.window.document.title || urlObj.hostname;
    plainText = (article?.textContent || dom.window.document.body?.textContent || '').replace(/\s+/g, ' ').trim();
  } catch (parseError) {
    throw new Error(
      `页面解析失败：${parseError instanceof Error ? parseError.message : '无法提取文章内容'}，建议复制文章内容粘贴到「文本」模式生成。`
    );
  }

  if (!plainText) {
    throw new Error('无法从该页面提取到可读文本内容，可能该页面需要登录或是动态加载，建议复制文章内容粘贴到「文本」模式生成。');
  }

  // 7. 组装 NormalizedDocument
  const markdown = htmlToMarkdownFallback(title, plainText);
  const sourceRef = createSourceRefFallback({
    type: 'url',
    url,
    location: 'body',
    text: plainText.slice(0, 240),
  });

  return {
    markdown,
    chunks: chunkMarkdown(markdown, sourceRef),
    sourceMeta: {
      type: 'url',
      title,
      sourceUrl: url,
    },
  };
}

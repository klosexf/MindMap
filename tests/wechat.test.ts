import { afterEach, describe, expect, it, vi } from 'vitest';

// ========== WeChat Client 测试 ==========

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  delete process.env.WECHAT_EXPORTER_BASE_URL;
  delete process.env.WECHAT_EXPORTER_AUTH_KEY;
});

describe('isWeChatArticleUrl', () => {
  it('returns true for valid WeChat article URLs', async () => {
    const { isWeChatArticleUrl } = await import('@/lib/wechat/client');
    expect(isWeChatArticleUrl('https://mp.weixin.qq.com/s?__biz=MzA3MDAw&mid=123&idx=1&sn=abc')).toBe(true);
    expect(isWeChatArticleUrl('http://mp.weixin.qq.com/s?some=params')).toBe(true);
  });

  it('returns false for non-WeChat URLs', async () => {
    const { isWeChatArticleUrl } = await import('@/lib/wechat/client');
    expect(isWeChatArticleUrl('https://example.com/article')).toBe(false);
    expect(isWeChatArticleUrl('https://zhihu.com/question/123')).toBe(false);
    expect(isWeChatArticleUrl('invalid-url')).toBe(false);
    expect(isWeChatArticleUrl('')).toBe(false);
  });

  it('returns false for WeChat domain but non-article path', async () => {
    const { isWeChatArticleUrl } = await import('@/lib/wechat/client');
    expect(isWeChatArticleUrl('https://mp.weixin.qq.com/cgi-bin/home')).toBe(false);
  });
});

describe('extractWeChatUrlParams', () => {
  it('extracts params from valid WeChat article URL', async () => {
    const { extractWeChatUrlParams } = await import('@/lib/wechat/client');
    const result = extractWeChatUrlParams(
      'https://mp.weixin.qq.com/s?__biz=MzA3MDAw&mid=123456&idx=1&sn=abcdef123'
    );
    expect(result).toEqual({
      biz: 'MzA3MDAw',
      mid: '123456',
      idx: '1',
      sn: 'abcdef123',
    });
  });

  it('returns null for URL missing required params', async () => {
    const { extractWeChatUrlParams } = await import('@/lib/wechat/client');
    expect(extractWeChatUrlParams('https://mp.weixin.qq.com/s?__biz=MzA3MDAw')).toBeNull();
    expect(extractWeChatUrlParams('https://example.com')).toBeNull();
  });
});

describe('searchAccount', () => {
  it('returns account list on successful response', async () => {
    const mockAccounts = [
      {
        fakeid: '123456',
        nickname: '测试公众号',
        alias: 'test_account',
        round_head_img: 'https://img.example.com/avatar.jpg',
        service_type: 1,
        signature: '测试签名',
        username: 'gh_test123',
      },
    ];

    // New API returns { base_resp: { ret: 0 }, list: [...] }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ base_resp: { ret: 0 }, list: mockAccounts }),
      text: async () => JSON.stringify({ base_resp: { ret: 0 }, list: mockAccounts }),
    });

    const { searchAccount } = await import('@/lib/wechat/client');
    const result = await searchAccount('测试');

    expect(result).toHaveLength(1);
    expect(result[0].nickname).toBe('测试公众号');
    expect(result[0].fakeid).toBe('123456');
  });

  it('throws error on invalid auth', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ base_resp: { ret: -1, err_msg: '认证信息无效' } }),
      text: async () => JSON.stringify({ base_resp: { ret: -1, err_msg: '认证信息无效' } }),
    });

    const { searchAccount } = await import('@/lib/wechat/client');
    await expect(searchAccount('测试')).rejects.toThrow('认证');
  });

  it('throws error on HTTP failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const { searchAccount } = await import('@/lib/wechat/client');
    await expect(searchAccount('测试')).rejects.toThrow('HTTP 500');
  });
});

describe('getArticleList', () => {
  it('returns articles on successful response', async () => {
    const mockArticles = [
      {
        aid: '1',
        title: '测试文章1',
        digest: '这是摘要',
        url: 'https://mp.weixin.qq.com/s?test=1',
        cover: '',
        author: '作者',
        create_time: 1700000000,
        update_time: 1700000000,
        is_original: 1,
        copyright_stat: 1,
        item_show_type: 0,
        itemidx: 1,
        appmsgid: 'msg1',
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ret: 0,
        base_resp: { ret: 0 },
        publish_page: {
          list: [
            {
              publish_info: {
                article_list: mockArticles,
                publish_time: 1700000000,
              },
              appmsgid: 'msg1',
            },
          ],
        },
        next_begin: 20,
      }),
      text: async () => JSON.stringify({
        ret: 0,
        base_resp: { ret: 0 },
        publish_page: {
          list: [
            {
              publish_info: {
                article_list: mockArticles,
                publish_time: 1700000000,
              },
              appmsgid: 'msg1',
            },
          ],
        },
        next_begin: 20,
      }),
    });

    const { getArticleList } = await import('@/lib/wechat/client');
    const result = await getArticleList('123456');

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0].title).toBe('测试文章1');
    expect(result.nextBegin).toBe(20);
  });
});

describe('checkServiceAvailability', () => {
  it('returns available when auth-key is valid', async () => {
    // New API /api/public/v1/authkey returns { code: 0, msg: '...' }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, msg: 'ok' }),
      text: async () => JSON.stringify({ code: 0, msg: 'ok' }),
    });

    const { checkServiceAvailability } = await import('@/lib/wechat/client');
    const result = await checkServiceAvailability();

    expect(result.available).toBe(true);
    expect(result.message).toContain('可用');
  });

  it('returns unavailable when auth-key expired', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ code: -1, msg: 'AuthKey not found' }),
      text: async () => JSON.stringify({ code: -1, msg: 'AuthKey not found' }),
    });

    const { checkServiceAvailability } = await import('@/lib/wechat/client');
    const result = await checkServiceAvailability();

    expect(result.available).toBe(false);
    expect(result.message).toContain('过期');
  });

  it('returns unavailable when service is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const { checkServiceAvailability } = await import('@/lib/wechat/client');
    const result = await checkServiceAvailability();

    expect(result.available).toBe(false);
    expect(result.message).toContain('无法连接');
  });
});

// ========== WeChat Parser 测试 ==========

describe('parseWeChatUrl', () => {
  it('throws error for non-WeChat URL', async () => {
    const { parseWeChatUrl } = await import('@/lib/parsers/wechat');
    await expect(parseWeChatUrl('https://example.com/article')).rejects.toThrow('不是有效的微信公众号文章链接');
  });

  it('parses WeChat article HTML via download API (preferred method)', async () => {
    const articleHtml = `
      <html>
        <head><title>测试微信文章</title></head>
        <body>
          <div id="rich_media_content">
            <article>
              <h1>测试微信文章标题</h1>
              <p>这是微信文章的正文内容，包含了一些重要信息。</p>
              <p>第二段内容，继续描述相关主题。</p>
            </article>
          </div>
        </body>
      </html>
    `;

    // Mock: download API succeeds (first strategy)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => articleHtml,
      json: async () => { throw new Error('not json'); },
      headers: new Map([['content-type', 'text/html']]),
    });

    const { parseWeChatUrl } = await import('@/lib/parsers/wechat');
    const doc = await parseWeChatUrl('https://mp.weixin.qq.com/s?__biz=MzA3&mid=123&idx=1&sn=abc');

    expect(doc.sourceMeta.type).toBe('wechat');
    expect(doc.sourceMeta.title).toContain('测试微信文章');
    expect(doc.markdown).toContain('测试微信文章');
    expect(doc.chunks.length).toBeGreaterThan(0);
    expect(doc.sourceMeta.sourceUrl).toBe('https://mp.weixin.qq.com/s?__biz=MzA3&mid=123&idx=1&sn=abc');
  });

  it('falls back to direct fetch when download API fails', async () => {
    const articleHtml = `
      <html>
        <head><title>直接获取文章</title></head>
        <body>
          <div id="rich_media_content">
            <article>
              <h1>通过直接访问获取的微信文章</h1>
              <p>文章正文内容。</p>
            </article>
          </div>
        </body>
      </html>
    `;

    // Mock: download API fails (Cloudflare challenge)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '<html><body><script>challenge-platform</script></body></html>',
      json: async () => { throw new Error('not json'); },
    });

    // Mock: direct fetch succeeds (first strategy within directFetchWeChatHtml)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => articleHtml,
      json: async () => { throw new Error('not json'); },
      headers: new Map([['content-type', 'text/html']]),
    });

    const { parseWeChatUrl } = await import('@/lib/parsers/wechat');
    const doc = await parseWeChatUrl('https://mp.weixin.qq.com/s?__biz=MzA3&mid=123&idx=1&sn=abc');

    expect(doc.sourceMeta.type).toBe('wechat');
    expect(doc.sourceMeta.title).toContain('直接获取');
  });

  it('throws informative error when all methods fail', async () => {
    // Mock: download API fails (Cloudflare challenge)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '<html><body><script>challenge-platform</script></body></html>',
      json: async () => { throw new Error('not json'); },
    });

    // Mock: direct fetch fails with all 3 strategies
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => '',
        json: async () => { throw new Error('not json'); },
      });
    }

    const { parseWeChatUrl } = await import('@/lib/parsers/wechat');
    await expect(
      parseWeChatUrl('https://mp.weixin.qq.com/s?__biz=MzA3&mid=123&idx=1&sn=abc')
    ).rejects.toThrow('无法获取微信文章内容');
  });

  it('detects WeChat verification page as failure', async () => {
    // Mock: download API fails (Cloudflare challenge)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '<html><body><script>challenge-platform</script></body></html>',
      json: async () => { throw new Error('not json'); },
    });

    // Mock: returns 200 but content is a verification page (for all 3 direct strategies)
    const verifyHtml = '<html><body>环境异常，请验证后访问</body></html>';
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => verifyHtml,
        json: async () => { throw new Error('not json'); },
        headers: new Map([['content-type', 'text/html']]),
      });
    }

    const { parseWeChatUrl } = await import('@/lib/parsers/wechat');
    await expect(
      parseWeChatUrl('https://mp.weixin.qq.com/s?__biz=MzA3&mid=123&idx=1&sn=abc')
    ).rejects.toThrow();
  });

  it('detects Cloudflare challenge from download API as failure', async () => {
    // Mock: download API returns Cloudflare challenge
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '<html><script>var __CF$cv$params={};challenge-platform</script></html>',
      json: async () => { throw new Error('not json'); },
    });

    // Mock: direct fetch also fails with all 3 strategies
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => '',
        json: async () => { throw new Error('not json'); },
      });
    }

    const { parseWeChatUrl } = await import('@/lib/parsers/wechat');
    await expect(
      parseWeChatUrl('https://mp.weixin.qq.com/s?__biz=MzA3&mid=123&idx=1&sn=abc')
    ).rejects.toThrow('无法获取微信文章内容');
  });
});

describe('parseWeChatArticleList', () => {
  it('converts article list to NormalizedDocument', async () => {
    const { parseWeChatArticleList } = await import('@/lib/parsers/wechat');

    const articles = [
      {
        aid: '1',
        title: '文章一',
        digest: '文章一摘要',
        url: 'https://mp.weixin.qq.com/s?test=1',
        cover: '',
        author: '作者A',
        create_time: 1700000000,
        update_time: 1700000000,
        is_original: 1,
        copyright_stat: 1,
        item_show_type: 0,
        itemidx: 1,
        appmsgid: 'msg1',
      },
      {
        aid: '2',
        title: '文章二',
        digest: '文章二摘要',
        url: 'https://mp.weixin.qq.com/s?test=2',
        cover: '',
        author: '作者B',
        create_time: 1700100000,
        update_time: 1700100000,
        is_original: 0,
        copyright_stat: 0,
        item_show_type: 0,
        itemidx: 1,
        appmsgid: 'msg2',
      },
    ];

    const doc = parseWeChatArticleList(articles, '测试公众号');

    expect(doc.sourceMeta.type).toBe('wechat');
    expect(doc.sourceMeta.title).toBe('测试公众号 文章列表');
    expect(doc.markdown).toContain('文章一');
    expect(doc.markdown).toContain('文章二');
    expect(doc.markdown).toContain('[原创] 文章一');
    expect(doc.markdown).not.toContain('[原创] 文章二');
    expect(doc.markdown).toContain('作者：作者A');
    expect(doc.markdown).toContain('摘要：文章一摘要');
    expect(doc.chunks.length).toBeGreaterThan(0);
  });

  it('handles empty article list', async () => {
    const { parseWeChatArticleList } = await import('@/lib/parsers/wechat');
    const doc = parseWeChatArticleList([], '空公众号');

    expect(doc.sourceMeta.title).toBe('空公众号 文章列表');
    expect(doc.markdown).toContain('空公众号');
    expect(doc.chunks.length).toBeGreaterThan(0);
  });
});

// ========== ParseInput 集成测试 ==========

describe('parseInput with wechat type', () => {
  it('routes wechat type to parseWeChatUrl', async () => {
    const articleHtml = `
      <html>
        <head><title>集成测试文章</title></head>
        <body>
          <div id="rich_media_content">
            <article>
              <h1>集成测试标题</h1>
              <p>集成测试正文内容。</p>
            </article>
          </div>
        </body>
      </html>
    `;

    // Mock: download API succeeds (parseWeChatUrl now tries download API first)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => articleHtml,
      json: async () => { throw new Error('not json'); },
      headers: new Map([['content-type', 'text/html']]),
    });

    const { parseInput } = await import('@/lib/parsers');
    const doc = await parseInput({
      type: 'wechat',
      content: 'https://mp.weixin.qq.com/s?__biz=MzA3&mid=456&idx=1&sn=def',
    });

    expect(doc.sourceMeta.type).toBe('wechat');
    expect(doc.markdown).toContain('集成测试');
  });
});

// ========== URL 模式自动路由微信链接测试 ==========

describe('parseUrlInput auto-routing for WeChat URLs', () => {
  it('auto-routes WeChat article URL to parseWeChatUrl (via parseUrlInput)', async () => {
    const articleHtml = `
      <html>
        <head><title>自动路由测试</title></head>
        <body>
          <div id="rich_media_content">
            <article>
              <h1>自动路由标题</h1>
              <p>通过 URL 模式输入微信链接应自动路由到 wechat 解析器。</p>
            </article>
          </div>
        </body>
      </html>
    `;

    // Mock: download API succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => articleHtml,
      json: async () => { throw new Error('not json'); },
      headers: new Map([['content-type', 'text/html']]),
    });

    const { parseUrlInput } = await import('@/lib/parsers/url');
    const doc = await parseUrlInput('https://mp.weixin.qq.com/s?__biz=MzA3&mid=789&idx=1&sn=auto');

    expect(doc.sourceMeta.type).toBe('wechat');
    expect(doc.markdown).toContain('自动路由');
  });

  it('auto-routes WeChat URL when using parseInput with type=url', async () => {
    const articleHtml = `
      <html>
        <head><title>ParseInput 自动路由</title></head>
        <body>
          <div id="rich_media_content">
            <article>
              <h1>路由验证</h1>
              <p>type=url 但内容是微信链接时应自动切换到 wechat 解析。</p>
            </article>
          </div>
        </body>
      </html>
    `;

    // Mock: download API succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => articleHtml,
      json: async () => { throw new Error('not json'); },
      headers: new Map([['content-type', 'text/html']]),
    });

    const { parseInput } = await import('@/lib/parsers');
    const doc = await parseInput({
      type: 'url',
      content: 'https://mp.weixin.qq.com/s?__biz=MzA3&mid=999&idx=1&sn=routing',
    });

    expect(doc.sourceMeta.type).toBe('wechat');
    expect(doc.sourceMeta.title).toContain('ParseInput 自动路由');
  });

  it('does NOT route non-WeChat URLs to wechat parser', async () => {
    // 普通 URL 应该走正常的 url 解析路径
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html']]),
      text: async () =>
        '<html><head><title>普通网页</title></head><body><article><h1>普通内容</h1><p>这是普通网页。</p></article></body></html>',
    });

    const { parseUrlInput } = await import('@/lib/parsers/url');
    const doc = await parseUrlInput('https://example.com/article');

    expect(doc.sourceMeta.type).toBe('url'); // 不是 wechat
    expect(doc.markdown).toContain('普通内容');
  });
});

// ========== MindMap Schema 兼容性测试 ==========

describe('mindmap schema with wechat source type', () => {
  it('accepts wechat source type in tree meta', async () => {
    const { mindMapTreeSchema } = await import('@/lib/types/mindmap');
    const now = Date.now();

    const tree = {
      id: 'test_wechat_tree',
      root: {
        id: 'root',
        content: '微信公众号文章',
        children: [],
        meta: {
          sourceRef: { type: 'wechat', url: 'https://mp.weixin.qq.com/s?test=1', text: '测试' },
          createdAt: now,
          createdBy: 'ai' as const,
          type: 'main' as const,
        },
      },
      meta: {
        title: '微信文章导图',
        sourceType: 'wechat',
        sourceUrl: 'https://mp.weixin.qq.com/s?test=1',
        createdAt: now,
        updatedAt: now,
        version: 1,
        truncated: false,
      },
    };

    const result = mindMapTreeSchema.safeParse(tree);
    expect(result.success).toBe(true);
  });
});

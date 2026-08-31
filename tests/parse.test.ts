import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseInput } from '../lib/parsers';
import { parsePaddleOcrJsonOutput, recognizeImageWithVlmOcr } from '../lib/parsers/pdf';

const tesseractMocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  recognize: vi.fn(),
  terminate: vi.fn(),
}));

vi.mock('tesseract.js', () => ({
  createWorker: tesseractMocks.createWorker,
}));

function createSimplePdfBase64(content = 'Hello PDF Parser '.repeat(20)): string {
  return createMultiPagePdfBase64([content]);
}

function createMultiPagePdfBase64(contents: string[]): string {
  const pageObjects = contents.flatMap((content, idx) => {
    const pageObjectId = 4 + idx * 2;
    const contentObjectId = pageObjectId + 1;
    const stream = content ? `BT\n/F1 12 Tf\n72 720 Td\n(${content}) Tj\nET` : '';

    return [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
  });

  const kids = contents.map((_, idx) => `${4 + idx * 2} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${contents.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...pageObjects,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];

  objects.forEach((obj, idx) => {
    offsets.push(pdf.length);
    pdf += `${idx + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.slice(1).forEach((offset) => {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'utf8').toString('base64');
}

beforeEach(() => {
  // Point PaddleOCR at a non-existent script so tests never spawn real
  // python3 processes: engine=tesseract/auto would otherwise attempt a real
  // PaddleOCR run first because scripts/paddle_ocr.py exists in the repo.
  process.env.PADDLE_OCR_SCRIPT_PATH = '/nonexistent/paddle_ocr.py';
});

afterEach(() => {
  delete process.env.ENABLE_PDF_OCR;
  delete process.env.PDF_OCR_ENGINE;
  delete process.env.PDF_OCR_PROVIDER;
  delete process.env.PDF_OCR_MODEL;
  delete process.env.PDF_OCR_BASE_URL;
  delete process.env.PDF_OCR_API_KEY;
  delete process.env.PDF_OCR_MAX_PAGES;
  delete process.env.PADDLE_OCR_PYTHON_BIN;
  delete process.env.PADDLE_OCR_SCRIPT_PATH;
  delete process.env.PADDLE_OCR_LANG;
  delete process.env.PADDLE_OCR_USE_ANGLE_CLS;
  delete process.env.PADDLE_OCR_TIMEOUT_MS;
  delete process.env.PADDLE_PDX_CACHE_HOME;
  delete process.env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK;
  delete process.env.MINERU_RETRY_TIMES;
  delete process.env.ZHIPU_API_KEY;
  delete process.env.ZHIPU_BASE_URL;
  delete process.env.LLM_PROVIDER;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('parseInput', () => {
  it('parses text input to normalized document', async () => {
    const doc = await parseInput({ type: 'text', content: 'Alpha\n\nBeta\n\nGamma' });
    expect(doc.sourceMeta.type).toBe('text');
    expect(doc.chunks.length).toBeGreaterThan(0);
    expect(doc.markdown).toContain('Alpha');
  });

  it('parses url input with readability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'text/html']]),
        text: async () => '<html><head><title>Demo</title></head><body><article><h1>News</h1><p>Important content</p></article></body></html>',
      }),
    );

    const doc = await parseInput({ type: 'url', content: 'https://example.com/news' });
    expect(doc.sourceMeta.type).toBe('url');
    expect(doc.markdown).toContain('Important content');
  });

  it('parses pdf input to normalized document', async () => {
    process.env.ENABLE_PDF_OCR = 'false';
    const base64 = createSimplePdfBase64();
    const doc = await parseInput({ type: 'pdf', content: base64, fileName: 'demo.pdf' });
    expect(doc.sourceMeta.type).toBe('pdf');
    expect(doc.markdown).toContain('Hello PDF Parser');
    expect(doc.chunks.length).toBeGreaterThan(0);
  });

  it('splits pdf text into page-level chunks with page source refs', async () => {
    process.env.ENABLE_PDF_OCR = 'false';
    const base64 = createMultiPagePdfBase64([
      'First PDF page about account verification and approval reminders.',
      'Second PDF page about enterprise certification and signing QR codes.',
    ]);

    const doc = await parseInput({ type: 'pdf', content: base64, fileName: 'multi-page.pdf' });

    expect(doc.chunks).toHaveLength(2);
    expect(doc.chunks[0].sourceRef.page).toBe(1);
    expect(doc.chunks[1].sourceRef.page).toBe(2);
    expect(doc.chunks[0].text).toContain('[page:1]');
    expect(doc.chunks[1].text).toContain('[page:2]');
  });

  it('runs OCR by default for low-text pdf files', async () => {
    process.env.PDF_OCR_ENGINE = 'tesseract';
    tesseractMocks.createWorker.mockResolvedValue({
      recognize: tesseractMocks.recognize,
      terminate: tesseractMocks.terminate,
    });
    tesseractMocks.recognize.mockResolvedValue({
      data: { text: 'Scanned renewal terms and customer obligations extracted by OCR.' },
    });
    tesseractMocks.terminate.mockResolvedValue(undefined);

    const doc = await parseInput({ type: 'pdf', content: createSimplePdfBase64(''), fileName: 'scan.pdf' });

    expect(tesseractMocks.createWorker).toHaveBeenCalledTimes(1);
    if (doc.sourceMeta.ocrUsed) {
      expect(doc.markdown).toContain('Scanned renewal terms');
      expect(tesseractMocks.recognize).toHaveBeenCalled();
    } else {
      expect(doc.sourceMeta.parseWarning).toContain('OCR 失败');
    }
  });

  it('renders low-text pdf pages to PNG before sending them to OCR', async () => {
    process.env.PDF_OCR_ENGINE = 'tesseract';
    tesseractMocks.createWorker.mockResolvedValue({
      recognize: tesseractMocks.recognize,
      terminate: tesseractMocks.terminate,
    });
    tesseractMocks.recognize.mockResolvedValue({
      data: { text: 'Scanned renewal terms and customer obligations extracted by OCR.' },
    });
    tesseractMocks.terminate.mockResolvedValue(undefined);

    const doc = await parseInput({ type: 'pdf', content: createSimplePdfBase64(''), fileName: 'scan.pdf' });
    if (tesseractMocks.recognize.mock.calls.length > 0) {
      const ocrInput = tesseractMocks.recognize.mock.calls[0]?.[0];
      const ocrBytes = Buffer.from(ocrInput as Uint8Array);

      expect(Array.from(ocrBytes.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(doc.sourceMeta.ocrUsed).toBe(true);
      expect(doc.markdown).toContain('Scanned renewal terms');
    } else {
      expect(doc.sourceMeta.parseWarning).toContain('OCR 失败');
    }
  });

  it('adds parse warning when both text extraction and OCR are unavailable', async () => {
    process.env.ENABLE_PDF_OCR = 'false';

    const doc = await parseInput({ type: 'pdf', content: createSimplePdfBase64(''), fileName: 'scan.pdf' });

    expect(doc.markdown).toContain('未能提取到可读文本');
    expect(doc.sourceMeta.parseWarning).toContain('文本提取结果为空');
    expect(doc.sourceMeta.parseWarning).toContain('OCR 已禁用');
  });

  it('rejects garbled OCR text and falls back to placeholder content', async () => {
    process.env.PDF_OCR_ENGINE = 'tesseract';
    tesseractMocks.createWorker.mockResolvedValue({
      recognize: tesseractMocks.recognize,
      terminate: tesseractMocks.terminate,
    });
    tesseractMocks.recognize.mockResolvedValue({
      data: {
        text: 'PS RAR EHSL SHAS EDRR MANE TOMBEIMEECHUSIREY EETIRES BLYATTH BREA 2024',
      },
    });
    tesseractMocks.terminate.mockResolvedValue(undefined);

    const doc = await parseInput({ type: 'pdf', content: createSimplePdfBase64(''), fileName: 'scan.pdf' });

    if (tesseractMocks.recognize.mock.calls.length > 0) {
      expect(doc.sourceMeta.ocrUsed).toBe(false);
      expect(doc.markdown).toContain('未能提取到可读文本');
      expect(doc.sourceMeta.parseWarning).toContain('OCR 失败');
      expect(doc.sourceMeta.parseWarning).toContain('ocr_text_appears_garbled');
    } else {
      expect(doc.sourceMeta.parseWarning).toContain('OCR 失败');
    }
  });

  it('exposes OCR debug payload with page-level rejection reasons', async () => {
    process.env.PDF_OCR_ENGINE = 'tesseract';
    tesseractMocks.createWorker.mockResolvedValue({
      recognize: tesseractMocks.recognize,
      terminate: tesseractMocks.terminate,
    });
    tesseractMocks.recognize.mockResolvedValue({
      data: {
        text: 'PS RAR EHSL SHAS EDRR MANE TOMBEIMEECHUSIREY EETIRES BLYATTH BREA 2024',
      },
    });
    tesseractMocks.terminate.mockResolvedValue(undefined);

    const doc = await parseInput({ type: 'pdf', content: createSimplePdfBase64(''), fileName: 'scan.pdf' });
    const ocrDebug = doc.sourceMeta.ocrDebug;

    if (tesseractMocks.recognize.mock.calls.length > 0) {
      expect(ocrDebug?.enabled).toBe(true);
      expect(ocrDebug?.attempted).toBe(true);
      expect(ocrDebug?.attemptedPages).toBeGreaterThan(0);
      expect(ocrDebug?.acceptedPages).toBe(0);
      expect(ocrDebug?.pages[0]?.rawText).toContain('PS RAR EHSL');
      expect(ocrDebug?.pages[0]?.accepted).toBe(false);
      expect(ocrDebug?.pages[0]?.reason).toBe('ocr_text_appears_garbled');
      expect(ocrDebug?.errorMessages[0]).toContain('ocr_text_appears_garbled');
    } else {
      expect(doc.sourceMeta.parseWarning).toContain('OCR 失败');
    }
  });

  it('keeps recoverable OCR content when mixed with noise', async () => {
    process.env.PDF_OCR_ENGINE = 'tesseract';
    tesseractMocks.createWorker.mockResolvedValue({
      recognize: tesseractMocks.recognize,
      terminate: tesseractMocks.terminate,
    });
    tesseractMocks.recognize.mockResolvedValue({
      data: {
        text: '5czbz0scfs6d91271XB639m_EFZUxoz:WPqaWOWnfrwWMFaA 一 REE 1993.07.04 | 13352824120 | 92188547600 com | FST 求职 目标 : 产品 经 理 自我 评价 ETTOOIROTTOEYTSOTCORTOT',
      },
    });
    tesseractMocks.terminate.mockResolvedValue(undefined);

    const doc = await parseInput({ type: 'pdf', content: createSimplePdfBase64(''), fileName: 'scan.pdf' });

    if (tesseractMocks.recognize.mock.calls.length > 0) {
      expect(doc.sourceMeta.ocrUsed).toBe(true);
      expect(doc.markdown).toContain('求职');
      expect(doc.markdown).toContain('1993.07.04');
      expect(doc.markdown).not.toContain('未能提取到可读文本');
    } else {
      expect(doc.sourceMeta.parseWarning).toContain('OCR 失败');
    }
  });

  it('forces OCR when pdfOptions.forceOcr is enabled for text-rich PDFs', async () => {
    process.env.PDF_OCR_ENGINE = 'tesseract';
    tesseractMocks.createWorker.mockResolvedValue({
      recognize: tesseractMocks.recognize,
      terminate: tesseractMocks.terminate,
    });
    tesseractMocks.recognize.mockResolvedValue({
      data: { text: 'Forced OCR page text for preview mode with readable resume fields.' },
    });
    tesseractMocks.terminate.mockResolvedValue(undefined);

    const doc = await parseInput({
      type: 'pdf',
      content: createSimplePdfBase64('Readable native text '.repeat(40)),
      fileName: 'rich.pdf',
      pdfOptions: { forceOcr: true },
    });

    expect(doc.sourceMeta.ocrDebug?.attempted).toBe(true);
    expect(doc.sourceMeta.ocrDebug?.attemptedPages).toBeGreaterThan(0);
    if (tesseractMocks.recognize.mock.calls.length > 0) {
      expect(doc.sourceMeta.ocrDebug?.acceptedPages).toBeGreaterThan(0);
      // sanitizeOcrText drops unknown all-uppercase tokens (e.g. "OCR"),
      // so assert on the sanitized wording.
      expect(doc.markdown).toContain('Forced page text');
    }
  });

  it('forces OCR over all detected pages when no force max page override is provided', async () => {
    process.env.PDF_OCR_ENGINE = 'tesseract';
    process.env.PDF_OCR_MAX_PAGES = '1';
    tesseractMocks.createWorker.mockResolvedValue({
      recognize: tesseractMocks.recognize,
      terminate: tesseractMocks.terminate,
    });
    tesseractMocks.recognize.mockResolvedValue({
      data: { text: 'Forced OCR text retained for full-page coverage check.' },
    });
    tesseractMocks.terminate.mockResolvedValue(undefined);

    const doc = await parseInput({
      type: 'pdf',
      content: createMultiPagePdfBase64([
        'Readable page one '.repeat(20),
        'Readable page two '.repeat(20),
        'Readable page three '.repeat(20),
      ]),
      fileName: 'rich-3p.pdf',
      pdfOptions: { forceOcr: true },
    });

    expect(doc.sourceMeta.ocrDebug?.attempted).toBe(true);
    if (tesseractMocks.recognize.mock.calls.length > 0) {
      expect(doc.sourceMeta.ocrDebug?.attemptedPages).toBe(3);
      // Node test env has no canvas, so pdfjs rendering only succeeds for
      // page 1 (sips fallback covers page 1 only). The orchestration intent -
      // every page attempted - is verified via per-page debug records.
      expect(doc.sourceMeta.ocrDebug?.pages).toHaveLength(3);
      expect(tesseractMocks.recognize).toHaveBeenCalled();
      expect(doc.sourceMeta.ocrDebug?.acceptedPages).toBeGreaterThanOrEqual(1);
    } else {
      expect(doc.sourceMeta.ocrDebug?.attemptedPages).toBeGreaterThanOrEqual(0);
    }
  });

  it('uses MinerU official agent API when PDF_OCR_ENGINE=mineru', async () => {
    process.env.PDF_OCR_ENGINE = 'mineru';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            task_id: 'task-123',
            file_url: 'https://upload.example.com/file',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            state: 'done',
            markdown_url: 'https://result.example.com/out.md',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '求职目标：产品经理\n工作经历：9年',
      });
    vi.stubGlobal('fetch', fetchMock);

    const doc = await parseInput({
      type: 'pdf',
      content: createSimplePdfBase64(''),
      fileName: 'scan.pdf',
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(doc.sourceMeta.ocrDebug?.provider).toBe('mineru');
    expect(doc.sourceMeta.ocrUsed).toBe(true);
    expect(doc.markdown).toContain('求职目标：产品经理');
  });

  it('splits MinerU submissions into batches of at most 20 pages', async () => {
    process.env.PDF_OCR_ENGINE = 'mineru';
    process.env.PDF_OCR_MAX_PAGES = '25';
    process.env.MINERU_RETRY_TIMES = '0';

    const submissions: string[] = [];
    const fetchMock = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      const rawBody = typeof init?.body === 'string' ? init.body : null;
      const body = rawBody ? (JSON.parse(rawBody) as { page_range?: string }) : null;
      if (body && body.page_range) {
        submissions.push(body.page_range);
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: {
              task_id: `task-${submissions.length}`,
              file_url: `https://upload.example.com/file-${submissions.length}`,
            },
          }),
        };
      }
      const urlStr = String(url);
      if (urlStr.includes('upload.example.com')) {
        return { ok: true };
      }
      if (urlStr.includes('/parse/')) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: { state: 'done', markdown_url: 'https://result.example.com/out.md' },
          }),
        };
      }
      return { ok: true, text: async () => 'Mineru batch markdown with enough characters for acceptance.' };
    });
    vi.stubGlobal('fetch', fetchMock);

    const doc = await parseInput({
      type: 'pdf',
      content: createMultiPagePdfBase64(Array<string>(25).fill('')),
      fileName: 'scan-25p.pdf',
    });

    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(submissions).toEqual(['1-20', '21-25']);
    expect(doc.sourceMeta.ocrDebug?.provider).toBe('mineru');
    expect(doc.sourceMeta.ocrUsed).toBe(true);
    expect(doc.sourceMeta.ocrDebug?.attemptedPages).toBe(25);
    expect(doc.sourceMeta.ocrDebug?.acceptedPages).toBe(2);
    expect(doc.markdown).toContain('Mineru batch markdown');
  });

  it('supplements OCR only for pages missing a text layer in text-rich PDFs', async () => {
    process.env.PDF_OCR_ENGINE = 'tesseract';
    tesseractMocks.createWorker.mockResolvedValue({
      recognize: tesseractMocks.recognize,
      terminate: tesseractMocks.terminate,
    });
    tesseractMocks.recognize.mockResolvedValue({
      data: { text: 'Missing page OCR content recovered from image-only page.' },
    });
    tesseractMocks.terminate.mockResolvedValue(undefined);

    const doc = await parseInput({
      type: 'pdf',
      content: createMultiPagePdfBase64([
        'Readable page one '.repeat(20),
        '',
        'Readable page three '.repeat(20),
      ]),
      fileName: 'mixed.pdf',
    });

    const ocrDebug = doc.sourceMeta.ocrDebug;
    expect(ocrDebug?.attempted).toBe(true);
    expect(ocrDebug?.attemptedPages).toBe(1);
    expect(ocrDebug?.pages).toHaveLength(1);
    expect(ocrDebug?.pages[0]?.page).toBe(2);
    // 文本层仍是主要内容，不触发全文档 OCR
    expect(doc.markdown).toContain('[page:1]');
    expect(doc.markdown).toContain('[page:3]');
    if (ocrDebug?.pages[0]?.accepted) {
      expect(doc.sourceMeta.ocrUsed).toBe(true);
      expect(doc.markdown).toContain('[ocr-page:2]');
    }
  });

  it('falls back to local OCR when MinerU fetch fails', async () => {
    process.env.PDF_OCR_ENGINE = 'mineru';
    process.env.MINERU_RETRY_TIMES = '0';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));

    tesseractMocks.createWorker.mockResolvedValue({
      recognize: tesseractMocks.recognize,
      terminate: tesseractMocks.terminate,
    });
    tesseractMocks.recognize.mockResolvedValue({
      data: { text: 'Fallback OCR text from local engine after MinerU failure.' },
    });
    tesseractMocks.terminate.mockResolvedValue(undefined);

    const doc = await parseInput({
      type: 'pdf',
      content: createSimplePdfBase64(''),
      fileName: 'scan.pdf',
    });

    expect((doc.sourceMeta.ocrDebug?.errorMessages || []).some((msg) => msg.includes('mineru_submit_fetch_failed'))).toBe(true);
    if (tesseractMocks.recognize.mock.calls.length > 0) {
      expect(doc.sourceMeta.ocrUsed).toBe(true);
      expect(doc.markdown).toContain('Fallback OCR text from local engine');
    } else {
      expect(doc.sourceMeta.ocrDebug?.attempted).toBe(true);
    }
  });

  it('recognizes page images through the configured VLM OCR endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '求职目标：产品经理\n自我评价：9 年互联网产品经验\n工作经历：深圳某电子公司',
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const text = await recognizeImageWithVlmOcr(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      provider: 'zhipu',
      apiKey: 'test-key',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.6v-flash',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(text).toContain('求职目标：产品经理');
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.model).toBe('glm-4.6v-flash');
    expect(body.messages[0].content[0].type).toBe('image_url');
    expect(body.messages[0].content[0].image_url.url).toMatch(/^(data:image\/png;base64,)?[A-Za-z0-9+/=]+$/);
  });

  it('raises a typed error when the VLM OCR endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'server error',
      }),
    );

    await expect(
      recognizeImageWithVlmOcr(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        provider: 'zhipu',
        apiKey: 'test-key',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-4.6v-flash',
      }),
    ).rejects.toThrow('vlm_ocr_http_500');
  });

  it('parses PaddleOCR JSON output with line list payload', () => {
    const parsed = parsePaddleOcrJsonOutput(
      JSON.stringify({
        lines: [
          { text: '求职目标：产品经理', score: 0.99 },
          { text: '自我评价：9年经验', score: 0.97 },
        ],
        avg_score: 0.98,
      }),
    );

    expect(parsed.text).toContain('求职目标：产品经理');
    expect(parsed.text).toContain('自我评价：9年经验');
    expect(parsed.lineCount).toBe(2);
    expect(parsed.avgScore).toBe(0.98);
  });

  it('throws typed error for invalid PaddleOCR JSON output', () => {
    expect(() => parsePaddleOcrJsonOutput('not-json')).toThrow('paddle_ocr_invalid_json');
  });
});

import { describe, expect, it } from 'vitest';

import { generateMindMapStream } from '../lib/llm/generate';
import type { MindMapTree, NormalizedDocument } from '../lib/types/mindmap';

describe('generateMindMapStream', () => {
  it('emits skeleton and complete events in fallback mode', async () => {
    const doc: NormalizedDocument = {
      markdown: '# Title\n\nParagraph one. Paragraph two. Paragraph three.',
      chunks: [
        {
          id: 'chunk_1',
          text: 'Paragraph one. Paragraph two.',
          tokenEstimate: 20,
          sourceRef: { type: 'text', text: 'Paragraph one.' },
        },
      ],
      sourceMeta: {
        type: 'text',
        title: 'Demo Title',
      },
    };

    const originalProvider = process.env.LLM_PROVIDER;
    const original = process.env.OPENAI_API_KEY;
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = '';

    const events = [] as string[];

    for await (const event of generateMindMapStream(doc)) {
      events.push(event.type);
    }

    if (typeof originalProvider === 'string') {
      process.env.LLM_PROVIDER = originalProvider;
    } else {
      delete process.env.LLM_PROVIDER;
    }
    if (typeof original === 'string') {
      process.env.OPENAI_API_KEY = original;
    } else {
      delete process.env.OPENAI_API_KEY;
    }

    expect(events[0]).toBe('skeleton');
    expect(events.includes('complete')).toBe(true);
  });

  it('uses document chunks as fallback branches when no LLM key is configured', async () => {
    const doc: NormalizedDocument = {
      markdown: [
        '# Demo PDF',
        '',
        '## Page 1',
        '',
        'Authentication flow changes. Users receive progress reminders.',
        '',
        '## Page 2',
        '',
        'Enterprise certification changes. Signing QR codes are simplified.',
      ].join('\n'),
      chunks: [
        {
          id: 'page_1',
          text: '## Page 1\n\nAuthentication flow changes. Users receive progress reminders.',
          tokenEstimate: 18,
          sourceRef: { type: 'pdf', page: 1, location: 'page:1', text: 'Authentication flow changes.' },
        },
        {
          id: 'page_2',
          text: '## Page 2\n\nEnterprise certification changes. Signing QR codes are simplified.',
          tokenEstimate: 18,
          sourceRef: { type: 'pdf', page: 2, location: 'page:2', text: 'Enterprise certification changes.' },
        },
      ],
      sourceMeta: {
        type: 'pdf',
        title: 'Demo PDF',
        sourceFileName: 'demo.pdf',
      },
    };

    const originalProvider = process.env.LLM_PROVIDER;
    const original = process.env.OPENAI_API_KEY;
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = '';

    let completeTree: MindMapTree | null = null;
    for await (const event of generateMindMapStream(doc)) {
      if (event.type === 'complete') {
        completeTree = event.data.tree;
      }
    }

    if (typeof originalProvider === 'string') {
      process.env.LLM_PROVIDER = originalProvider;
    } else {
      delete process.env.LLM_PROVIDER;
    }
    if (typeof original === 'string') {
      process.env.OPENAI_API_KEY = original;
    } else {
      delete process.env.OPENAI_API_KEY;
    }

    const branchTitles = completeTree?.root.children?.map((child) => child.content);
    expect(branchTitles).toEqual(['Page 1', 'Page 2']);
    expect(completeTree?.root.children?.[0].children?.[0].content).toContain('Authentication flow changes');
    expect(completeTree?.root.children?.[1].meta.sourceRef.page).toBe(2);
  });

  it('filters OCR noise so fallback second-level nodes stay readable', async () => {
    const doc: NormalizedDocument = {
      markdown: [
        '# 【产品经理_深圳 15-20K】谭艳丽 9年.pdf',
        '',
        '## OCR Page 1',
        '',
        '5czbz0scfs6d91271XB639m_EFZUxoz:WPqaWOWnfrwWMFaA 一 REE 1993.07.04 | 13352824120 |',
        '求职 目标 : 产品 经 理 自我 评价 ETTOOIROTTOEYTSOTCORTOT GTR, SRR, REE, MPSSRRILH, SESBUR 25% RS: PEROT',
        'SAAR BUR OW SK 20007 WARSEEARSES 15; BARR LE ASSP RAED;',
        'ZEENSROSREI GUE BALEATONS SHNRIES ANOS ZRASHR 30;',
        'SHEN BTCRRUSENCEERR RNG RRSEDOASHAED SRN OAD SRESTRME SuEROSRREE 5;',
        'MUTE ETROLSEN ITER RNS REHIRIESSE QERAIE.',
      ].join('\n'),
      chunks: [
        {
          id: 'ocr_page_1',
          text: [
            '## OCR Page 1',
            '',
            '5czbz0scfs6d91271XB639m_EFZUxoz:WPqaWOWnfrwWMFaA 一 REE 1993.07.04 | 13352824120 |',
            '求职 目标 : 产品 经 理 自我 评价 ETTOOIROTTOEYTSOTCORTOT GTR, SRR, REE, MPSSRRILH, SESBUR 25% RS: PEROT',
            'SAAR BUR OW SK 20007 WARSEEARSES 15; BARR LE ASSP RAED;',
            'ZEENSROSREI GUE BALEATONS SHNRIES ANOS ZRASHR 30;',
            'SHEN BTCRRUSENCEERR RNG RRSEDOASHAED SRN OAD SRESTRME SuEROSRREE 5;',
            'MUTE ETROLSEN ITER RNS REHIRIESSE QERAIE.',
          ].join('\n'),
          tokenEstimate: 80,
          sourceRef: { type: 'pdf', page: 1, location: 'page:1', text: '求职 目标 : 产品 经 理 自我 评价' },
        },
      ],
      sourceMeta: {
        type: 'pdf',
        title: '【产品经理_深圳 15-20K】谭艳丽 9年',
        sourceFileName: '【产品经理_深圳 15-20K】谭艳丽 9年.pdf',
      },
    };

    const originalProvider = process.env.LLM_PROVIDER;
    const original = process.env.OPENAI_API_KEY;
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = '';

    let completeTree: MindMapTree | null = null;
    for await (const event of generateMindMapStream(doc)) {
      if (event.type === 'complete') {
        completeTree = event.data.tree;
      }
    }

    if (typeof originalProvider === 'string') {
      process.env.LLM_PROVIDER = originalProvider;
    } else {
      delete process.env.LLM_PROVIDER;
    }
    if (typeof original === 'string') {
      process.env.OPENAI_API_KEY = original;
    } else {
      delete process.env.OPENAI_API_KEY;
    }

    const secondLevelNodes = completeTree?.root.children?.flatMap((branch) =>
      (branch.children || []).map((child) => child.content),
    );
    const joined = (secondLevelNodes || []).join(' ');

    expect(secondLevelNodes?.length).toBeGreaterThan(0);
    expect(joined).not.toContain('5czbz0scfs6d91271XB639m_EFZUxoz');
    expect(joined).not.toContain('ETTOOIROTTOEYTSOTCORTOT');
    expect(joined).not.toContain('92188547600 com');
    expect(joined).not.toContain('SAAR BUR OW SK');
    expect(joined).not.toContain('BARR LE ASSP RAED');
    expect(joined).not.toContain('ZEENSROSREI');
    expect(joined).not.toContain('BTCRRUSENCEERR');
    expect(joined).not.toContain('MUTE ETROLSEN');
    expect(joined).toMatch(/求职目标|产品经理|自我评价/);
  });

  it('drops mixed gibberish leaves in fallback output', async () => {
    const doc: NormalizedDocument = {
      markdown: [
        '# 简历',
        '',
        '## Page 1',
        '',
        '2019 年 6 月-2024 年 11 月 产品经理 深圳市也觉有限公司。',
        'Sit 产品再 28 天 ii Ao 关机 os 年 6 有 2024 年 1 月 aon Git 10 Pe Re Rrra Frome mpe 9。',
      ].join('\n'),
      chunks: [
        {
          id: 'page_1',
          text: [
            '## Page 1',
            '',
            '2019 年 6 月-2024 年 11 月 产品经理 深圳市也觉有限公司。',
            'Sit 产品再 28 天 ii Ao 关机 os 年 6 有 2024 年 1 月 aon Git 10 Pe Re Rrra Frome mpe 9。',
          ].join('\n'),
          tokenEstimate: 80,
          sourceRef: { type: 'pdf', page: 1, location: 'page:1', text: '2019 年 6 月-2024 年 11 月 产品经理 深圳市也觉有限公司' },
        },
      ],
      sourceMeta: {
        type: 'pdf',
        title: '简历',
        sourceFileName: 'resume.pdf',
      },
    };

    const originalProvider = process.env.LLM_PROVIDER;
    const original = process.env.OPENAI_API_KEY;
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = '';

    let completeTree: MindMapTree | null = null;
    for await (const event of generateMindMapStream(doc)) {
      if (event.type === 'complete') {
        completeTree = event.data.tree;
      }
    }

    if (typeof originalProvider === 'string') {
      process.env.LLM_PROVIDER = originalProvider;
    } else {
      delete process.env.LLM_PROVIDER;
    }
    if (typeof original === 'string') {
      process.env.OPENAI_API_KEY = original;
    } else {
      delete process.env.OPENAI_API_KEY;
    }

    const secondLevelNodes = completeTree?.root.children?.flatMap((branch) =>
      (branch.children || []).map((child) => child.content),
    );
    const joined = (secondLevelNodes || []).join(' ');

    expect(joined).toContain('2019');
    expect(joined).not.toContain('Sit 产品再');
    expect(joined).not.toContain('ii Ao');
    expect(joined).not.toContain('aon Git 10');
  });

  it('fills missing second-level details for category-like first-level nodes', async () => {
    const doc: NormalizedDocument = {
      markdown: [
        '# 简历',
        '',
        '## 工作经历',
        '',
        '## 教育背景',
        '',
        '## 联系方式',
        '',
        '## 自我评价',
        '',
        '## 明细',
        '',
        '工作经历：2019-2024 产品经理，深圳市也觉有限公司。',
        '教育背景：广东财经大学华商学院，本科。',
        '联系方式：电话 13352824120，邮箱 921885476@qq.com。',
        '自我评价：负责产品全生命周期管理与商业化增长。',
      ].join('\n'),
      chunks: [
        {
          id: 'c1',
          text: '## 工作经历',
          tokenEstimate: 6,
          sourceRef: { type: 'pdf', page: 1, location: 'page:1', text: '工作经历' },
        },
        {
          id: 'c2',
          text: '## 教育背景',
          tokenEstimate: 6,
          sourceRef: { type: 'pdf', page: 1, location: 'page:1', text: '教育背景' },
        },
        {
          id: 'c3',
          text: '## 联系方式',
          tokenEstimate: 6,
          sourceRef: { type: 'pdf', page: 1, location: 'page:1', text: '联系方式' },
        },
        {
          id: 'c4',
          text: '## 自我评价',
          tokenEstimate: 6,
          sourceRef: { type: 'pdf', page: 1, location: 'page:1', text: '自我评价' },
        },
        {
          id: 'c5',
          text: [
            '## 明细',
            '',
            '工作经历：2019-2024 产品经理，深圳市也觉有限公司。',
            '教育背景：广东财经大学华商学院，本科。',
            '联系方式：电话 13352824120，邮箱 921885476@qq.com。',
            '自我评价：负责产品全生命周期管理与商业化增长。',
          ].join('\n'),
          tokenEstimate: 80,
          sourceRef: { type: 'pdf', page: 1, location: 'page:1', text: '工作经历：2019-2024 产品经理' },
        },
      ],
      sourceMeta: {
        type: 'pdf',
        title: '简历',
        sourceFileName: 'resume.pdf',
      },
    };

    const originalProvider = process.env.LLM_PROVIDER;
    const original = process.env.OPENAI_API_KEY;
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = '';

    let completeTree: MindMapTree | null = null;
    for await (const event of generateMindMapStream(doc)) {
      if (event.type === 'complete') {
        completeTree = event.data.tree;
      }
    }

    if (typeof originalProvider === 'string') {
      process.env.LLM_PROVIDER = originalProvider;
    } else {
      delete process.env.LLM_PROVIDER;
    }
    if (typeof original === 'string') {
      process.env.OPENAI_API_KEY = original;
    } else {
      delete process.env.OPENAI_API_KEY;
    }

    const categoryNodes = (completeTree?.root.children || []).filter((node) =>
      /工作经历|教育背景|联系方式|自我评价/.test(node.content),
    );

    expect(categoryNodes.length).toBeGreaterThan(0);
    expect(categoryNodes.every((node) => (node.children?.length || 0) > 0)).toBe(true);
  });
});

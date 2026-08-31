import { describe, expect, it } from 'vitest';

import {
  buildStructurePromiseHintLines,
  cnToInt,
  detectStructurePromises,
} from '@/lib/llm/prompts/structure-promises';
import type { NormalizedDocument } from '@/lib/types/mindmap';

function docOf(markdown: string): NormalizedDocument {
  return {
    markdown,
    chunks: [{ id: 'c1', text: markdown, tokenEstimate: 10, sourceRef: { type: 'pdf', page: 1 } }],
    sourceMeta: { type: 'pdf', title: 't' },
  };
}

describe('cnToInt', () => {
  it('中文与阿拉伯数字', () => {
    expect(cnToInt('七')).toBe(7);
    expect(cnToInt('十')).toBe(10);
    expect(cnToInt('十二')).toBe(12);
    expect(cnToInt('二十')).toBe(20);
    expect(cnToInt('二十三')).toBe(23);
    expect(cnToInt('7')).toBe(7);
    expect(cnToInt('百')).toBeNull();
  });
});

describe('显式计数承诺', () => {
  it('「七项独特效率策略」检出 count=7（Tal badcase）', () => {
    const promises = detectStructurePromises(docOf('下面分享帮助自己的七项独特效率策略。展开内容……'));
    expect(promises.some((p) => p.kind === 'count' && p.count === 7)).toBe(true);
  });

  it('「以下十二条」检出 count=12（合同场景）', () => {
    const promises = detectStructurePromises(docOf('本合同条款如下，以下十二条约定双方权利义务。'));
    expect(promises.some((p) => p.kind === 'count' && p.count === 12)).toBe(true);
  });

  it('普通数量短语不误报（"三个问题之一" 无量词后名词结构时保守）', () => {
    // "项/大/类/条/章/篇/节/步" 后必须紧跟 1-10 个汉字才构成承诺
    const promises = detectStructurePromises(docOf('他提了一项建议。'));
    expect(promises.filter((p) => p.kind === 'count')).toHaveLength(0);
  });

  it('孤立数字不构成计数承诺', () => {
    const promises = detectStructurePromises(docOf('2023年6月到岗，负责3个渠道。'));
    expect(promises.filter((p) => p.kind === 'count')).toHaveLength(0);
  });
});

describe('显式编号序列承诺', () => {
  it('行首中文编号连续 ≥3 检出', () => {
    const md = '一、角色错配\n二、负荷上升\n三、时间侵占\n正文……';
    const promises = detectStructurePromises(docOf(md));
    expect(promises.some((p) => p.kind === 'numbered' && p.count >= 3)).toBe(true);
  });

  it('阿拉伯编号列表检出', () => {
    const md = '1. 第一步\n2. 第二步\n3. 第三步\n4. 第四步';
    const promises = detectStructurePromises(docOf(md));
    expect(promises.some((p) => p.kind === 'numbered' && p.count >= 4)).toBe(true);
  });

  it('零散编号（不连续）不误报', () => {
    const md = '第3条规定了违约责任。第7条另行约定。';
    const promises = detectStructurePromises(docOf(md));
    expect(promises.filter((p) => p.kind === 'numbered')).toHaveLength(0);
  });
});

describe('重复段落模式承诺', () => {
  it('「案例一/案例二/案例三」重复标题检出', () => {
    const md = '案例一：电商\n案例二：教育\n案例三：金融\n正文';
    const promises = detectStructurePromises(docOf(md));
    expect(promises.some((p) => p.kind === 'repeated' && p.count >= 3)).toBe(true);
  });
});

describe('buildStructurePromiseHintLines', () => {
  it('无承诺时不注入任何内容', () => {
    expect(buildStructurePromiseHintLines(docOf('一段普通的叙述文字，没有任何编号或计数。'))).toEqual([]);
  });

  it('检出承诺时注入「仅供参考」提示块', () => {
    const lines = buildStructurePromiseHintLines(docOf('下面分享七项独特效率策略。'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain('仅供参考');
    expect(lines.join('\n')).toContain('7');
  });
});

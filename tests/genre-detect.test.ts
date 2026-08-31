import { describe, expect, it } from 'vitest';

import { buildGenreHintLines, detectDocumentGenre } from '../lib/llm/prompts';
import type { NormalizedDocument } from '../lib/types/mindmap';

function makeDoc(markdown: string, title?: string): NormalizedDocument {
  return {
    markdown,
    chunks: [],
    sourceMeta: { type: 'text', title: title ?? 'Doc' },
  };
}

describe('文档文体检测（genre.ts）', () => {
  it('个人简历：经历/教育/技能关键词命中', () => {
    const doc = makeDoc('工作经历\n深圳某公司 产品经理\n教育背景\n某大学 本科\n专业技能：Figma、Axure');
    const hint = detectDocumentGenre(doc);
    expect(hint?.genre).toBe('个人简历');
    expect(hint?.paradigm).toContain('实体→属性→量化证据');
  });

  it('论文/研究报告：摘要+参考文献命中', () => {
    const doc = makeDoc('摘要：本文研究……\n关键词：增长\n参考文献\n[1] ……');
    expect(detectDocumentGenre(doc)?.genre).toBe('论文/研究报告');
  });

  it('会议纪要：议题类关键词命中', () => {
    const doc = makeDoc('会议主题：Q3 复盘\n会议时间：周一\n与会人员：全体\n待办事项：……');
    expect(detectDocumentGenre(doc)?.genre).toBe('会议纪要');
  });

  it('教程/操作指南：步骤类关键词命中', () => {
    const doc = makeDoc('使用指南\n操作步骤\n第一步：安装依赖\n注意事项：……');
    expect(detectDocumentGenre(doc)?.genre).toBe('教程/操作指南');
  });

  it('合同/协议：甲乙方关键词命中', () => {
    const doc = makeDoc('甲方：A 公司\n乙方：B 公司\n违约责任：……');
    expect(detectDocumentGenre(doc)?.genre).toBe('合同/协议');
  });

  it('招聘信息优先于个人简历（特异性在前）', () => {
    const doc = makeDoc('岗位职责：负责增长\n任职要求：3 年经验');
    expect(detectDocumentGenre(doc)?.genre).toBe('招聘信息');
  });

  it('无文体特征时返回 null，不注入任何提示', () => {
    const doc = makeDoc('The quick brown fox jumps over the lazy dog.');
    expect(detectDocumentGenre(doc)).toBeNull();
    expect(buildGenreHintLines(doc)).toEqual([]);
  });

  it('单关键词命中不触发（保守阈值，防误检）', () => {
    const doc = makeDoc('本文介绍产品经理的一天，仅提及工作经历这个词。');
    const hits = ['工作经历', '教育背景', '教育经历', '专业技能', '项目经验', '求职意向', '个人总结', '任职'].filter((kw) =>
      `${doc.sourceMeta.title}\n${doc.markdown}`.includes(kw),
    );
    expect(hits.length).toBeLessThan(2);
    expect(detectDocumentGenre(doc)).toBeNull();
  });

  it('检测取样范围：4000 字符外的关键词不参与判定', () => {
    const head = 'x'.repeat(4000);
    const doc = makeDoc(`${head}\n工作经历\n教育背景`);
    expect(detectDocumentGenre(doc)).toBeNull();
  });

  it('提示行包含“仅供参考”声明，避免代码侧误检硬约束模型', () => {
    const doc = makeDoc('工作经历：……\n教育背景：……');
    const lines = buildGenreHintLines(doc);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).toContain('仅供参考');
    expect(lines.join('\n')).toContain('个人简历');
  });
});

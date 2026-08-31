/**
 * 文档文体检测（纯函数，代码侧实现）。
 *
 * 分层约定：
 * - System 层（system.ts §8）只定义「先判文体、再选范式」的通用选择逻辑，跨请求稳定
 * - 本模块在代码侧做廉价文体检测，命中时向 User 层注入一行体裁提示（任务差异走 User 层）
 * - 检测基于关键词计数，保守阈值；未命中时不注入任何内容，模型按 System 通用逻辑自行判断
 */

import type { NormalizedDocument } from '@/lib/types/mindmap';

export interface DocumentGenreHint {
  genre: string;
  paradigm: string;
}

interface GenreRule {
  genre: string;
  paradigm: string;
  keywords: string[];
  /** 命中关键词的最小去重数量 */
  minHits: number;
}

/**
 * 规则顺序即优先级：特异性强的文体在前，通用商业文案在最后。
 * paradigm 措辞与 System §8 的范式保持同源，不引入新的结构定义。
 */
const GENRE_RULES: GenreRule[] = [
  {
    genre: '招聘信息',
    paradigm: '实体→属性→量化证据（职责/要求/待遇分组并列展开）',
    keywords: ['岗位职责', '任职要求', '职位描述', '薪资待遇', '招聘'],
    minHits: 2,
  },
  {
    genre: '个人简历',
    paradigm: '实体→属性→量化证据（经历段按「机构｜职位｜时间→产品/项目→举措分组→量化成果」展开，同类经历复用同一属性槽位）',
    keywords: ['工作经历', '教育背景', '教育经历', '专业技能', '项目经验', '求职意向', '个人总结', '任职'],
    minHits: 2,
  },
  {
    genre: '论文/研究报告',
    paradigm: '问题→方法→验证→结论',
    keywords: ['摘要', '参考文献', '关键词', '研究方法', '引言', '研究背景', '实验结果'],
    minHits: 2,
  },
  {
    genre: '会议纪要',
    paradigm: '议题→决议→行动项（行动项保留责任人与时限）',
    keywords: ['会议纪要', '与会人员', '会议决议', '待办事项', '会议主题', '会议时间', '议程'],
    minHits: 2,
  },
  {
    genre: '合同/协议',
    paradigm: '条款式结构（主体→权利义务→责任与违约处理）',
    keywords: ['甲方', '乙方', '违约责任', '本协议', '合同编号', '争议解决'],
    minHits: 2,
  },
  {
    genre: '教程/操作指南',
    paradigm: '目标→步骤→注意事项（步骤按原文时序排列）',
    keywords: ['操作步骤', '使用指南', '安装教程', '第一步', '注意事项', '常见问题', '操作说明'],
    minHits: 2,
  },
  {
    genre: '新闻资讯',
    paradigm: '时间线结构（事件→背景→各方回应→影响）',
    keywords: ['记者', '报道', '本报讯', '消息称', '新华社'],
    minHits: 2,
  },
  {
    genre: '商业报告/方案',
    paradigm: '背景→发现→建议',
    keywords: ['项目背景', '市场分析', '策略建议', '解决方案', '可行性', '竞品分析', '执行方案'],
    minHits: 2,
  },
];

/** 检测取样范围：标题 + 正文前 4000 字符 */
const SAMPLE_LIMIT = 4000;

export function detectDocumentGenre(doc: NormalizedDocument): DocumentGenreHint | null {
  const sample = `${doc.sourceMeta.title ?? ''}\n${doc.markdown}`.slice(0, SAMPLE_LIMIT);
  for (const rule of GENRE_RULES) {
    const hits = rule.keywords.filter((keyword) => sample.includes(keyword)).length;
    if (hits >= rule.minHits) {
      return { genre: rule.genre, paradigm: rule.paradigm };
    }
  }
  return null;
}

/**
 * 生成注入 User 层的体裁提示行（未检出文体时返回空数组，不注入任何内容）。
 * 提示词刻意声明“仅供参考”，避免代码侧误检硬性约束模型。
 */
export function buildGenreHintLines(doc: NormalizedDocument): string[] {
  const hint = detectDocumentGenre(doc);
  if (!hint) {
    return [];
  }
  return [
    '## 文档体裁提示（系统检测注入，仅供参考）',
    `本文档疑似「${hint.genre}」。建议结构范式：${hint.paradigm}。若与实际内容不符，以内容为准，并沿用系统指令中的结构范式选择原则。`,
  ];
}

import { describe, expect, it } from 'vitest';

import {
  ensureEnumerationRetention,
  extractEnumerations,
  repairCompositeOrdinalBranches,
  repairNumericUnits,
  repairNumericUnitsTree,
  splitCompositeOrdinalLabel,
} from '../lib/llm/postprocess';
import type { MindMapNode, MindMapTree, NormalizedDocument } from '../lib/types/mindmap';

const RESUME_MARKDOWN = [
  '深圳特鹏网络有限公司 用户运营 2023.03 - 2023.06 深圳',
  '转化路径优化：提升导航栏位置权重，UV提升40%；优化转化弹窗，订单转化率提升10%',
  '月营收同比上涨65%',
  '专业技能： Windsurf｜Gamma｜Figma｜Axure｜Xmind｜PS｜CET-6 兴趣爱好： 足球羽毛球（院主力）｜旅行｜户外运动｜冲浪练习生',
].join('\n');

function node(content: string, children: MindMapNode[] = []): MindMapNode {
  return {
    id: `n-${content.slice(0, 8)}`,
    content,
    children,
    collapsed: false,
  } as MindMapNode;
}

function tree(root: MindMapNode): MindMapTree {
  return { id: 't', root, meta: {} } as unknown as MindMapTree;
}

const testDoc: NormalizedDocument = {
  markdown: RESUME_MARKDOWN,
  chunks: [],
  sourceMeta: { type: 'text', title: '简历' },
};

const sourceRef = { type: 'text' } as never;

describe('数字单位守卫（repairNumericUnits）', () => {
  it('节点尾部「词+数字」且原文有「词+数字%」时补 %', () => {
    expect(repairNumericUnits('转化优化：UV提升40%，订单转化率提升10', RESUME_MARKDOWN)).toBe(
      '转化优化：UV提升40%，订单转化率提升10%',
    );
    expect(repairNumericUnits('成果：月营收同比上涨65', RESUME_MARKDOWN)).toBe('成果：月营收同比上涨65%');
  });

  it('原文词与数字间有间隔（词+动词+数字%）同样补 %（真实 badcase）', () => {
    // 节点「弹窗提升转化率10」↔ 原文「订单转化率提升10%」
    expect(repairNumericUnits('转化优化：导航权重提升UV 40%，弹窗提升转化率10', RESUME_MARKDOWN)).toBe(
      '转化优化：导航权重提升UV 40%，弹窗提升转化率10%',
    );
  });

  it('原文无 % 证据时不补（零误补原则）', () => {
    expect(repairNumericUnits('参与人数达1600', RESUME_MARKDOWN)).toBe('参与人数达1600');
    expect(repairNumericUnits('转化提升10', '转化提升10个点')).toBe('转化提升10');
  });

  it('词不在比率语境白名单时不补', () => {
    expect(repairNumericUnits('团队规模15', '团队规模15%')).toBe('团队规模15');
  });

  it('已有 % 的节点不受影响', () => {
    expect(repairNumericUnits('UV提升40%', RESUME_MARKDOWN)).toBe('UV提升40%');
  });

  it('整树修复：递归处理所有节点', () => {
    const t = tree(
      node('根', [
        node('转化优化：UV提升40%，订单转化率提升10'),
        node('业务增长', [node('月营收同比上涨65')]),
      ]),
    );
    const result = repairNumericUnitsTree(t, RESUME_MARKDOWN);
    expect(result.root.children![0].content).toBe('转化优化：UV提升40%，订单转化率提升10%');
    expect(result.root.children![1].children![0].content).toBe('月营收同比上涨65%');
  });
});

describe('枚举清单提取（extractEnumerations）', () => {
  it('提取「专业技能：A｜B｜C」清单（PDF 行内文本）', () => {
    const blocks = extractEnumerations(RESUME_MARKDOWN);
    const skills = blocks.find((b) => b.label === '专业技能');
    expect(skills).toBeDefined();
    expect(skills!.items).toEqual(['Windsurf', 'Gamma', 'Figma', 'Axure', 'Xmind', 'PS', 'CET-6']);
  });

  it('提取兴趣爱好清单（枚举段以下一标签结束）', () => {
    const blocks = extractEnumerations(RESUME_MARKDOWN);
    const hobbies = blocks.find((b) => b.label === '兴趣爱好');
    expect(hobbies).toBeDefined();
    expect(hobbies!.items[0]).toBe('足球羽毛球（院主力）');
    expect(hobbies!.items).toContain('旅行');
  });

  it('少于 3 项的并列不识别为清单', () => {
    expect(extractEnumerations('技能：Python、SQL')).toHaveLength(0);
  });

  it('单项超长的并列不识别（防止整段误判）', () => {
    const md = '技能：负责从0到1搭建用户增长体系并通过裂变实现增长、负责商业化';
    expect(extractEnumerations(md)).toHaveLength(0);
  });
});

describe('枚举回补（ensureEnumerationRetention）', () => {
  it('技能清单缺失时回补缺失项', () => {
    const t = tree(
      node('候选人画像', [
        node('工作经历：特鹏网络用户运营', [node('UV提升40%')]),
        node('教育背景：衡阳师范学院'),
      ]),
    );
    const result = ensureEnumerationRetention(t, testDoc, sourceRef);
    const allText = JSON.stringify(result);
    // 6 项技能全部回来了
    for (const skill of ['Windsurf', 'Gamma', 'Figma', 'Axure', 'Xmind', 'CET-6']) {
      expect(allText).toContain(skill);
    }
  });

  it('树中已完整保留时不追加节点', () => {
    const t = tree(
      node('根', [
        node('专业技能：Windsurf、Gamma、Figma、Axure、Xmind、PS、CET-6'),
        node('兴趣爱好：足球羽毛球（院主力）、旅行、户外运动、冲浪练习生'),
      ]),
    );
    const before = JSON.stringify(t);
    const result = ensureEnumerationRetention(t, testDoc, sourceRef);
    expect(JSON.stringify(result)).toBe(before);
  });

  it('部分缺失时只补缺失项（挂载到语义锚点下）', () => {
    const t = tree(node('根', [node('专业技能：Figma、Axure、PS')]));
    const result = ensureEnumerationRetention(t, testDoc, sourceRef);

    const found: MindMapNode[] = [];
    const walk = (n: MindMapNode): void => {
      if (n.content.startsWith('专业技能') && n.content.includes('Windsurf')) found.push(n);
      (n.children ?? []).forEach(walk);
    };
    walk(result.root);

    expect(found).toHaveLength(1);
    expect(found[0].content).toBe('专业技能：Windsurf、Gamma、Xmind、CET-6');
    expect(found[0].content).not.toContain('Figma');
  });
});

describe('复合标签识别（splitCompositeOrdinalLabel）', () => {
  it('识别「策略一：A / 策略二：B」并返回分段', () => {
    const segments = splitCompositeOrdinalLabel('策略一：当场解决会议行动项 / 策略二：不当场则用异步工具');
    expect(segments).toEqual(['策略一：当场解决会议行动项', '策略二：不当场则用异步工具']);
  });

  it('全角斜杠与无空格同样识别', () => {
    expect(splitCompositeOrdinalLabel('方法一：先记录／方法二：后处理')).toHaveLength(2);
  });

  it('前缀词不一致不识别（非同类实体）', () => {
    expect(splitCompositeOrdinalLabel('策略一：A问题 ／ 方法二：B方案')).toBeNull();
  });

  it('普通斜杠内容（工具名/缩写）不误判', () => {
    expect(splitCompositeOrdinalLabel('Figma/Axure 原型工具')).toBeNull();
    expect(splitCompositeOrdinalLabel('前端/后端分工')).toBeNull();
  });

  it('无分隔符的单节点不识别', () => {
    expect(splitCompositeOrdinalLabel('策略一：当场解决会议行动项')).toBeNull();
  });
});

describe('复合标签守卫（repairCompositeOrdinalBranches）', () => {
  it('真实 badcase：两两合并的复合父节点展平并聚合为单一「策略」主题分支', () => {
    const t = tree(
      node('如何公平对待产品经理', [
        node('不公平现状：职责与回报错配'),
        node('策略一：当场解决会议行动项 / 策略二：不当场则用异步工具'),
        node('策略三：公开决策依据 / 策略四：建立复盘机制'),
        node('策略五：明确职责边界 / 策略六：量化产出归属'),
        node('策略七：向上管理预期 / 策略八：横向对齐资源'),
        node('结论：公平是设计出来的'),
      ]),
    );
    const result = repairCompositeOrdinalBranches(t);
    const children = result.root.children!;

    // 非实体分支原样保留，实体全部收进一个主题父分支
    expect(children.map((c) => c.content)).toEqual([
      '不公平现状：职责与回报错配',
      '策略',
      '结论：公平是设计出来的',
    ]);
    const strategy = children[1];
    expect(strategy.children).toHaveLength(8);
    expect(strategy.children!.map((c) => c.content)).toEqual([
      '策略一：当场解决会议行动项',
      '策略二：不当场则用异步工具',
      '策略三：公开决策依据',
      '策略四：建立复盘机制',
      '策略五：明确职责边界',
      '策略六：量化产出归属',
      '策略七：向上管理预期',
      '策略八：横向对齐资源',
    ]);
  });

  it('成对复合节点（仅 1 个）展平后聚合为 1 个主题分支', () => {
    const t = tree(
      node('根', [
        node('背景'),
        node('策略一：先记录 ／ 策略二：后处理'),
        node('结论'),
      ]),
    );
    const result = repairCompositeOrdinalBranches(t);
    const contents = result.root.children!.map((c) => c.content);
    expect(contents).toEqual(['背景', '策略', '结论']);
    expect(result.root.children![1].children).toHaveLength(2);
  });

  it('复合节点原有子树归首个实体，不丢信息', () => {
    const t = tree(
      node('根', [
        node('策略一：当场解决 ／ 策略二：异步处理', [node('案例：周会行动项 48h 内闭环')]),
      ]),
    );
    const result = repairCompositeOrdinalBranches(t);
    const first = result.root.children![0].children![0];
    expect(first.content).toBe('策略一：当场解决');
    expect(first.children![0].content).toBe('案例：周会行动项 48h 内闭环');
    expect(result.root.children![0].children![1].children).toHaveLength(0);
  });

  it('已在同名主题父分支下不再套娃', () => {
    const t = tree(
      node('七大策略', [
        node('策略一：当场解决会议行动项'),
        node('策略二：不当场则用异步工具'),
        node('策略三：公开决策依据'),
      ]),
    );
    const result = repairCompositeOrdinalBranches(t);
    expect(result.root.children).toHaveLength(3);
    expect(result.root.children!.every((c) => c.content.startsWith('策略'))).toBe(true);
  });

  it('两个独立（非复合）序数兄弟节点不强行合并（保守）', () => {
    const t = tree(
      node('根', [node('策略一：当场解决'), node('策略二：异步处理')]),
    );
    const result = repairCompositeOrdinalBranches(t);
    expect(result.root.children).toHaveLength(2);
  });

  it('非复合、非序数内容完全不动', () => {
    const t = tree(
      node('根', [node('Figma/Axure 原型工具'), node('前端/后端分工'), node('1. 问题背景')]),
    );
    const before = JSON.stringify(t);
    const result = repairCompositeOrdinalBranches(t);
    expect(JSON.stringify(result)).toBe(before);
  });
});

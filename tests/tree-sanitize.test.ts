import { describe, expect, it } from 'vitest';

import {
  dedupeSiblingSubtrees,
  repairUnclosedDateBracket,
  sanitizeTreeContent,
  stripLeadingFragmentDigits,
  stripTrailingConnectiveParticles,
  stripTrailingDanglingPunctuation,
} from '../lib/utils/tree';
import type { MindMapNode, MindMapTree } from '../lib/types/mindmap';

function node(content: string, children: MindMapNode[] = [], id = content): MindMapNode {
  return { id, content, children, collapsed: false } as MindMapNode;
}

function tree(root: MindMapNode): MindMapTree {
  return {
    id: 'tree-1',
    root,
    meta: {
      title: 'T',
      sourceType: 'text',
      sourceRef: { type: 'text' },
      createdAt: 0,
      updatedAt: 0,
      version: 1,
    },
  } as unknown as MindMapTree;
}

describe('树内容机械清理（代码层兜底）', () => {
  describe('stripTrailingDanglingPunctuation', () => {
    it('剥离 LLM 截断残留的悬垂标点', () => {
      expect(stripTrailingDanglingPunctuation('主导搭建付费会员体系，')).toBe('主导搭建付费会员体系');
      expect(stripTrailingDanglingPunctuation('数据看板建设主导从')).toBe('数据看板建设主导从');
      expect(stripTrailingDanglingPunctuation('组合拳的玩法；')).toBe('组合拳的玩法');
    });

    it('连续悬垂标点全部剥离', () => {
      expect(stripTrailingDanglingPunctuation('推进增长，、；')).toBe('推进增长');
    });

    it('正常内容不受影响（冒号类目符/右括号保留）', () => {
      // 冒号结尾是合法的类目节点（如“游戏化产品设计：”），不剥离
      expect(stripTrailingDanglingPunctuation('转化路径优化：')).toBe('转化路径优化：');
      expect(stripTrailingDanglingPunctuation('深圳特鹏（2023.03-2023.06）')).toBe(
        '深圳特鹏（2023.03-2023.06）',
      );
    });
  });

  describe('stripLeadingFragmentDigits', () => {
    it('剥离 OCR/解析遗留的日期残片前缀（真实 badcase）', () => {
      // 只管开头残片；尾部悬垂标点由 stripTrailingDanglingPunctuation 负责
      expect(stripLeadingFragmentDigits('06 深圳产品羽兔网、溜溜自学网（设计在线教育学习平台，')).toBe(
        '深圳产品羽兔网、溜溜自学网（设计在线教育学习平台，',
      );
    });

    it('数字后紧跟数字时保守不剥离（如编号+数字组合）', () => {
      expect(stripLeadingFragmentDigits('25 20007 求职目标')).toBe('25 20007 求职目标');
    });

    it('以数字开头的正常信息不受影响', () => {
      expect(stripLeadingFragmentDigits('3-5人团队项目负责人')).toBe('3-5人团队项目负责人');
      expect(stripLeadingFragmentDigits('199万GMV历史新高')).toBe('199万GMV历史新高');
      expect(stripLeadingFragmentDigits('GMV稳定增收40万')).toBe('GMV稳定增收40万');
    });

    it('剥离后剩余过短则不动（防误剥编号型有效节点）', () => {
      expect(stripLeadingFragmentDigits('12 数据')).toBe('12 数据');
    });
  });

  describe('stripTrailingConnectiveParticles', () => {
    it('剥离句中截断的连接词残尾（Tal badcase：分支标签「不公平是」）', () => {
      expect(stripTrailingConnectiveParticles('不公平是')).toBe('不公平');
      expect(stripTrailingConnectiveParticles('工作方法与')).toBe('工作方法');
      expect(stripTrailingConnectiveParticles('风险或')).toBe('风险');
      expect(stripTrailingConnectiveParticles('团队和')).toBe('团队');
      expect(stripTrailingConnectiveParticles('不公平的')).toBe('不公平');
    });

    it('以连接字结尾的完整词不受影响（剥离后剩 1 字则守卫拦下）', () => {
      expect(stripTrailingConnectiveParticles('目的')).toBe('目的');
      expect(stripTrailingConnectiveParticles('总和')).toBe('总和');
      expect(stripTrailingConnectiveParticles('于是')).toBe('于是');
      expect(stripTrailingConnectiveParticles('普及')).toBe('普及');
    });

    it('正常结尾不改动', () => {
      expect(stripTrailingConnectiveParticles('不公平岗位的现实挑战')).toBe(
        '不公平岗位的现实挑战',
      );
    });
  });

  describe('repairUnclosedDateBracket', () => {
    it('补齐日期区间缺失的右括号（真实 badcase）', () => {
      expect(repairUnclosedDateBracket('深圳特鹏网络有限公司用户运营（2023.03-2023.06')).toBe(
        '深圳特鹏网络有限公司用户运营（2023.03-2023.06）',
      );
      expect(repairUnclosedDateBracket('虎刺怕互联网服务活动运营（2018.11-2021.03')).toBe(
        '虎刺怕互联网服务活动运营（2018.11-2021.03）',
      );
    });

    it('半角括号同样修复', () => {
      expect(repairUnclosedDateBracket('某公司产品经理(2021.06-2022.07')).toBe('某公司产品经理(2021.06-2022.07)');
    });

    it('已闭合或非日期区间不改动', () => {
      expect(repairUnclosedDateBracket('深圳特鹏（2023.03-2023.06）')).toBe('深圳特鹏（2023.03-2023.06）');
      expect(repairUnclosedDateBracket('推动月（1）')).toBe('推动月（1）');
      expect(repairUnclosedDateBracket('某公司（详情见附件')).toBe('某公司（详情见附件');
    });
  });

  describe('dedupeSiblingSubtrees', () => {
    it('同父下完全相同的子树去重（保留首个）——修复重复生成 badcase', () => {
      const dup = node('5年经验，', [node('具备从0到1设计APP经验')]);
      const root = node('根', [
        node('部门记录', [node('A'), dup, node('B'), { ...dup, id: 'dup-2' }]),
      ]);
      const result = dedupeSiblingSubtrees(root);
      expect(result.children![0].children).toHaveLength(3);
      expect(result.children![0].children!.map((c) => c.content)).toEqual(['A', dup.content, 'B']);
    });

    it('仅叶子内容不同则不去重', () => {
      const root = node('根', [node('能力', [node('细节A')]), node('能力', [node('细节B')])]);
      const result = dedupeSiblingSubtrees(root);
      expect(result.children).toHaveLength(2);
    });

    it('不同父节点下的相同子树互不影响（仅同父去重）', () => {
      const leaf = node('同一事实');
      const root = node('根', [node('父A', [leaf]), node('父B', [{ ...leaf, id: 'leaf-2' }])]);
      const result = dedupeSiblingSubtrees(root);
      expect(result.children![0].children).toHaveLength(1);
      expect(result.children![1].children).toHaveLength(1);
    });
  });

  describe('sanitizeTreeContent（组合入口）', () => {
    it('真实 badcase 复合修复：悬垂标点 + 日期括号 + 重复子树', () => {
      const buildDup = () =>
        node('经历总结，', [
          node('具备从0到1设计APP及小程序经验，'),
          node('参与项目15个（其中独立负责6个）'),
        ]);
      const root = node('根', [
        node('深圳特鹏网络有限公司用户运营（2023.03-2023.06'),
        node('重复区', [buildDup(), buildDup()]),
        node('正常分支：量化成果'),
      ]);
      const result = sanitizeTreeContent(tree(root));
      expect(result.root.children![0].content).toBe('深圳特鹏网络有限公司用户运营（2023.03-2023.06）');
      expect(result.root.children![1].children).toHaveLength(1);
      expect(result.root.children![1].children![0].children![0].content).toBe('具备从0到1设计APP及小程序经验');
      expect(result.root.children![2].content).toBe('正常分支：量化成果');
    });
  });
});

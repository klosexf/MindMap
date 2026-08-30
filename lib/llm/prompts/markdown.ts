import type { NormalizedDocument } from '@/lib/types/mindmap';

import { cleanMarkdownForLLM } from '../text-clean';
import { PYRAMID_DOCUMENT_SUMMARY_FRAMEWORK, PYRAMID_SELF_CHECK_LOOP } from './modules';

/**
 * Markdown 结构化总结 User Prompt（配 MARKDOWN_SUMMARY_SYSTEM）。
 */
export function buildMarkdownPreviewPrompt(doc: NormalizedDocument): string {
  return [
    '你是资深文档分析助手。请基于输入内容，运用金字塔原理输出一份中文 Markdown 结构化总结。',
    '要求：',
    '1. 仅基于输入内容，不要编造事实。',
    '2. 直接输出 Markdown 文本，不要输出 JSON，不要代码块包裹。',
    '3. 结构必须包含：',
    '   - 一级标题：中心主题',
    '   - 二级标题：中心思想（1-3句话，结论先行）',
    '   - 二级标题：关键论点（3-5个主要分支；信息不足时说明原因，不凑数）',
    '   - 二级标题：支撑依据（每个论点列出原文事实、数据或案例）',
    '   - 二级标题：逻辑关系（说明归纳/演绎/因果/并列/递进关系）',
    '4. 每条 bullet 尽量 8~30 字。',
    '5. 输出语言：简体中文。',
    '',
    PYRAMID_DOCUMENT_SUMMARY_FRAMEWORK,
    '',
    '质量控制：',
    '- 确保每个节点内容完整且有意义',
    '- 避免重复内容',
    '- 保持层级逻辑清晰',
    '- 重要信息优先级更高',
    '',
    PYRAMID_SELF_CHECK_LOOP,
    '',
    `文档标题：${doc.sourceMeta.title || '未命名文档'}`,
    `来源类型：${doc.sourceMeta.type}`,
    '',
    '输入内容：',
    cleanMarkdownForLLM(doc.markdown).slice(0, 14000),
  ].join('\n');
}

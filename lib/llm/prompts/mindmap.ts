import type { NormalizedDocument } from '@/lib/types/mindmap';
import { MAX_TREE_DEPTH, MAX_TREE_NODES } from '@/lib/utils/tree';

import { cleanMarkdownForLLM } from '../text-clean';
import {
  COVERAGE_CHECKLIST,
  HIGH_VALUE_EXTRACTION_WORKFLOW,
  HOMOGENEOUS_BRANCH_TEMPLATE,
  NODE_WRITING_RULES,
  PYRAMID_DOCUMENT_SUMMARY_FRAMEWORK,
  PYRAMID_SELF_CHECK_LOOP,
  STYLE_FRAMEWORK_RULES,
} from './modules';
import type { PromptDensity } from './profiles';

/**
 * 思维导图生成 User Prompt（流式主路径，配 streamObject + llmTreeSchema）。
 *
 * 分层约定（与 ANTI_HALLUCINATION_SYSTEM 组合成完整契约）：
 * - 金字塔四原则/方法论 → System 层单一来源，本 prompt 不重复
 * - 机械规则（去重/超长拆分/深度截断）→ 代码层后处理强制执行，prompt 只保留目标值引导
 * - 本层只承载：任务差异、语义红线、场景化 few-shot、变量注入
 *
 * density（来自模型能力画像 profiles.ts）：
 * - full：完整脚手架，含 few-shot 教学示例
 * - lean：省略 few-shot——强指令遵循模型凭规则红线即可执行，示例冗余且抑制发挥
 *
 * 修改本文件必须通过 tests/llm-prompts.test.ts 的快照与 token 预算门禁。
 */
export function buildPrompt(doc: NormalizedDocument, opts: { density?: PromptDensity } = {}): string {
  const density: PromptDensity = opts.density ?? 'full';
  const cleanedMarkdown = cleanMarkdownForLLM(doc.markdown).slice(0, 12000);

  const fewShotBlock =
    density === 'lean'
      ? []
      : [
          '## Few-shot（正例展示结论先行 + 以上统下 + 归类分组 + 逻辑递进；反例来自真实 badcase）',
          '',
          '✅ 正例 · 简历风（结构递进 · 按能力维度归类）：',
          '// 根=综合能力画像（结论），一级=技能→项目→成果（结构递进）',
          '{"content":"全栈工程师 · 后端为主/前端为辅，具备独立交付能力","children":[',
          '  {"content":"后端技术栈：Spring Boot微服务 + Python数据处理","children":[]},',
          '  {"content":"前端能力：React组件库开发 + Vue管理后台","children":[]},',
          '  {"content":"数据工程：SQL优化 + Redis缓存策略","children":[]}',
          ']}',
          '点评：根=结论（"全栈+独立交付"）而非标签，一级=支撑根结论的技能方向，所有子节点严格属于技能范畴',
          '',
          '❌ 反例 1（分类边界污染 · 不同语义类别混入同一父节点）：',
          '{"content":"专业技能","children":[',
          '  {"content":"Python开发","children":[]},',
          '  {"content":"平台活跃度维持","children":[]},',
          '  {"content":"项目周期缩短30%","children":[]},',
          '  {"content":"交易结算","children":[]}',
          ']}',
          '反例错在：②"平台活跃度维持"是运营指标 ②"项目周期缩短"是项目成果 ③"交易结算"是业务操作——均不是技能，应分别归入"运营成果""项目成果""工作职责"等对应父节点',
          '',
          '❌ 反例 2（文件名作为节点标题 · 最严重错误）：',
          '{"content":"思维导图","children":[',
          '  {"content":"产品经理_深圳 15-20K】谭艳丽 9年.pdf","children":[]},',
          '  {"content":"产品经理_深圳 15-20K】谭艳丽 9年.pdf(1)","children":[]}',
          ']}',
          '反例错在：二级节点用了原始文件名，完全无意义。✅ 正确做法：从PDF正文提取实际章节标题，如 "工作经历 · 9年产品经理/社交电商赛道""专业技能 · Python/数据分析/SQL"',
          '',
        ];

  return [
    '你是一名结构化信息提炼专家。任务：严格遵循系统指令中的金字塔原理四原则，从原文中精准提炼信息并组织为**总分结构**思维导图。',
    '',
    PYRAMID_DOCUMENT_SUMMARY_FRAMEWORK,
    '',
    HIGH_VALUE_EXTRACTION_WORKFLOW,
    '',
    '## 绝对规则（违反任何一条即视为失败）',
    '1. 忠实原文：每个节点的字面信息必须源自原文；只允许同义压缩、合并相邻句、删去口语化修饰；禁止新增任何原文未出现的事实、数据、人名、案例、术语',
    '2. 模糊、乱码、不完整的句子直接忽略，不要猜测含义；文档中没有对应内容的维度不创建节点；文末截断时以最后一个完整段落为准',
    '3. 全树去重：同一事实/经历/数据/句意全树只能出现一次，归入最相关父节点；如果同时可归入多个父节点，只保留在“最具体、最贴切”的分支；不得在父节点和子节点中重复复述同一条信息（父节点概括，子节点补充新事实）；禁止用“(1)”“(2)”或近似后缀为重复节点强行区分',
    '4. 语义归属：先确定父节点定义的语义范畴，再判断每条信息是否属于该范畴；不属于则删除或移到正确位置——宁可减少节点也不污染分类',
    '5. 🚫 文件名禁令：任何节点的 content 禁止包含文件名或文件扩展名；遇到文件名时，从对应正文内容中提取有意义的标题；文档标题若只说明“这是什么文档”而非核心判断，根节点应改写为更有信息量的结论句',
    '6. 结论性陈述：根节点和每个父节点必须是结论性陈述，不得仅为分类标签；禁止“概述”“分析”“总结”“背景”“方法”“结果”等空洞分类名；无空标签节点',
    '7. 🚫 原文粘贴禁令：禁止将原文段落（含 OCR 原文）原样粘贴为节点内容；节点必须是压缩提炼后的表达，超长信息拆为父子结构',
    '',
    '## 语义归属判定规则（输出前必须逐条对照）',
    '下面定义每类父节点“只能”包含的子节点类型。请严格对照执行：',
    '- "技能"类父节点（含"专业技能""技术栈""能力"等）：只能放工具名、语言名、方法论、证书、能力名称，禁止放业务操作/运营指标/项目成果',
    '- "项目/经历"类父节点（含"工作经历""项目经验"等）：只能放具体项目名称、项目描述、担任角色',
    '- "成果/业绩"类父节点（含"工作成果""业绩"等）：只能放量化结果、关键产出',
    '- "职责"类父节点：只能放具体职责描述',
    '- "教育"类父节点：只能放学历、学校、专业',
    '判定口诀：读子节点内容 → 问"这句话描述的是父节点定义的范畴吗？"→ 不是则删除或移到正确位置',
    '',
    COVERAGE_CHECKLIST,
    '',
    NODE_WRITING_RULES,
    '',
    STYLE_FRAMEWORK_RULES,
    '',
    HOMOGENEOUS_BRANCH_TEMPLATE,
    '',
    '## 约束条件（机械规则由代码层强制兜底：去重/拆分/截断，生成时请一次做对以避免后处理破坏结构）',
    `- 最大层级：${MAX_TREE_DEPTH}`,
    `- 最大节点数：${MAX_TREE_NODES}`,
    '- 节点文本目标 15-25 字，上限 35 字；超过 35 字必须拆为父子结构，严禁截断意思',
    '- 一级节点 2-8 个，由内容决定，不凑数；每个节点的直接子节点数 ≤ 8 个，超过时在父节点与叶子之间插入归纳分组',
    '',
    PYRAMID_SELF_CHECK_LOOP,
    '',
    '## 兜底规则',
    '- 原文 <100 字或无明显结构：输出"单根节点 + 1-2 个子节点"的最小合法结构，不强行拼凑',
    '- 原文全为乱码 / 无法识别：输出 {"content": "无法识别的内容","children": []}',
    '',
    ...fewShotBlock,
    `## 文档标题：${doc.sourceMeta.title || '自动生成思维导图'}`,
    '',
    '## 输入内容',
    cleanedMarkdown,
  ].join('\n');
}

/**
 * 思维导图生成 User Prompt（兼容模式，full 密度档，配 generateText + 手动 JSON 解析）。
 * 与流式版共用 System；差异：显式 JSON 输出要求 + 正文截断 8000 字。
 */
export function buildCompatJsonPrompt(doc: NormalizedDocument): string {
  const cleanedMarkdown = cleanMarkdownForLLM(doc.markdown).slice(0, 8000);
  return [
    '你是一名结构化信息提炼专家。任务：严格遵循系统指令中的金字塔原理四原则，从原文中精准提炼信息并组织为**总分结构**思维导图 JSON。',
    '',
    PYRAMID_DOCUMENT_SUMMARY_FRAMEWORK,
    '',
    HIGH_VALUE_EXTRACTION_WORKFLOW,
    '',
    '## 生成规则',
    '- 内容必须忠实原文；允许压缩改写，不允许新增事实、数据、人名、案例、术语。',
    '- 模糊、乱码、不完整句子直接忽略；文档没有的维度不要创建节点。',
    '- 同一事实/经历/数据/句意全树只能出现一次；如果可放入多个分支，只保留在最贴切的那个分支。',
    '- 不得在父节点和子节点中重复复述同一条信息；父节点做概括，子节点必须补充新的支撑事实。',
    '- 禁止用“(1)”“(2)”或其他编号后缀来制造伪去重节点；重复内容只能删除、合并或改写为不同维度。',
    '- 文件名禁令：任何节点 content 禁止包含文件名或文件扩展名。',
    '- 原文粘贴禁令：禁止将原文段落（含 OCR 原文）原样粘贴为节点内容；节点必须是压缩提炼后的表达，超长信息拆为父子结构。',
    '- 即使文档标题本身正常，只要它主要是在说明“这是什么文档”而非“文档的核心判断”，根节点也应改写为更有信息量的结论句。',
    '- 每个子节点必须属于其父节点语义范畴；如果不属于，就删除或移到正确位置。',
    '- 根节点和每个父节点都必须包含实质信息，不得使用“概述”“分析”“总结”“背景”“方法”等空标签。',
    '- 节点标题必须唯一；父子、同级之间不得重复或高度相似。',
    '',
    COVERAGE_CHECKLIST,
    '',
    NODE_WRITING_RULES,
    '',
    STYLE_FRAMEWORK_RULES,
    '',
    HOMOGENEOUS_BRANCH_TEMPLATE,
    '',
    '## 约束条件',
    `- 最大层级：${MAX_TREE_DEPTH}`,
    `- 最大节点数：${MAX_TREE_NODES}`,
    '- 节点文本目标 15-25 字，上限 35 字。',
    '- 超过 35 字必须拆为父子结构，严禁截断意思。',
    '- 一级节点 2-8 个，由内容决定，不凑数。',
    '- 每个节点的直接子节点数 ≤ 8 个；超过时自动创建中间归纳分组。',
    '- 所有二级节点必须至少展开一层；二级节点不得保持叶子状态；子节点必须来自原文。',
    '',
    '## 输出要求',
    '- 只输出合法 JSON，不要输出 Markdown、解释、自检过程或额外文字。',
    '- JSON 结构：{"title":"...","root":{"content":"...","children":[...]}}。',
    '- 生成前先在内部完成规划与自检，再一次性输出最终 JSON。',
    '- 输出前执行一次全树去重扫描，确认没有跨分支重复、父子复述或“(1)/(2)”伪去重节点。',
    '',
    PYRAMID_SELF_CHECK_LOOP,
    '',
    '## 兜底规则',
    '- 原文 <100 字或无明显结构：输出“单根节点 + 1-2 个子节点”的最小合法结构。',
    '- 原文全为乱码或无法识别：输出 {"content":"无法识别的内容","children":[]}。',
    '',
    `## 文档标题：${doc.sourceMeta.title || '自动生成思维导图'}`,
    '',
    '## 输入内容',
    cleanedMarkdown,
  ].join('\n');
}

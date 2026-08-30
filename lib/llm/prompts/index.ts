/**
 * Prompt 资产统一出口。
 *
 * 工程约定：
 * - prompt 一律从本模块导入，禁止在业务代码里内联 prompt 字符串
 * - 语义规则单一来源（modules.ts），system/user 组装函数禁止双写
 * - 改动 prompt 必须更新 PROMPT_VERSION，并通过 tests/llm-prompts.test.ts
 *   的快照与 token 预算门禁
 */

export const PROMPT_VERSION = 'v2.0.0';

export {
  BRANCH_EXPANSION_SYSTEM,
  TREE_OPTIMIZE_SYSTEM,
  ANTI_HALLUCINATION_SYSTEM,
  DOCUMENT_SUMMARY_SYSTEM,
  MARKDOWN_SUMMARY_SYSTEM,
} from './system';

export {
  COVERAGE_CHECKLIST,
  HIGH_VALUE_EXTRACTION_WORKFLOW,
  NODE_WRITING_RULES,
  PYRAMID_DOCUMENT_SUMMARY_FRAMEWORK,
  PYRAMID_SELF_CHECK_LOOP,
} from './modules';

export { buildPrompt, buildCompatJsonPrompt } from './mindmap';
export { buildMarkdownPreviewPrompt } from './markdown';
export { buildBranchExpansionPrompt, type BranchExpansionInput } from './branch';
export { buildTreeOptimizePrompt, type TreeOptimizeMode, type TreeOptimizationInput } from './optimize';
export {
  resolveModelProfile,
  type ModelProfile,
  type OutputMode,
  type PromptDensity,
} from './profiles';

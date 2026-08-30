/**
 * 模型能力画像（Model Capability Profile）。
 *
 * 设计动机：不同 provider 的指令遵循能力与 API 能力不同，
 * prompt 密度与输出通道应当匹配模型能力，而不是靠硬编码 provider 分支。
 *
 * 两个正交维度：
 * - outputMode：输出通道。stream-object = streamObject 结构化流式输出；
 *   text-json = generateText 一次性输出 + 手动 JSON 解析（兼容模式）。
 * - density：prompt 密度。lean = 精简指令（强指令遵循模型，过度约束反而抑制发挥）；
 *   full = 完整脚手架（显式规则补足弱遵循，兼容通道同时承担格式约束）。
 *
 * 新增 provider 时只需在此登记画像，不改生成链路代码。
 */

export type OutputMode = 'stream-object' | 'text-json';
export type PromptDensity = 'lean' | 'full';

export interface ModelProfile {
  /** 结构化输出通道 */
  outputMode: OutputMode;
  /** prompt 密度档位 */
  density: PromptDensity;
}

const PROVIDER_PROFILES: Record<string, ModelProfile> = {
  // OpenAI Responses API：原生 streamObject 结构化输出，指令遵循强 → 精简密度
  openai: { outputMode: 'stream-object', density: 'lean' },
  // OpenAI 兼容通道（Chat Completions）：一次性 JSON + 手动解析 → 完整脚手架
  zhipu: { outputMode: 'text-json', density: 'full' },
  kimi: { outputMode: 'text-json', density: 'full' },
  minimax: { outputMode: 'text-json', density: 'full' },
  qwen: { outputMode: 'text-json', density: 'full' },
  hunyuan: { outputMode: 'text-json', density: 'full' },
  deepseek: { outputMode: 'text-json', density: 'full' },
};

const DEFAULT_PROFILE: ModelProfile = { outputMode: 'text-json', density: 'full' };

export function resolveModelProfile(provider: string | undefined | null): ModelProfile {
  if (!provider) return DEFAULT_PROFILE;
  return PROVIDER_PROFILES[provider] ?? DEFAULT_PROFILE;
}

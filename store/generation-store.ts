import { create } from 'zustand';

/**
 * 实时生成会话的进度与状态（UI 订阅用）。
 * 会话编排本体在 lib/streaming/generation-session.ts，本 store 只承载可渲染状态。
 */

export type GenerationStatus =
  | 'idle'        // 无会话
  | 'streaming'   // 流式生成中（正常回放）
  | 'paused'      // 用户暂停（事件继续入队，回放停止）
  | 'completed'   // complete 已到达，终树已生效
  | 'stopped'     // 用户硬停止，部分树已保存
  | 'error';      // 流关闭且未见 complete

/** 生成阶段（用于横幅文案），由会话事件推进 */
export type GenerationPhase = 'parsing' | 'skeleton' | 'nodes' | 'done';

interface GenerationState {
  sessionId: string | null;
  status: GenerationStatus;
  phase: GenerationPhase;
  treeId: string | null;
  nodesReceived: number;
  nodesApplied: number;
  startedAt: number | null;
  lastEventAt: number | null;
  errorMessage: string | null;
  warning: string | null;

  /** 供 generation-session 内部更新 */
  setSession: (session: {
    sessionId: string;
    treeId: string;
    startedAt: number;
  }) => void;
  update: (patch: Partial<Omit<GenerationState, 'setSession' | 'update' | 'reset'>>) => void;
  reset: () => void;
}

/**
 * 纯决策函数：给定导图是否处于活跃生成会话（treeId 匹配且 streaming/paused）。
 * editor-page 的编辑锁、卸载语义、会话领养判定共用，抽出以便单测。
 */
export function isActiveGenerationForTree(
  session: { treeId: string | null; status: GenerationStatus },
  treeId: string,
): boolean {
  return session.treeId === treeId && (session.status === 'streaming' || session.status === 'paused');
}

export const useGenerationStore = create<GenerationState>((set) => ({
  sessionId: null,
  status: 'idle',
  phase: 'parsing',
  treeId: null,
  nodesReceived: 0,
  nodesApplied: 0,
  startedAt: null,
  lastEventAt: null,
  errorMessage: null,
  warning: null,

  setSession: ({ sessionId, treeId, startedAt }) =>
    set({
      sessionId,
      treeId,
      startedAt,
      status: 'streaming',
      phase: 'parsing',
      nodesReceived: 0,
      nodesApplied: 0,
      lastEventAt: startedAt,
      errorMessage: null,
      warning: null,
    }),
  update: (patch) => set(patch),
  reset: () =>
    set({
      sessionId: null,
      status: 'idle',
      phase: 'parsing',
      treeId: null,
      nodesReceived: 0,
      nodesApplied: 0,
      startedAt: null,
      lastEventAt: null,
      errorMessage: null,
      warning: null,
    }),
}));

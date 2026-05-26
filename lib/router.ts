/**
 * Router — 任务 → Lane 路由层
 * =============================
 *
 * 职责：
 *   1) 持久化：用户当前选的 preset_id + 在该 preset 上做的覆盖（user overrides）
 *   2) 路由：resolveLane(task) → LaneId（先看 override，再看 preset matrix）
 *   3) Fallback：lane 不可用时（缺凭证 / 桥未启）自动降级到「同档次但可用」的 lane
 */

import {
  ALL_TASK_TAGS,
  type BuiltinLaneId,
  DEFAULT_PRESET_ID,
  LaneId,
  PRESETS,
  Preset,
  RoutingMatrix,
  TaskTag,
} from './models';
import {
  getDefaultPublicMatrix,
  isLaneAvailableInCurrentMode,
  isPublicMode,
  PUBLIC_FALLBACK_CHAIN,
} from './runtime-mode';
import { createWriteState } from './store-write-helper';

const ROUTER_KEY = 'wc_poc_router_v2'; // v2: 加 taskFallback 字段

// P1-#4:暴露 quota / 写入错误给 UI(原本 catch 静默吞,用户撞 5MB 上限不知)
const routerWriteState = createWriteState('router');
export const getRouterWriteError = () => routerWriteState.lastError();
export const clearRouterWriteError = () => routerWriteState.clearError();

/**
 * 全局默认 fallback 链。运行模式分支:
 *   - dev(本机):    ['codex_bridge']  — 走桌面 ChatGPT Pro 订阅池
 *   - public(公网): ['deepseek']      — 走 BYOK,用户填的 DeepSeek key 转发
 *
 * 想要某个任务有专属链时，往 RouterState.taskFallback[task] 写覆盖即可。
 *
 * 注意：这里只是「task 级 fallback 链」的默认。最终 callLLM 里组装实际尝试顺序是：
 *   [primaryLane, ...taskFallback, ...LaneLevelFallback]  （去重）
 * 也就是说 lane 级兜底（FALLBACK_CHAIN）永远在最后兜底,保证「最后一定能掉到 local_gemma(dev) / deepseek(public)」。
 */
export const DEFAULT_TASK_FALLBACK: LaneId[] = ['codex_bridge']; // dev 模式默认
export const DEFAULT_TASK_FALLBACK_PUBLIC: LaneId[] = ['deepseek']; // public 模式默认

/** 按运行模式返回 task 级默认 fallback 链(每次调用都重新拷贝,避免被外部 mutate)。 */
export function getDefaultTaskFallback(): LaneId[] {
  return isPublicMode() ? [...DEFAULT_TASK_FALLBACK_PUBLIC] : [...DEFAULT_TASK_FALLBACK];
}

export interface RouterState {
  presetId: string;
  /** 用户在该 preset 上对个别任务的覆盖。 */
  overrides: Partial<RoutingMatrix>;
  /**
   * 每个任务的降级链路（user-defined）。未填的任务用 DEFAULT_TASK_FALLBACK。
   * 链里不应包含 primaryLane 本身（去重在 callLLM 里做）。
   */
  taskFallback?: Partial<Record<TaskTag, LaneId[]>>;
}

const DEFAULT_STATE: RouterState = {
  presetId: DEFAULT_PRESET_ID,
  overrides: {},
  taskFallback: {},
};

function sanitizeMatrixForCurrentMode(matrix: RoutingMatrix, fallback: RoutingMatrix): RoutingMatrix {
  const next = { ...matrix };
  for (const task of ALL_TASK_TAGS) {
    if (!isLaneAvailableInCurrentMode(next[task])) {
      next[task] = fallback[task];
    }
  }
  return next;
}

function sanitizeFallbackChainForCurrentMode(chain: LaneId[]): LaneId[] {
  const out: LaneId[] = [];
  for (const lane of chain) {
    if (!isLaneAvailableInCurrentMode(lane)) continue;
    if (!out.includes(lane)) out.push(lane);
  }
  return out;
}

// ─── 持久化 ──────────────────────────────────────────────────────────

function readState(): RouterState {
  if (typeof window === 'undefined') return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(ROUTER_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_STATE;
    return {
      presetId: typeof parsed.presetId === 'string' ? parsed.presetId : DEFAULT_PRESET_ID,
      overrides: parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {},
      taskFallback:
        parsed.taskFallback && typeof parsed.taskFallback === 'object' ? parsed.taskFallback : {},
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function writeState(s: RouterState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ROUTER_KEY, JSON.stringify(s));
    routerWriteState.reportSuccess();
  } catch (e) {
    routerWriteState.reportFailure(e, '路由配置保存失败');
  }
}

export const router = {
  getState: readState,
  getPreset(): Preset {
    const s = readState();
    return PRESETS.find((p) => p.id === s.presetId) ?? PRESETS[0];
  },
  /** 获取当前生效矩阵（preset matrix + overrides）。 */
  getActiveMatrix(): RoutingMatrix {
    const s = readState();
    if (isPublicMode()) {
      const base = getDefaultPublicMatrix();
      return sanitizeMatrixForCurrentMode({ ...base, ...s.overrides }, base);
    }
    const preset = PRESETS.find((p) => p.id === s.presetId) ?? PRESETS[0];
    return sanitizeMatrixForCurrentMode({ ...preset.matrix, ...s.overrides }, preset.matrix);
  },
  /** 单任务路由：用户 override > preset。 */
  resolveLane(task: TaskTag): LaneId {
    const matrix = router.getActiveMatrix();
    return matrix[task];
  },
  setPreset(presetId: string) {
    writeState({ ...readState(), presetId });
  },
  setOverride(task: TaskTag, lane: LaneId) {
    const s = readState();
    writeState({ ...s, overrides: { ...s.overrides, [task]: lane } });
  },
  clearOverride(task: TaskTag) {
    const s = readState();
    const { [task]: _drop, ...rest } = s.overrides;
    void _drop;
    writeState({ ...s, overrides: rest });
  },
  clearAllOverrides() {
    writeState({ ...readState(), overrides: {} });
  },

  // ─── 任务级 fallback 链 ───────────────────────────────────────────

  /** 该任务当前生效的 fallback 链。未自定义时返回当前 mode 的默认链拷贝。 */
  getTaskFallback(task: TaskTag): LaneId[] {
    const s = readState();
    const custom = s.taskFallback?.[task];
    if (Array.isArray(custom)) {
      const sanitized = sanitizeFallbackChainForCurrentMode(custom);
      return sanitized.length > 0 ? sanitized : getDefaultTaskFallback();
    }
    return getDefaultTaskFallback();
  },

  /** 该任务是否被用户自定义过 fallback（true 表示用户改过，false 表示走默认）。 */
  isTaskFallbackCustomized(task: TaskTag): boolean {
    const s = readState();
    return Array.isArray(s.taskFallback?.[task]);
  },

  setTaskFallback(task: TaskTag, chain: LaneId[]) {
    const s = readState();
    writeState({
      ...s,
      taskFallback: { ...(s.taskFallback ?? {}), [task]: chain },
    });
  },

  /** 把该任务的 fallback 链恢复成默认（删除 override）。 */
  clearTaskFallback(task: TaskTag) {
    const s = readState();
    const next = { ...(s.taskFallback ?? {}) };
    delete next[task];
    writeState({ ...s, taskFallback: next });
  },

  /** 批量覆盖：把所有任务的 fallback 链统一设为某个序列。 */
  setAllTasksFallback(chain: LaneId[]) {
    const s = readState();
    const next: Partial<Record<TaskTag, LaneId[]>> = {};
    for (const t of ALL_TASK_TAGS) next[t] = [...chain];
    writeState({ ...s, taskFallback: next });
  },

  clearAllTasksFallback() {
    writeState({ ...readState(), taskFallback: {} });
  },
};

// ─── Fallback 链 ────────────────────────────────────────────────────

/**
 * 当目标 Lane 不可用（凭证缺失 / bridge 未启）时,自动降级。
 * 设计原则：同档次内尽量保留体验，不行就降到本地保证能跑。
 *
 *   codex_bridge      → codex_api → deepseek → local_gemma
 *   codex_spark_bridge→ codex_api → deepseek → local_gemma
 *   codex_api         → deepseek → local_gemma
 *   claude_bridge     → claude_byok → deepseek → local_gemma
 *   claude_byok       → deepseek → local_gemma
 *   deepseek          → local_gemma
 *   local_gemma       → (无 fallback；本地是底)
 *
 * 类型说明(P1-#3):keys 锁成 `BuiltinLaneId` —— 加新内置 lane 时 TS 强制要求
 * 给它写 fallback;custom lane 不参与这个表(它们没 builtin fallback,由 getLaneFallbackChain 兜成 [])。
 * values 仍是 `LaneId[]`,因为 chain 里允许指向 custom lane(理论上),也允许指向其他 builtin。
 */
export const FALLBACK_CHAIN: Record<BuiltinLaneId, LaneId[]> = {
  codex_bridge: ['codex_api', 'deepseek', 'local_gemma'],
  codex_spark_bridge: ['codex_api', 'deepseek', 'local_gemma'],
  codex_api: ['deepseek', 'local_gemma'],
  claude_bridge: ['claude_byok', 'deepseek', 'local_gemma'],
  claude_byok: ['deepseek', 'local_gemma'],
  deepseek: ['local_gemma'],
  local_gemma: [],
};

/**
 * 按运行模式返回 lane 级 fallback 链。
 * - dev:    走完整 FALLBACK_CHAIN(含 bridge / local_gemma 兜底)
 * - public: 走 PUBLIC_FALLBACK_CHAIN(只在 BYOK lane 之间降级)
 *
 * 入参允许任意 LaneId(包括 custom_xxx)。custom lane 不在 builtin fallback 表里,
 * 用 `as BuiltinLaneId` 索引会返回 undefined,`?? []` 兜成空数组 — 等价于"custom lane
 * 自己负责自己的降级,gateway 跑完它就停"。
 */
export function getLaneFallbackChain(lane: LaneId): LaneId[] {
  if (isPublicMode()) return [...(PUBLIC_FALLBACK_CHAIN[lane as BuiltinLaneId] ?? [])];
  return [...(FALLBACK_CHAIN[lane as BuiltinLaneId] ?? [])];
}

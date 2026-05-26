/**
 * Runtime Mode — 判断 PoC 当前运行在 dev(本机)还是 public(公网部署)模式。
 * ============================================================
 *
 * 用途:
 *   - 本机模式:所有 lane 可用(codex_bridge / claude_bridge / local_gemma 等本地依赖)
 *   - 公网模式:只暴露 BYOK lane(codex_api / claude_byok / deepseek),用户用浏览器
 *               填的 API key 直接访问第三方,我们的后端不持有 key、不持久化、不日志
 *
 * 判定逻辑(单次评估,session 内缓存):
 *   - hostname 是 localhost / 127.0.0.1 / 192.168.* / *.local → dev
 *   - NODE_ENV === 'development' → dev
 *   - 否则 → public
 *
 * SSR 阶段(无 window)默认 dev,避免静态生成阶段误判。
 */
import { ALL_LANE_IDS, type BuiltinLaneId, type LaneId, type RoutingMatrix } from './models';

let _cachedMode: 'dev' | 'public' | null = null;

export type RuntimeMode = 'dev' | 'public';

export function getRuntimeMode(): RuntimeMode {
  if (_cachedMode) return _cachedMode;
  if (typeof window === 'undefined') {
    // SSR / static gen 阶段:不要缓存(production build 阶段也是 SSR,会被误缓存成 dev)
    return 'dev';
  }
  if (process.env.NODE_ENV === 'development') {
    _cachedMode = 'dev';
    return 'dev';
  }
  const host = window.location.hostname;
  const isLocal =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host.startsWith('192.168.') ||
    host.startsWith('10.') ||
    host.endsWith('.local');
  _cachedMode = isLocal ? 'dev' : 'public';
  return _cachedMode;
}

export function isPublicMode(): boolean {
  return getRuntimeMode() === 'public';
}

/**
 * 公网模式下不可用的 lane(依赖本机进程 / 桌面订阅 CLI)。
 * 用户在公网上没法装 codex / claude CLI,也没法跑本地 Gemma。
 */
export const PUBLIC_UNAVAILABLE_LANES: LaneId[] = [
  'codex_bridge',
  'codex_spark_bridge',
  'claude_bridge',
  'local_gemma',
];

/** 公网可用的 lane 白名单(仅 BYOK)。 */
export const PUBLIC_AVAILABLE_LANES: LaneId[] = ['codex_api', 'claude_byok', 'deepseek'];

export function isLanePublicAvailable(lane: LaneId): boolean {
  return PUBLIC_AVAILABLE_LANES.includes(lane);
}

/**
 * 当前运行模式下应该在 UI 里可见的 lane 列表。
 * - dev:    全部
 * - public: 只 BYOK 类(隐藏 codex_bridge / codex_spark_bridge / claude_bridge / local_gemma)
 *
 * ModelsTab 三处 lane 渲染(健康卡片 / 矩阵下拉 / fallback 链编辑器)都应该走这个 helper。
 */
export function getVisibleLaneIds(): LaneId[] {
  if (isPublicMode()) {
    return [...PUBLIC_AVAILABLE_LANES];
  }
  // dev: 全部内置 lane。P1-#2:用 ALL_LANE_IDS 派生,跟 LANES 字典自动同步,
  // 加新内置 lane 不再需要改这里。
  return [...ALL_LANE_IDS];
}

/**
 * 公网模式默认矩阵 — 全部走 deepseek(便宜,$0.07/$0.28 per 1M tok,质量也够 fan 项目)。
 * 用户后续可自己在 ModelsTab 改成 codex_api / claude_byok。
 */
export function getDefaultPublicMatrix(): RoutingMatrix {
  return {
    'director.beat': 'deepseek',
    'npc.core.dialogue': 'deepseek',
    'npc.side.dialogue': 'deepseek',
    'companion.deep': 'deepseek',
    'companion.banter': 'deepseek',
    'memory.consolidate': 'deepseek',
    'utility.summary': 'deepseek',
    'utility.structured': 'deepseek',
  };
}

/**
 * 公网模式 fallback 链 — 只在 BYOK lane 之间降级,绝不指向本机 lane。
 * 即便 router 里残留了对 codex_bridge / local_gemma 的引用(老用户存档),
 * gateway 跑 fallback 时也会被 lane 可用性检查刷掉。
 *
 * 类型(P1-#3):keys 锁 BuiltinLaneId —— 加新内置 lane 时 TS 强制写出它在公网模式下的降级路径。
 */
export const PUBLIC_FALLBACK_CHAIN: Record<BuiltinLaneId, LaneId[]> = {
  codex_bridge: ['codex_api', 'deepseek'], // 老存档兼容
  codex_spark_bridge: ['codex_api', 'deepseek'], // 老存档兼容
  codex_api: ['deepseek'],
  claude_bridge: ['claude_byok', 'deepseek'], // 老存档兼容
  claude_byok: ['deepseek'],
  deepseek: [],
  local_gemma: ['deepseek'], // 老存档兼容
};

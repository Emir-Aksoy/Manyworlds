/**
 * ModelGateway v2 — 类型与常量
 * ============================
 *
 * 5 条 Lane × 8 个任务标签 × 5 个预设的路由系统。
 * 见 /tech/模型路由系统-v1.md。
 */

// ─── Lane 定义 ─────────────────────────────────────────────────────────

/**
 * 内置 Lane id(union,IDE 能精确补全)。
 *
 * 用户通过 ModelsTab → "自定义 Lane" 加的 lane 会有 `custom_<slug>` 形式的 id,
 * 不在这个 union 里,但仍是合法 LaneId。
 */
export type BuiltinLaneId =
  | 'codex_bridge' // GPT-5.3 via ChatGPT Pro 订阅池（codex CLI bridge）
  | 'codex_spark_bridge' // GPT-5.3-Codex-Spark via 订阅 Spark 独立池（同 bridge）
  | 'codex_api' // GPT-5.2-Codex via OpenAI API key（pay-as-you-go, fallback）
  | 'claude_bridge' // Sonnet 4.5 via Claude Max Agent SDK 池（6-15 生效）
  | 'claude_byok' // Claude 浏览器直调（Console pay-as-you-go, fallback）
  | 'deepseek' // DeepSeek v4 Flash via API key
  | 'local_gemma'; // Gemma 4 E4B MLX via 本机 Gradio

/**
 * 运行时 LaneId — 内置 union + 任意 string(custom lane 的 id)。
 * `string & {}` 是 TS trick,IDE 仍把 BuiltinLaneId 列在补全里,
 * 同时类型上接受任意 string(custom_xxx)。
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type LaneId = BuiltinLaneId | (string & {});

export interface LaneDef {
  id: LaneId;
  label: string;
  shortLabel: string; // UI 矩阵 cell 用
  model: string;
  costNote: string;
  // 该 Lane 是否依赖外部凭证 / 本机进程；前端可探活
  requires: {
    apiKey?: 'anthropic' | 'deepseek' | 'openai' | null;
    bridge?: 'claude' | 'codex' | null;
    localServer?: 'gradio' | null; // 127.0.0.1:7860
  };
  /** 期望的 200 响应延迟段（典型 / p95）—— 路由策略参考 */
  latencyHint: 'fast' | 'mid' | 'slow';
}

export const LANES: Record<BuiltinLaneId, LaneDef> = {
  codex_bridge: {
    id: 'codex_bridge',
    label: 'Codex 主池 (订阅)',
    shortLabel: 'Codex',
    model: 'gpt-5.5', // ChatGPT 订阅下能用的当前主 model; 5.3 在订阅下不支持
    costNote: 'ChatGPT Pro 5h+7d 主池（截图当下 3%/82%）',
    requires: { bridge: 'codex' },
    latencyHint: 'mid',
  },
  codex_spark_bridge: {
    id: 'codex_spark_bridge',
    label: 'Codex Spark (订阅)',
    shortLabel: 'Spark',
    model: 'gpt-5.3-codex-spark',
    costNote: 'ChatGPT Pro Spark 独立池（截图当下 100% 闲置）；1000 tok/s',
    requires: { bridge: 'codex' },
    latencyHint: 'fast',
  },
  codex_api: {
    id: 'codex_api',
    label: 'Codex API (BYOK)',
    shortLabel: 'Codex-API',
    model: 'gpt-5.2-codex',
    costNote: 'OpenAI Console pay-as-you-go；订阅池满 / bridge 不可用时 fallback',
    requires: { apiKey: 'openai' },
    latencyHint: 'mid',
  },
  claude_bridge: {
    id: 'claude_bridge',
    label: 'Claude (订阅 Agent SDK)',
    shortLabel: 'Claude',
    model: 'claude-sonnet-4-5',
    costNote: 'Claude Max 5x $100/月 Agent SDK 池；2026-06-15 生效',
    requires: { bridge: 'claude' },
    latencyHint: 'mid',
  },
  claude_byok: {
    id: 'claude_byok',
    label: 'Claude API (BYOK)',
    shortLabel: 'Claude-API',
    model: 'claude-sonnet-4-5',
    costNote: 'Anthropic Console pay-as-you-go；bridge 不可用时 fallback',
    requires: { apiKey: 'anthropic' },
    latencyHint: 'mid',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek v4 Flash',
    shortLabel: 'DeepSeek',
    model: 'deepseek-v4-flash',
    costNote: '$0.07/$0.28 per 1M tokens；速度优先 + 极便宜',
    requires: { apiKey: 'deepseek' },
    latencyHint: 'fast',
  },
  local_gemma: {
    id: 'local_gemma',
    label: 'Gemma 4 E4B (本地)',
    shortLabel: 'Gemma',
    model: 'gemma-4-e4b-mlx-4bit',
    costNote: '$0 本机算力；首启 ~15s 冷加载，热调用几秒',
    requires: { localServer: 'gradio' },
    latencyHint: 'slow',
  },
};

export const ALL_LANE_IDS = Object.keys(LANES) as BuiltinLaneId[];

/**
 * 查 lane 定义 — 内置走 LANES 字典,custom 走 custom-lanes 模块。
 * 用法替代直接 `LANES[laneId]`,因为 LaneId 现在可以是 custom_xxx string。
 *
 * 注意:这里返回的 LaneDef 是"内置 lane 元数据格式"。custom lane 的真实信息
 * (baseUrl / apiKey / model)在 custom-lanes 里另存,不暴露在 LaneDef 接口里。
 */
export function getLaneDef(laneId: LaneId): LaneDef | undefined {
  // 内置 lane
  const builtin = LANES[laneId as BuiltinLaneId];
  if (builtin) return builtin;
  // custom lane:动态导入避免循环 import(custom-lanes 可能反向 import models 类型)
  // 用 require + try-catch:SSR 安全
  if (typeof window === 'undefined') return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getCustomLane } = require('./custom-lanes') as typeof import('./custom-lanes');
    const c = getCustomLane(laneId);
    if (!c) return undefined;
    return {
      id: c.id,
      label: c.label,
      shortLabel: c.shortLabel,
      model: c.model,
      costNote: c.costNote ?? 'Custom BYOK Lane',
      requires: {}, // custom 自带 key,不靠 keyStore 系统的 provider
      latencyHint: c.latencyHint ?? 'mid',
    };
  } catch {
    return undefined;
  }
}

// ─── 任务标签 ────────────────────────────────────────────────────────

export type TaskTag =
  | 'director.beat' // Director Agent 推进世界
  | 'npc.core.dialogue' // 核心 NPC 对话（Halia/Bao/重要角色）
  | 'npc.side.dialogue' // 次要 NPC 对话（路人 / 一次性）
  | 'companion.deep' // 队友深度对话 / 关系演进
  | 'companion.banter' // 队友闲聊 / 旁白评论
  | 'memory.consolidate' // 记忆固化 episodic → semantic
  | 'utility.summary' // 摘要 / 翻译 / 简短补全
  | 'utility.structured'; // JSON 提取 / 工具调用 / 结构化输出

export interface TaskDef {
  tag: TaskTag;
  label: string;
  description: string;
}

export const TASKS: TaskDef[] = [
  { tag: 'director.beat', label: 'Director 推进', description: '推进世界 / 时间线 / 关键事件' },
  { tag: 'npc.core.dialogue', label: '核心 NPC 对话', description: 'Halia / Bao / Mira / Echo 等' },
  { tag: 'npc.side.dialogue', label: '次要 NPC', description: '路人 / 一次性 NPC' },
  { tag: 'companion.deep', label: '队友深度', description: '关系演进 / 跨剧本一致性' },
  { tag: 'companion.banter', label: '队友闲聊', description: '日常 / 旁白评论' },
  { tag: 'memory.consolidate', label: '记忆固化', description: 'episodic → semantic' },
  { tag: 'utility.summary', label: '摘要/翻译', description: '简短补全' },
  { tag: 'utility.structured', label: '结构化输出', description: 'JSON 提取 / 工具调用' },
];

export const ALL_TASK_TAGS = TASKS.map((t) => t.tag);

// ─── 路由矩阵 + 预设 ───────────────────────────────────────────────

/** 任务 → Lane 的映射。 */
export type RoutingMatrix = Record<TaskTag, LaneId>;

export interface Preset {
  id: string;
  label: string;
  description: string;
  matrix: RoutingMatrix;
}

/**
 * 2026-05-17：用户决定 5 个 preset 当前都走同一套「Spark 主 + Gemma 兜路人/旁白」矩阵——
 *   - 6 个核心任务（director / NPC 核心 / companion 深度 / 记忆 / 工具）走 codex_spark_bridge
 *     （ChatGPT Pro Spark 独立池，1000 tok/s，截图当下 100% 闲置）
 *   - 2 个简单任务（路人对话、队友闲聊≈场景描述）走 local_gemma 省 Spark 配额
 * 5 个 preset 的 label/description 保留它们「未来想分化的方向」（等 Claude Agent SDK
 * 6-15 生效、DeepSeek key 填好后再激活）。想恢复 5 种独立策略，自己改 matrix 即可。
 */
const UNIFIED_MATRIX: RoutingMatrix = {
  'director.beat': 'codex_spark_bridge',
  'npc.core.dialogue': 'codex_spark_bridge',
  // 注意:classifyCharacter 把 scenario.defaultNpcId 之外所有剧本 NPC 都归 side
  // (datang/yuanmo/40k 都有几十个"重要 NPC"实际归 side)。所以 side 不能仅给 Gemma 4B,
  // 那样大部分主对话质量会塌。Gemma 留给 companion.banter / emotion-detect 这类真低价值短判断。
  'npc.side.dialogue': 'codex_spark_bridge',
  'companion.deep': 'codex_spark_bridge',
  'companion.banter': 'local_gemma', // 队友闲聊 / 旁白评论 ≈ 场景描述
  'memory.consolidate': 'codex_spark_bridge',
  'utility.summary': 'codex_spark_bridge',
  'utility.structured': 'codex_spark_bridge',
};

export const PRESETS: Preset[] = [
  {
    id: 'codex_first',
    label: 'Codex First',
    description: 'Spark 池跑剧情/记忆/工具 + Gemma 兜路人/旁白（当前默认）',
    matrix: UNIFIED_MATRIX,
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: '当前等同 Codex First；6-15 Claude Agent SDK 生效后改回 Claude 主 + Spark 兜底',
    matrix: UNIFIED_MATRIX,
  },
  {
    id: 'pure_local',
    label: 'Pure Local',
    description: '当前等同 Codex First；想全本地需手动把 matrix 全切到 local_gemma',
    matrix: UNIFIED_MATRIX,
  },
  {
    id: 'max_quality',
    label: 'Max Quality',
    description: '当前等同 Codex First；6-15 后切全 Claude 看上限',
    matrix: UNIFIED_MATRIX,
  },
  {
    id: 'budget',
    label: 'Budget',
    description: '当前等同 Codex First；填 DeepSeek key 后手动切全 DeepSeek',
    matrix: UNIFIED_MATRIX,
  },
];

export const DEFAULT_PRESET_ID = 'codex_first';

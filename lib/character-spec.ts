/**
 * Character Spec V4 — TS 类型
 * ===========================
 *
 * 跟 /tech/CharacterSpec-V4.schema.json 对齐。
 * 该规范用于跨剧本可携带的 NPC / 队友数据。
 *
 * PoC 阶段只用了:identity / core_persona / appearance / memory / meta。
 * 其它字段(skills_inventory / relationships / world_adaptation)保留在类型里,
 * 让卡数据可以无损存盘 + 后续启用。
 */

export interface CharacterSpec {
  spec_version: 'v4.0';
  /** 系统内唯一 ID。V4 schema 要求 uuid 格式,但 PoC 阶段允许 'starmail-npc-halia' 这样的可读 ID。 */
  character_id: string;
  identity: Identity;
  core_persona: CorePersona;
  appearance: Appearance;
  memory: Memory;
  skills_inventory?: SkillsInventory;
  relationships?: Relationships;
  world_adaptation?: WorldAdaptation;
  meta: Meta;
  /**
   * 动态剧本用:该 NPC 在剧本里出没的 location IDs(对应 scenario.locations[].id)。
   *   - 空 / 缺省 → 不参与 location 过滤,任何地点都可见(向后兼容、scenes 模式剧本)
   *   - 非空 → 仅当 plaza.currentLocation ∈ locations 时 NPC 可见
   * V4 schema 没正式纳入此字段,作为 PoC 扩展;后续 V5 schema 化时正式纳入。
   */
  locations?: string[];
  /**
   * 渐进式披露用:该 NPC 关心 / 知道哪些 lore 块(对应 scenario.loreChunks[].tags)。
   *   - 空 / 缺省 → 不主动注入分块 lore(NPC 只看 loreDigest;只有 chunks 标 'general' 才看)
   *   - 非空 → 注入所有 `chunk.tags ∩ npc.lore_tags ≠ ∅` 的块
   * 杨广只关心 ['sui'],婠婠 ['mojen', 'jianghu'],寇仲跨多 tag。
   */
  lore_tags?: string[];
}

export interface Identity {
  name: string;
  aliases?: string[];
  pronouns?: string;
  /** integer | 描述性字符串(如 "外观 20,实际制造年份不明") | null */
  age?: number | string | null;
  species?: string;
  /** null = 玩家从空白创建;填具体剧本 ID = 来自某剧本的 NPC */
  origin_world?: string | null;
  /** 'system' = 平台内置 NPC;u_xxx = 玩家自创 */
  creator_user_id?: string;
  created_at: string;
}

/**
 * NPC trust 变化档位。决定 WC-TRUST 标记的单次幅度上限,跟 NPC 性格挂钩。
 *
 * - `firebrand`:直爽豪迈 / 重义气 / 江湖儿女(可剧烈,±5~±7)
 * - `moderate`:中性文人 / 普通豪侠(典型 ±3,极端 ±5)
 * - `politician`:城府深 / 老练政客(大事 ±2,小事不变)
 * - `aloof`:极冷淡 / 修行者(±1 已是极限,大多数轮不写)
 * - `paranoid`:多疑 / 心机重 / 被骗过(单次小 ±1~±2,可累积但短期进不了高信任区)
 *
 * 缺省 → prompt 注入完整 5 档矩阵让 NPC 自己对照 traits 选档(向后兼容,但浪费 ~300B prompt)。
 * 显式设档 → 只注入该档 1 行,LLM 直接照用。
 */
export type TrustArchetype = 'firebrand' | 'moderate' | 'politician' | 'aloof' | 'paranoid';

export interface CorePersona {
  summary: string;
  traits: string[];
  values?: string[];
  fears?: string[];
  speech_style?: string;
  /** 硬约束:Director Agent 任何剧本里都必须尊重。 */
  no_go?: string[];
  /**
   * Trust 变化档位(可选,见 TrustArchetype)。设了 = WC-TRUST prompt 只注入该档 1 行;
   * 缺省 = 注入完整 5 档矩阵(向后兼容,但 prompt 多 ~300B)。
   */
  trust_archetype?: TrustArchetype;
}

export interface Appearance {
  description?: string;
  /** SDXL/Midjourney 等图生模型的基底 prompt。某些 NPC(如 The Voice)用 "[hidden ...]" 表示主线解锁前不可生图。 */
  base_prompt: string;
  negative_prompt?: string;
  style_preset?: string;
  portraits?: Portrait[];
  default_portrait_id?: string | null;
}

export interface Portrait {
  id: string;
  url: string;
  prompt: string;
  model?: string;
  /** "neutral" | "happy" | "fighting" | "spacesuit" 等 */
  context?: string;
  created_at?: string;
  user_uploaded?: boolean;
}

export interface Memory {
  episodic?: EpisodicMemory[];
  semantic?: SemanticMemory[];
  summary_chain?: SummaryChainEntry[];
}

export interface EpisodicMemory {
  id: string;
  world_id: string;
  scene: string;
  emotional_weight?: number;
  tags?: string[];
  timestamp_in_world?: string;
  real_timestamp?: string;
  faded?: boolean;
}

export interface SemanticMemory {
  key: string;
  value: string;
  source_episode_ids?: string[];
}

export interface SummaryChainEntry {
  world_id: string;
  chapter?: number | string;
  summary: string;
}

export interface SkillsInventory {
  cross_world_skills?: CrossWorldSkill[];
  world_specific_items?: WorldSpecificItem[];
  personal_traits_gained?: string[];
}

export interface CrossWorldSkill {
  id: string;
  name: string;
  /** 0-10 */
  level: number;
  learned_in_world?: string;
  transferable?: boolean;
  /** 各剧本下的具体表现 */
  manifestation?: Record<string, string>;
}

export interface WorldSpecificItem {
  id: string;
  name: string;
  world_id: string;
  exportable?: boolean;
  lore?: string;
}

export interface Relationships {
  with_player?: PlayerRelationship;
  with_other_companions?: CompanionRelationship[];
  /** worldId -> { npcId -> {relation, trust} } */
  with_npcs_per_world?: Record<string, Record<string, NpcRelationship>>;
}

export interface PlayerRelationship {
  trust?: number;
  affection?: number;
  key_moments?: string[];
}

export interface CompanionRelationship {
  companion_id: string;
  relation?: string;
  trust?: number;
}

export interface NpcRelationship {
  relation?: string;
  trust?: number;
}

export interface WorldAdaptation {
  /** 0 = 保持原貌;1 = 完全融入当前剧本 */
  global_adaptation_level?: number;
  per_world_overrides?: Record<
    string,
    {
      adaptation_level?: number;
      speech_adjustments?: string;
      appearance_overrides?: Record<string, string>;
    }
  >;
}

export interface Meta {
  spec_version: 'v4.0';
  compatible_with?: string[];
  license?: 'user_owned' | 'creator_shared' | 'marketplace_listed' | 'platform_curated';
  tradeable?: boolean;
  /** sha256 of canonical-form character data,反盗版用。PoC 阶段为空。 */
  fingerprint?: string;
  lineage?: {
    parent_character_ids?: string[];
    remixed_from?: string | null;
  };
}

// ── 工具:判断立绘是否可以自动生成 ──────────────────────────────────

/**
 * 某些 NPC 的 base_prompt 是 "[hidden until main story unlocks]" 这类占位,
 * 不应该直接喂给 SDXL。该函数返回 true 表示该 NPC 当前可以生成立绘。
 */
export function isPortraitGeneratable(char: CharacterSpec): boolean {
  const p = char.appearance.base_prompt?.trim() ?? '';
  if (!p) return false;
  if (p.startsWith('[') && p.endsWith(']')) return false; // [hidden ...] 风格的占位
  return true;
}

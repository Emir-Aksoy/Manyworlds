/**
 * Character Helper
 * =================
 *
 * 跨剧本角色查询 + 动态 system prompt 生成。
 * 替代 lib/halia.ts 里硬编码的 Halia—— 现在所有 NPC 走同一套 V4 接口。
 */

import type { CharacterSpec } from './character-spec';
import { isPortraitGeneratable } from './character-spec';
import { listScenarios, getScenario, type Scenario } from './scenarios';
import type {
  CompanionEntry,
  Item,
  NpcEpisodicMemory,
  NpcRelationship,
  NpcSummary,
} from './plaza';
import type { CombatStat } from './combat-stats';
import { assembleSystemPrompt } from './prompt-segments';

// ─── 查询 ──────────────────────────────────────────────────────────

/**
 * 全局所有 character(跨剧本)。
 * 注意:用 listScenarios() 而非 SCENARIOS 常量 —— listScenarios 会合并内置 + localStorage 自定义剧本,
 * 自定义剧本里的 NPC 才能被聊天系统查到。
 */
function allCharacters(): CharacterSpec[] {
  return listScenarios().flatMap((s) => s.npcs);
}

/**
 * 按 character_id 查 NPC。
 * G15:可选 scenarioId 用于消歧 — 当同一 character_id 跨剧本存在时,优先返回 scenarioId 里那个。
 * 不传 scenarioId 时退回到全局搜索(向后兼容)。
 */
export function getCharacter(characterId: string, scenarioId?: string): CharacterSpec | undefined {
  if (scenarioId) {
    const scoped = listScenarioCharacters(scenarioId).find((c) => c.character_id === characterId);
    if (scoped) return scoped;
  }
  return allCharacters().find((c) => c.character_id === characterId);
}

/** 反查:这个 character 属于哪个剧本(包括自定义剧本) */
export function findScenarioForCharacter(characterId: string): Scenario | undefined {
  return listScenarios().find((s) => s.npcs.some((c) => c.character_id === characterId));
}

export function listScenarioCharacters(scenarioId: string): CharacterSpec[] {
  return getScenario(scenarioId)?.npcs ?? [];
}

export { isPortraitGeneratable };

// ─── system prompt 生成 ────────────────────────────────────────────

export interface SystemPromptContext {
  /**
   * 旧字段:静态队友概况字符串。Phase A 仍然兼容(传入它就直接用)。
   * 新代码请用 activeCompanions/inventory/relationship/memories 让动态信息真正注入。
   */
  companionSummary?: string | null;
  /** 当前剧本 ID(用于挑选 world_adaptation overrides + 添加剧本情境) */
  scenarioId?: string;
  /** 当前场景情境(覆盖剧本默认开场,可由 Director / 用户提供) */
  sceneContext?: string;

  // ─── A2 跨剧本携带 ───
  /** 当前在场的队友(active=true)。注入到 system prompt 让 NPC 能感知。 */
  activeCompanions?: CompanionEntry[];
  /** 玩家携带的物品。被削弱的会在 prompt 里被标注"在此剧本失效"。 */
  inventory?: Item[];

  // ─── A3 记忆与关系 ───
  /** 跟此 NPC 的关系(trust + key_moments) */
  relationship?: NpcRelationship;
  /** 跟此 NPC 在本剧本(或跨剧本)的共同经历 */
  memories?: NpcEpisodicMemory[];
  /** G14:压缩后的早期对话摘要(跨 session 持久化) */
  summary?: NpcSummary;

  // ─── A1 剧情骨架 ───
  /** 当前 scene id;非空时 prompt 会描述当前所在场景而非剧本开场旁白 */
  currentSceneId?: string;
  /**
   * 动态剧本:玩家当前所在 location id(scenario.locations[].id)。
   * 非空时 prompt 会注入"# 当前地点"段 + WC-EVENT location-changed 规则。
   * 空 = 不启用 location 机制(scenes 模式剧本 / 静态剧本)。
   */
  currentLocation?: string | null;

  // ─── 世界控制三件套(plaza 计算,prompt-segments 的 buildContext 注入)──
  /**
   * 当前 location 的环境状态覆盖(仅 plaza overrides 那一份)。
   * buildContext 合并 scenario.locations[…].sceneState 初始值后注入。
   * 缺省 → 视为 {}。
   */
  currentSceneStateOverrides?: Record<string, string>;
  /**
   * 当前剧本已发现的 artifact id 集合;buildContext 把已发现的从"可调查"列表中扣掉。
   * 缺省 → 视为 [](等价于"什么都没发现")。
   */
  discoveredArtifactIds?: string[];
  /**
   * 玩家在当前 location 的累计到访次数(prompt"已到访 N 次"提示;beat.trigger.visitCount 判定)。
   * 缺省 → 0(不在 location 也是 0)。
   */
  currentLocationVisitCount?: number;
  /**
   * 当前剧本已完成的 beat ids(artifact.requiresCompletedBeats 判定可见性 + Director 路径 beat.trigger 评估)。
   * 缺省 → [](等价于"还没完成任何 beat")。
   */
  completedBeatIds?: string[];

  // ─── I-series:玩家真实身份 + 入境模式 + 愿望 ───
  /**
   * 玩家是谁(NPC prompt 注入用)。
   * - mode='soul':玩家化身为本剧本预设的角色(scenario.playerSoulIdentity)
   * - mode='body':玩家保留基础身份,作"来自异世界的访客"闯入
   * NPC 看到此段后,称呼玩家时应使用 displayName。
   */
  playerIdentity?: {
    mode: 'soul' | 'body';
    /** NPC 应该用来称呼玩家的名字 */
    displayName: string;
    gender: 'male' | 'female' | 'other' | 'unspecified';
    /** 0 = 未知/不重要(prompt 里跳过年龄) */
    age: number;
    /** 完整身份描述给 NPC 看(2-4 句) */
    background: string;
    /** body 模式特有的"穿越背景"(M4 LLM 生成,可能为空) */
    bodyEntryContext?: string;
  };

  /**
   * 玩家入境时提的愿望 + 命运批准结果。
   * 半透明语义:玩家只知道总共批准了几个;NPC 这里能看到具体内容(granted)+ 没被批准的(denied)。
   * NPC 不应主动说破"我看到你的愿望被命运批准了" — 但可以让被批准的愿望在剧情里逐步成真。
   */
  wishes?: {
    granted: string[];
    denied: string[];
  };

  /**
   * 隐藏数值系统:主角 + 携带队友的 HP/体力/意志。
   * key 'player' = 主角,其他 key = companion characterId。
   * LLM 看到精确数字 + tier,据此调整叙事语气;玩家看不到。
   * 空对象 / undefined = 不注入此段(剧本无战斗 / 数值未启用)。
   */
  combatStats?: Record<string, CombatStat>;

  /**
   * E 方案(渐进披露 — turn 重要性门控):当前对话回合的"重要性"。
   *   - 'engaged'(默认):普通战斗 / 关键剧情 / 携带敏感 ctx → wc-event 段完整输出
   *   - 'casual':闲聊 / 短消息 / 无 ctx 变化 → wc-event 段折叠(只留 WC-TRUST + 必需的 location/milestone)
   * 由 caller (page.tsx:send) 按 heuristic 决定;Director 路径一律 engaged。
   * 缺省 → 'engaged'(向后兼容)。
   */
  chatMode?: 'engaged' | 'casual';
}

/**
 * 根据 CharacterSpec V4 数据动态生成扮演 system prompt。
 * 根据 CharacterSpec V4 数据动态生成扮演 system prompt,适配任意 NPC。
 */
export function buildSystemPromptForCharacter(
  char: CharacterSpec,
  ctx: SystemPromptContext = {},
): string {
  // 重剧本轻框架:具体段拼装在 lib/prompt-segments.ts (10 段 builder + 补丁式 disabled/insert)。
  // 本函数只负责解析 scenario + adaptation 并调用 assembleSystemPrompt。
  const scenario = ctx.scenarioId
    ? getScenario(ctx.scenarioId)
    : findScenarioForCharacter(char.character_id);
  const adaptation = ctx.scenarioId
    ? char.world_adaptation?.per_world_overrides?.[ctx.scenarioId]
    : undefined;
  return assembleSystemPrompt({
    char,
    scenario,
    ctx,
    adaptation,
  });
}

// helper(describeGenderAge / formatTrust / isImportantItem)已搬到 lib/prompt-segments.ts。

// ─── Director 用:可用 NPC 列表 ─────────────────────────────────────

/**
 * 给 Director Agent 看的"当前剧本可用 NPC 池"摘要。Director 在产出
 * narration 时只能从这里挑 NPC 登场,不要凭空捏造新角色(否则生不出图)。
 */
export function buildScenarioNpcRoster(scenarioId: string): string {
  const npcs = listScenarioCharacters(scenarioId);
  if (npcs.length === 0) return '(该剧本暂无 NPC)';
  return npcs
    .map((n) => {
      const tags = n.core_persona.traits.slice(0, 3).join('、');
      const oneLiner = n.core_persona.summary.slice(0, 60).replace(/\s+/g, ' ');
      return `- ${n.identity.name}(${tags}): ${oneLiner}…`;
    })
    .join('\n');
}

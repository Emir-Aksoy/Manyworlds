/**
 * 角色分级 + 存储上限
 * ====================
 *
 * 不同角色对玩家的重要程度不同,占用的存储配额也应该不同。
 *
 * 3 档:
 *   - core:核心角色(剧本 defaultNpcId、active 队友、玩家本人)— 配额高
 *   - side:支线 NPC(出现在 scene.presentNpcIds 但不是 default)— 配额中
 *   - passing:路人 / 只在 npcRoster 里露过名字的 NPC — 配额低
 *
 * 每档分别管:
 *   - 对话消息条数上限
 *   - 立绘情绪数(超出按 LRU 淘汰非 neutral)
 *   - 记忆条目数(npcMemories 上限,原来固定 30 现在按 tier)
 *
 * 80% 触发软压缩 — 比硬撑到爆要早,给系统留余地。
 */

import type { Scenario } from './scenarios';

export type CharacterTier = 'core' | 'side' | 'passing';

export interface TierConfig {
  /** 对话历史每角色保留多少条 message(超过则触发压缩,把最老的 N 条摘要成 1 段 summary) */
  messagesMax: number;
  /** 立绘情绪上限(5 种全开 = 5,passing 只留 neutral) */
  emotionsMax: number;
  /** plaza.npcMemories 每角色上限 */
  memoriesMax: number;
}

export const TIER_CONFIGS: Record<CharacterTier, TierConfig> = {
  core: {
    messagesMax: 80,
    emotionsMax: 5, // 5 种情绪全开
    memoriesMax: 40,
  },
  side: {
    messagesMax: 40,
    emotionsMax: 3, // neutral + 2 个最常出现的
    memoriesMax: 20,
  },
  passing: {
    messagesMax: 20,
    emotionsMax: 1, // 只 neutral
    memoriesMax: 10,
  },
};

/** 80% 软压缩门槛 — 达到这个就开始压缩,而不是撑到 100% 才报错 */
export const COMPRESSION_TRIGGER = 0.8;

/**
 * 判断"是否到了压缩门槛"。
 * @param current 当前数量
 * @param max 该 tier 的上限
 * @param ratio 触发比例(0-1),缺省 = COMPRESSION_TRIGGER (0.8)
 * @returns true = 达到比例,应该压缩
 */
export function shouldCompress(current: number, max: number, ratio: number = COMPRESSION_TRIGGER): boolean {
  return current >= Math.floor(max * ratio);
}

/**
 * 应用剧本级 llmConfig 覆盖,产出"该 tier 在此剧本下的有效配置"。
 *
 *   - llmConfig.historyLimit:覆盖 messagesMax(影响聊天历史保留 + 压缩触发)
 *   - 其它 tier 字段(emotionsMax / memoriesMax)目前剧本不可覆盖
 *
 * core / side / passing 都吃同一个 historyLimit 覆盖 — 重剧本要的是"全档拉长"。
 * 想分档差异化,等真有需求再加 perTier override。
 */
export function effectiveTierConfig(
  tier: CharacterTier,
  scenario: Scenario | undefined,
): TierConfig {
  const base = TIER_CONFIGS[tier];
  const override = scenario?.llmConfig?.historyLimit;
  if (typeof override !== 'number' || override <= 0) return base;
  return { ...base, messagesMax: override };
}

/**
 * 给一个角色判断 tier。
 *
 * 规则(优先级从高到低):
 *  - companion-xxx 始终 core(队友是玩家最重要的同行者)
 *  - player-self 始终 core
 *  - scenario.defaultNpcId 始终 core(剧本主 NPC)
 *  - scene.presentNpcIds 包含 → side(场景核心 NPC)
 *  - 剧本 npcs 包含但不是上述 → side(剧本登记的 NPC 都算 side,不要太苛刻)
 *  - 都不是 → passing(陌生角色,路人 / 一次性)
 */
export function classifyCharacter(
  characterId: string,
  scenario: Scenario | undefined,
  scene?: { presentNpcIds?: string[] } | undefined,
): CharacterTier {
  if (characterId === 'player-self') return 'core';
  if (characterId.startsWith('companion-')) return 'core';
  if (!scenario) return 'passing';
  if (characterId === scenario.defaultNpcId) return 'core';
  if (scene?.presentNpcIds?.includes(characterId)) return 'side';
  if (scenario.npcs.some((n) => n.character_id === characterId)) return 'side';
  return 'passing';
}

/** 拿配置 — 便捷 wrapper。自动应用剧本 llmConfig.historyLimit override。 */
export function tierConfigFor(
  characterId: string,
  scenario: Scenario | undefined,
  scene?: { presentNpcIds?: string[] } | undefined,
): TierConfig {
  return effectiveTierConfig(classifyCharacter(characterId, scenario, scene), scenario);
}

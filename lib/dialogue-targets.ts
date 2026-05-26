/**
 * 对话对象 (Dialogue Targets)
 * ============================
 *
 * 新模型:玩家可以对"身边的任何角色"说话,包括:
 *   - 当前剧本/scene 在场的 NPC
 *   - 跟着自己的 active 队友(companion-xxx)
 *
 * 这个模块负责:
 *   1. 把 CompanionEntry 适配成 CharacterSpec(让 buildSystemPromptForCharacter 能直接吃)
 *   2. 计算"身边角色列表" — 综合 scene.presentNpcIds + active companions
 *   3. 统一查找:getDialogueTarget(id) 找 NPC 找不到时回退 companion
 *
 * 设计原则:NPC 和 companion 在对话层面是同一类对象,只是 prompt 时多一句"你是玩家的队友"。
 */

import type { CharacterSpec } from './character-spec';
import { listScenarioCharacters } from './characters';
import { getScenario, getScene, type Scene } from './scenarios';
import type { CompanionEntry } from './plaza';
import { plaza } from './plaza';

// ─── companion → CharacterSpec 适配 ────────────────────────────────

/**
 * 把 CompanionEntry 转成 CharacterSpec V4,让对话系统统一处理。
 * 队友没有 SDXL base_prompt(立绘是用户导入的图),所以 appearance.base_prompt
 * 用 [companion ...] 占位 → isPortraitGeneratable 会返 false,不会触发 SDXL。
 * 立绘的实际加载走 plaza profile.images(在 page.tsx 那边分支处理)。
 */
export function companionToCharacterSpec(c: CompanionEntry): CharacterSpec {
  const shortName = c.profile.characterId.replace(/^companion-/, '');
  return {
    spec_version: 'v4.0',
    character_id: c.profile.characterId,
    identity: {
      name: shortName,
      created_at: c.joinedAt,
      origin_world: null,
      creator_user_id: 'user-self',
    },
    core_persona: {
      summary: c.profile.description || '(无描述)',
      traits: [],
      // 把 mentalState 当成 fears/values 给 Director 看(不公开给玩家)
      // 这里塞 summary 已经包含心理描述,不再重复
    },
    appearance: {
      base_prompt: `[companion ${shortName} — uses imported portrait]`,
      description: c.profile.description || undefined,
    },
    memory: {},
    meta: { spec_version: 'v4.0' },
  };
}

/**
 * 判断 character_id 是否是 companion(约定:以 'companion-' 开头)。
 * 严格的判断要走 plaza.companions 列表查,但 PoC 阶段约定 ID 前缀够用。
 */
export function isCompanionId(characterId: string): boolean {
  return characterId.startsWith('companion-');
}

// ─── 身边角色查询 ──────────────────────────────────────────────────

/** 对话目标的统一表示:可以是 NPC,也可以是 companion。 */
export interface DialogueTarget {
  /** character_id */
  id: string;
  /** 显示名 */
  name: string;
  /** NPC 或队友 */
  kind: 'npc' | 'companion';
  /** 标准化后的 CharacterSpec(companion 走 adapter 出来) */
  spec: CharacterSpec;
  /** 一句话简介(给 selector tooltip 用) */
  oneLiner: string;
}

/**
 * 查单个对话目标(先查剧本 NPC,再查 active companion)。
 * 找不到返回 undefined。
 */
export function getDialogueTarget(characterId: string, scenarioId?: string): DialogueTarget | undefined {
  // 1. 试 NPC
  if (scenarioId) {
    const npc = listScenarioCharacters(scenarioId).find((c) => c.character_id === characterId);
    if (npc) {
      return {
        id: npc.character_id,
        name: npc.identity.name,
        kind: 'npc',
        spec: npc,
        oneLiner: npc.core_persona.summary.slice(0, 80),
      };
    }
  }
  // 2. 试 companion — F12:只允许 active 队友(玩家把队友 toggle 成休眠时 UI 不该还能跟他说话)
  const companion = plaza.get().companions.find(
    (c) => c.characterId === characterId && c.active,
  );
  if (companion) {
    const spec = companionToCharacterSpec(companion);
    return {
      id: spec.character_id,
      name: spec.identity.name,
      kind: 'companion',
      spec,
      oneLiner: companion.profile.description.slice(0, 80),
    };
  }
  return undefined;
}

/**
 * 列出"身边可对话的角色":当前 scene/location 在场的 NPC + active companions。
 *
 * NPC 过滤三档(按优先级):
 *   1. scene.presentNpcIds 存在(scenes 模式)→ 只列这些 NPC(C4 "身边"语义)
 *   2. currentLocation + scenario.locations 都有(动态剧本模式)→
 *        过滤 NPC.locations 包含 currentLocation 的;NPC.locations 缺省/空 = 无差别可见(江湖游侠)
 *   3. 都没有 → 剧本所有 NPC(老行为,静态剧本)
 *
 * 永远追加 active companions(玩家可以随时跟自己的队友说话)。
 *
 * 防御:任何过滤后空 → fallback 到剧本全部 NPC,避免空 selector。
 */
export function listNearbyTargets(
  scenarioId: string,
  currentScene: Scene | undefined,
  currentLocation?: string | null,
): DialogueTarget[] {
  const out: DialogueTarget[] = [];
  const scenario = getScenario(scenarioId);
  const allNpcs = scenario?.npcs ?? [];

  // 1. NPC 池过滤
  let presentNpcs = allNpcs;
  if (currentScene?.presentNpcIds && currentScene.presentNpcIds.length > 0) {
    // 档1: scenes 模式
    const allowed = new Set(currentScene.presentNpcIds);
    presentNpcs = allNpcs.filter((n) => allowed.has(n.character_id));
    if (presentNpcs.length === 0) presentNpcs = allNpcs; // 防御兜底
  } else if (currentLocation && scenario?.locations && scenario.locations.length > 0) {
    // 档2: 动态剧本 location 过滤
    presentNpcs = allNpcs.filter((n) => {
      // NPC 无 locations 字段 → 视为"江湖游侠",任何地点可见
      if (!n.locations || n.locations.length === 0) return true;
      return n.locations.includes(currentLocation);
    });
    if (presentNpcs.length === 0) presentNpcs = allNpcs;
  }
  // 档3: 否则 presentNpcs = allNpcs(初始值)

  for (const npc of presentNpcs) {
    out.push({
      id: npc.character_id,
      name: npc.identity.name,
      kind: 'npc',
      spec: npc,
      oneLiner: npc.core_persona.summary.slice(0, 80),
    });
  }

  // 2. 加上 active companions(永远在场)
  const state = plaza.get();
  for (const c of state.companions) {
    if (!c.active) continue;
    out.push({
      id: c.profile.characterId,
      name: c.profile.characterId.replace(/^companion-/, ''),
      kind: 'companion',
      spec: companionToCharacterSpec(c),
      oneLiner: c.profile.description.slice(0, 80),
    });
  }

  return out;
}

/**
 * 自定义剧本存储 (localStorage)
 * ==============================
 *
 * 区分两种剧本来源:
 *   - DLC 剧本(public/dlc/*.json):由 dlc.ts 启动时 fetch + register 到内存 registry
 *   - 自定义剧本(localStorage):本模块负责。用户运行时通过两种方式产生:
 *       1. 粘贴 / 上传 JSON 文件导入
 *       2. 从小说 / 影视剧片段 LLM 分析生成
 *     落地到 localStorage,跨 session 保留。
 *
 * 跟 DLC 剧本走同一份 Scenario 接口,在 listScenarios() 里合并显示
 * (DLC 在前,custom 在后)。
 *
 * 校验函数 `validateScenario` 被两个 caller 共用:
 *   - 本模块的 addCustomScenario(用户上传/生成时)
 *   - dlc.ts 的 registerOne(DLC fetch 后校验)
 */

import type { CharacterSpec, TrustArchetype } from '../character-spec';
import type {
  Scenario,
  Scene,
  Beat,
  BeatTrigger,
  ScenarioDifficulty,
  PlayerSoulIdentity,
  ScenarioLocation,
  LocationArtifact,
  ScenarioLlmConfig,
  ScenarioPromptSegments,
  SegmentId,
  LoreChunk,
} from './index';
import { ALL_SEGMENT_IDS } from './index';
import type { MagicSystem } from '../plaza';

const TRUST_ARCHETYPES: ReadonlySet<TrustArchetype> = new Set([
  'firebrand',
  'moderate',
  'politician',
  'aloof',
  'paranoid',
]);

const CUSTOM_KEY = 'wc_poc_custom_scenarios_v1';

// ─── 存储 IO ──────────────────────────────────────────────────────

export function listCustomScenarios(): Scenario[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => isProbablyScenario(s)) as Scenario[];
  } catch {
    return [];
  }
}

/**
 * 上次 writeCustomScenarios 失败信息(localStorage 配额溢出最常见)。
 * S4 修复:不再静默吞错。
 */
let lastCustomWriteError: string | null = null;
export function getCustomWriteError(): string | null {
  return lastCustomWriteError;
}
export function clearCustomWriteError() {
  lastCustomWriteError = null;
}

function writeCustomScenarios(list: Scenario[]): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
    lastCustomWriteError = null;
    return true;
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    lastCustomWriteError = `自定义剧本保存失败(${msg})。可能 localStorage 已满。`;
    if (typeof console !== 'undefined') console.error('[custom-scenarios] write failed:', e);
    return false;
  }
}

export function getCustomScenario(id: string): Scenario | undefined {
  return listCustomScenarios().find((s) => s.id === id);
}

export type AddResult = { ok: true; scenario: Scenario } | { ok: false; errors: string[] };

export function addCustomScenario(s: Scenario, opts: { overwrite?: boolean } = {}): AddResult {
  const v = validateScenario(s);
  if (!v.ok) return { ok: false, errors: v.errors };
  const list = listCustomScenarios();
  const exists = list.findIndex((x) => x.id === v.scenario.id);
  if (exists >= 0 && !opts.overwrite) {
    return { ok: false, errors: [`已存在 id "${v.scenario.id}",勾选覆盖再保存`] };
  }
  let ok: boolean;
  if (exists >= 0) {
    const next = [...list];
    next[exists] = v.scenario;
    ok = writeCustomScenarios(next);
  } else {
    ok = writeCustomScenarios([...list, v.scenario]);
  }
  // S4 修复:写入失败时把错误也带出去,UI 才能提示用户
  if (!ok) {
    return {
      ok: false,
      errors: [lastCustomWriteError ?? '保存到 localStorage 失败(未知原因)'],
    };
  }
  return { ok: true, scenario: v.scenario };
}

export function removeCustomScenario(id: string) {
  writeCustomScenarios(listCustomScenarios().filter((s) => s.id !== id));
}

// ─── 验证 / 规范化 ─────────────────────────────────────────────────

const MAGIC_SET: ReadonlySet<MagicSystem> = new Set([
  'tech',
  'magic',
  'psionic',
  'qi',
  'divine',
  'cosmic',
]);

/** 弱判断 (用于 listCustomScenarios 过滤损坏数据)。 */
function isProbablyScenario(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    Array.isArray(o.npcs) &&
    o.npcs.length > 0
  );
}

export type ValidateResult =
  | { ok: true; scenario: Scenario }
  | { ok: false; errors: string[] };

/**
 * 严格验证 + 字段补全。
 *
 * 必须:
 *   id / name / npcs[] (≥1) / defaultNpcId (要么留空我们用第一个 NPC,要么必须存在于 npcs)
 *   每个 NPC: character_id + identity.name
 *
 * 可选字段缺了走默认值。
 */
export function validateScenario(raw: unknown): ValidateResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['剧本必须是 JSON 对象'] };
  }
  const o = raw as Record<string, unknown>;

  // ── id ──
  if (typeof o.id !== 'string' || !o.id.trim()) {
    errors.push('id 必填(英文小写连字符,如 "ancient-tea-house")');
  } else if (!/^[a-z0-9-]+$/.test(o.id)) {
    errors.push(`id "${o.id}" 含非法字符,只允许小写字母/数字/连字符`);
  }

  // ── name ──
  if (typeof o.name !== 'string' || !o.name.trim()) {
    errors.push('name 必填(显示名,中文)');
  }

  // ── npcs ──
  if (!Array.isArray(o.npcs) || o.npcs.length === 0) {
    errors.push('npcs 必填,至少 1 个 NPC');
  }

  if (errors.length > 0) return { ok: false, errors };

  // ── 规范化 NPCs ──
  const scenarioId = o.id as string;
  const requiredPrefix = `${scenarioId}-npc-`;
  const npcsIn = o.npcs as unknown[];
  const npcs: CharacterSpec[] = [];
  const npcIds = new Set<string>();
  npcsIn.forEach((nRaw, i) => {
    if (!nRaw || typeof nRaw !== 'object') {
      errors.push(`npcs[${i}] 不是对象`);
      return;
    }
    const n = nRaw as Record<string, unknown>;
    let cid = typeof n.character_id === 'string' ? n.character_id : '';
    if (!cid || !/^[a-z0-9-]+$/.test(cid)) {
      errors.push(`npcs[${i}].character_id 必填(kebab-case)`);
      return;
    }
    // M2 修复:强制 NPC id 带剧本前缀,避免跟内置 NPC(如 starmail-npc-halia)撞 key
    if (!cid.startsWith(requiredPrefix)) {
      // 自动补前缀(若已是 kebab-case 名字直接拼)而不是直接拒绝,体验更友好
      const slug = cid.replace(/^npc-/, ''); // 去掉常见的 "npc-" 多余前缀
      cid = `${requiredPrefix}${slug}`;
    }
    if (npcIds.has(cid)) {
      errors.push(`npcs[${i}].character_id "${cid}" 重复`);
      return;
    }
    npcIds.add(cid);

    const identity = (n.identity ?? {}) as Record<string, unknown>;
    if (typeof identity.name !== 'string' || !identity.name.trim()) {
      errors.push(`npcs[${i}].identity.name 必填`);
      return;
    }

    const core = (n.core_persona ?? {}) as Record<string, unknown>;
    const appearance = (n.appearance ?? {}) as Record<string, unknown>;

    const NOW_ISO = new Date().toISOString();
    npcs.push({
      spec_version: 'v4.0',
      character_id: cid,
      identity: {
        name: identity.name as string,
        aliases: Array.isArray(identity.aliases) ? (identity.aliases as unknown[]).filter(isStr) : undefined,
        pronouns: isStr(identity.pronouns) ? identity.pronouns : undefined,
        age:
          typeof identity.age === 'number' || typeof identity.age === 'string'
            ? (identity.age as number | string)
            : undefined,
        species: isStr(identity.species) ? identity.species : undefined,
        origin_world: isStr(identity.origin_world) ? identity.origin_world : (o.id as string),
        creator_user_id: isStr(identity.creator_user_id) ? identity.creator_user_id : 'system',
        created_at: isStr(identity.created_at) ? identity.created_at : NOW_ISO,
      },
      core_persona: {
        summary: isStr(core.summary) ? core.summary : '',
        traits: Array.isArray(core.traits) ? (core.traits as unknown[]).filter(isStr) : [],
        values: Array.isArray(core.values) ? (core.values as unknown[]).filter(isStr) : undefined,
        fears: Array.isArray(core.fears) ? (core.fears as unknown[]).filter(isStr) : undefined,
        speech_style: isStr(core.speech_style) ? core.speech_style : undefined,
        no_go: Array.isArray(core.no_go) ? (core.no_go as unknown[]).filter(isStr) : undefined,
        // D 方案:NPC trust 档,落地到 prompt 段精简 5 档矩阵为 1 行
        trust_archetype:
          isStr(core.trust_archetype) && TRUST_ARCHETYPES.has(core.trust_archetype as TrustArchetype)
            ? (core.trust_archetype as TrustArchetype)
            : undefined,
      },
      appearance: {
        description: isStr(appearance.description) ? appearance.description : undefined,
        base_prompt: isStr(appearance.base_prompt) ? appearance.base_prompt : '',
        negative_prompt: isStr(appearance.negative_prompt) ? appearance.negative_prompt : undefined,
        style_preset: isStr(appearance.style_preset) ? appearance.style_preset : undefined,
        portraits: Array.isArray(appearance.portraits) ? (appearance.portraits as []) : [],
        default_portrait_id: null,
      },
      // memory 必填(里面字段都可选),缺了给空骨架
      memory:
        n.memory && typeof n.memory === 'object'
          ? (n.memory as CharacterSpec['memory'])
          : { episodic: [], semantic: [], summary_chain: [] },
      skills_inventory:
        n.skills_inventory && typeof n.skills_inventory === 'object'
          ? (n.skills_inventory as CharacterSpec['skills_inventory'])
          : undefined,
      relationships:
        n.relationships && typeof n.relationships === 'object' && !Array.isArray(n.relationships)
          ? (n.relationships as CharacterSpec['relationships'])
          : undefined,
      world_adaptation:
        n.world_adaptation && typeof n.world_adaptation === 'object'
          ? (n.world_adaptation as CharacterSpec['world_adaptation'])
          : undefined,
      meta: {
        spec_version: 'v4.0',
        license: 'user_owned',
        tradeable: false,
      },
      // 动态剧本:该 NPC 出没的地点 ids(kebab-case)。空/缺省 → 不参与过滤
      locations: Array.isArray(n.locations)
        ? (n.locations as unknown[]).filter(
            (l): l is string => typeof l === 'string' && /^[a-z0-9-]+$/.test(l),
          )
        : undefined,
      // B 方案:该 NPC 关心的 lore tags。空/缺省 → 只看 loreDigest 跟 general chunks
      lore_tags: Array.isArray(n.lore_tags)
        ? (n.lore_tags as unknown[]).filter(
            (t): t is string => typeof t === 'string' && /^[a-z0-9-]+$/.test(t),
          )
        : undefined,
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  if (npcs.length === 0) return { ok: false, errors: ['没有有效 NPC'] };

  // ── defaultNpcId ──
  let defaultNpcId =
    typeof o.defaultNpcId === 'string' && o.defaultNpcId ? o.defaultNpcId : npcs[0].character_id;
  // M2 修复:用户/LLM 可能写短名(如 "halia"),自动补 `<scenarioId>-npc-` 前缀对齐 NPC id
  if (!npcIds.has(defaultNpcId) && !defaultNpcId.startsWith(requiredPrefix)) {
    const slug = defaultNpcId.replace(/^npc-/, '');
    const fixed = `${requiredPrefix}${slug}`;
    if (npcIds.has(fixed)) defaultNpcId = fixed;
  }
  if (!npcIds.has(defaultNpcId)) {
    errors.push(`defaultNpcId "${defaultNpcId}" 不在 npcs 中(NPC ids: ${[...npcIds].join(', ')})`);
    return { ok: false, errors };
  }

  // ── entryCost ──
  const entryCost =
    typeof o.entryCost === 'number' && o.entryCost >= 0 ? Math.floor(o.entryCost) : 30;

  // ── magicTags ──
  let magicTags: MagicSystem[] | undefined;
  if (Array.isArray(o.magicTags)) {
    magicTags = (o.magicTags as unknown[]).filter(
      (t): t is MagicSystem => typeof t === 'string' && MAGIC_SET.has(t as MagicSystem),
    );
    if (magicTags.length === 0) magicTags = undefined;
  }

  // ── forceReward ──
  let forceReward: { min: number; max: number } = { min: 30, max: 100 };
  if (o.forceReward && typeof o.forceReward === 'object') {
    const fr = o.forceReward as Record<string, unknown>;
    const min = typeof fr.min === 'number' ? Math.max(0, Math.floor(fr.min)) : 30;
    const max = typeof fr.max === 'number' ? Math.max(min, Math.floor(fr.max)) : Math.max(min, 100);
    forceReward = { min, max };
  }

  // ── scenes (剧情骨架,可选;空时退化到"自由 advance"模式) ──
  let scenes: Scene[] | undefined;
  let startSceneId: string | undefined;
  if (Array.isArray(o.scenes) && o.scenes.length > 0) {
    const parsedScenes = normalizeScenes(o.scenes, scenarioId);
    if (parsedScenes.errors.length > 0) {
      errors.push(...parsedScenes.errors);
      return { ok: false, errors };
    }
    if (parsedScenes.scenes.length > 0) {
      scenes = parsedScenes.scenes;
      const declaredStart = typeof o.startSceneId === 'string' ? o.startSceneId : null;
      startSceneId = declaredStart && scenes.some((s) => s.id === declaredStart)
        ? declaredStart
        : scenes[0].id;
    }
  }

  // ── difficulty (I-series 新增,DLC 化前漏处理过 — 现在补上)──
  let difficulty: ScenarioDifficulty | undefined;
  if (o.difficulty === 'easy' || o.difficulty === 'normal' || o.difficulty === 'hard') {
    difficulty = o.difficulty;
  }

  // ── locations (动态剧本新增,scenes 互斥)─────────────────────
  let locations: ScenarioLocation[] | undefined;
  let initialLocation: string | undefined;
  if (Array.isArray(o.locations) && o.locations.length > 0) {
    const seenLocIds = new Set<string>();
    const parsed: ScenarioLocation[] = [];
    o.locations.forEach((rawLoc: unknown, idx: number) => {
      if (!rawLoc || typeof rawLoc !== 'object') {
        errors.push(`locations[${idx}] 不是对象`);
        return;
      }
      const l = rawLoc as Record<string, unknown>;
      const lid = typeof l.id === 'string' ? l.id : '';
      if (!lid || !/^[a-z0-9-]+$/.test(lid)) {
        errors.push(`locations[${idx}].id 必填(kebab-case)`);
        return;
      }
      if (seenLocIds.has(lid)) {
        errors.push(`locations[${idx}].id "${lid}" 重复`);
        return;
      }
      seenLocIds.add(lid);
      parsed.push({
        id: lid,
        name: typeof l.name === 'string' && l.name ? l.name : lid,
        description: typeof l.description === 'string' ? l.description : '',
        connections: parseKebabIdList(l.connections),
        capacity:
          typeof l.capacity === 'number' && Number.isFinite(l.capacity) && l.capacity > 0
            ? Math.floor(l.capacity)
            : undefined,
        sceneState: parseSceneState(l.sceneState),
        artifacts: parseLocationArtifacts(l.artifacts),
      });
    });
    if (errors.length > 0) return { ok: false, errors };
    if (parsed.length > 0) {
      locations = parsed;
      const declared = typeof o.initialLocation === 'string' ? o.initialLocation : null;
      initialLocation =
        declared && parsed.some((l) => l.id === declared) ? declared : parsed[0].id;
    }
  }
  // 目标 milestone 数(动态完成度用,缺省时 computeCompletion 落回 0.5)
  const targetMilestones =
    typeof o.targetMilestones === 'number' &&
    Number.isFinite(o.targetMilestones) &&
    o.targetMilestones > 0
      ? Math.floor(o.targetMilestones)
      : undefined;

  // ── playerSoulIdentity (I-series 新增,DLC 化前漏处理过 — 现在补上)──
  // 缺失或字段不全 → undefined,UI 会自动 fallback 到 body-only 模式
  let playerSoulIdentity: PlayerSoulIdentity | undefined;
  if (o.playerSoulIdentity && typeof o.playerSoulIdentity === 'object') {
    const ps = o.playerSoulIdentity as Record<string, unknown>;
    if (isStr(ps.name) && ps.name.trim() && isStr(ps.background) && ps.background.trim()) {
      const gender =
        ps.gender === 'male' || ps.gender === 'female' || ps.gender === 'other'
          ? ps.gender
          : undefined;
      const age =
        typeof ps.age === 'number' && Number.isFinite(ps.age) && ps.age > 0 && ps.age < 200
          ? Math.floor(ps.age)
          : undefined;
      playerSoulIdentity = {
        name: ps.name.trim(),
        gender,
        age,
        background: ps.background.trim(),
      };
    }
  }

  // ── llmConfig (重剧本轻框架,可选)──
  const llmConfig = parseLlmConfig(o.llmConfig);

  // ── promptSegments (重剧本轻框架,可选)──
  const promptSegments = parsePromptSegments(o.promptSegments);

  // ── loreDigest (渐进式披露,可选)──
  // 给 LLM 的世界观浓缩,强约束 ≤500 字。超长 → 截断 + 加省略号,不报错(避免坏 DLC 卡掉整个剧本)
  let loreDigest: string | undefined;
  if (isStr(o.loreDigest) && o.loreDigest.trim()) {
    const trimmed = o.loreDigest.trim();
    loreDigest = trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 497)}...`;
  }

  // ── loreChunks (B 方案:按 NPC tag 注入的 lore 分块,可选)──
  const loreChunks = parseLoreChunks(o.loreChunks);

  // ── dynamicLocations (运行时扩展能力声明,可选)──
  const dynamicLocations = parseDynamicLocationsConfig(o.dynamicLocations, o.id as string);

  // ── 二次交叉校验(connections / trigger 跨字段引用是否成立)──
  // 全 warn 不 fail：保持 DLC 韧性,坏引用不至于卡掉整个剧本(参考 nextSceneId 的处理风格)
  const locIds = new Set((locations ?? []).map((l) => l.id));
  const allArtifactIds = new Set<string>();
  const allBeatIds = new Set<string>();
  if (scenes) for (const s of scenes) for (const b of s.beats) allBeatIds.add(b.id);
  for (const loc of locations ?? []) {
    for (const art of loc.artifacts ?? []) allArtifactIds.add(art.id);
    if (loc.connections) {
      const bad = loc.connections.filter((c) => !locIds.has(c));
      if (bad.length > 0)
        console.warn(
          `[validateScenario:${o.id}] location "${loc.id}".connections 引用不存在的 location: ${bad.join(', ')}`,
        );
    }
    for (const art of loc.artifacts ?? []) {
      // 动态剧本没有声明式 beat 列表,requiresCompletedBeats 可指向运行时 milestone id。
      if (art.requiresCompletedBeats && allBeatIds.size > 0) {
        const bad = art.requiresCompletedBeats.filter((b) => !allBeatIds.has(b));
        if (bad.length > 0)
          console.warn(
            `[validateScenario:${o.id}] artifact "${art.id}".requiresCompletedBeats 引用不存在的 beat: ${bad.join(', ')}`,
          );
      }
    }
  }
  if (scenes) {
    for (const sc of scenes) {
      for (const b of sc.beats) {
        if (!b.trigger) continue;
        if (b.trigger.location && !locIds.has(b.trigger.location)) {
          console.warn(
            `[validateScenario:${o.id}] beat "${b.id}".trigger.location "${b.trigger.location}" 不在 locations 中`,
          );
        }
        if (b.trigger.completedBeats) {
          const bad = b.trigger.completedBeats.filter((x) => !allBeatIds.has(x));
          if (bad.length > 0)
            console.warn(
              `[validateScenario:${o.id}] beat "${b.id}".trigger.completedBeats 引用不存在的 beat: ${bad.join(', ')}`,
            );
        }
        if (b.trigger.discoveredArtifacts) {
          const bad = b.trigger.discoveredArtifacts.filter((x) => !allArtifactIds.has(x));
          if (bad.length > 0)
            console.warn(
              `[validateScenario:${o.id}] beat "${b.id}".trigger.discoveredArtifacts 引用不存在的 artifact: ${bad.join(', ')}`,
            );
        }
      }
    }
  }

  const scenario: Scenario = {
    id: o.id as string,
    name: o.name as string,
    shortName:
      typeof o.shortName === 'string' && o.shortName ? o.shortName : (o.name as string).slice(0, 20),
    description: typeof o.description === 'string' ? o.description : '',
    loreDigest,
    openingNarration: typeof o.openingNarration === 'string' ? o.openingNarration : '',
    defaultNpcId,
    npcs,
    entryCost,
    magicTags,
    forceReward,
    scenes,
    startSceneId,
    difficulty,
    playerSoulIdentity,
    locations,
    initialLocation,
    targetMilestones,
    llmConfig,
    promptSegments,
    loreChunks,
    dynamicLocations,
  };
  return { ok: true, scenario };
}

/**
 * 解析 + 校验 Scenario.dynamicLocations(运行时扩展能力声明)。
 * 缺省 / 非法 → undefined(等同 allowed:false,完全等同旧行为)。
 *
 * 字段:
 *   - allowed:必须是 boolean
 *   - maxPerSession:可选 number 1-50(超出范围 / 类型错误 → 用默认 8)
 *   - requireConnectedToCurrent:可选 boolean(缺省 = true,parser 校验时用)
 *   - hint:可选 string,≤500 字(超出截断 + warn)
 */
function parseDynamicLocationsConfig(
  raw: unknown,
  scenarioId: string,
): import('./index').DynamicLocationConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(
      `[validateScenario:${scenarioId}] dynamicLocations 必须是对象,已忽略(等同 allowed:false)`,
    );
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.allowed !== 'boolean') {
    console.warn(
      `[validateScenario:${scenarioId}] dynamicLocations.allowed 必须是 boolean,已忽略`,
    );
    return undefined;
  }
  const out: import('./index').DynamicLocationConfig = { allowed: o.allowed };
  if (o.maxPerSession !== undefined) {
    if (
      typeof o.maxPerSession === 'number' &&
      Number.isFinite(o.maxPerSession) &&
      o.maxPerSession >= 1 &&
      o.maxPerSession <= 50
    ) {
      out.maxPerSession = Math.floor(o.maxPerSession);
    } else {
      console.warn(
        `[validateScenario:${scenarioId}] dynamicLocations.maxPerSession 必须是 1-50 整数,已用默认 8`,
      );
    }
  }
  if (o.requireConnectedToCurrent !== undefined) {
    if (typeof o.requireConnectedToCurrent === 'boolean') {
      out.requireConnectedToCurrent = o.requireConnectedToCurrent;
    } else {
      console.warn(
        `[validateScenario:${scenarioId}] dynamicLocations.requireConnectedToCurrent 必须是 boolean,已忽略`,
      );
    }
  }
  if (o.hint !== undefined) {
    if (typeof o.hint === 'string') {
      if (o.hint.length > 500) {
        console.warn(
          `[validateScenario:${scenarioId}] dynamicLocations.hint 超过 500 字(${o.hint.length}),已截断`,
        );
        out.hint = o.hint.slice(0, 500);
      } else if (o.hint.trim()) {
        out.hint = o.hint;
      }
    } else {
      console.warn(
        `[validateScenario:${scenarioId}] dynamicLocations.hint 必须是字符串,已忽略`,
      );
    }
  }
  return out;
}

/**
 * 解析 + 校验剧本 loreChunks。每个 chunk 必须:
 *   - id kebab-case 且剧本内唯一(重复后者被丢弃)
 *   - title / content 非空
 *   - tags 非空数组(每个 tag kebab-case)
 * 不满足的项静默丢弃。
 */
function parseLoreChunks(raw: unknown): LoreChunk[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: LoreChunk[] = [];
  const seenIds = new Set<string>();
  for (const rawChunk of raw) {
    if (!rawChunk || typeof rawChunk !== 'object') continue;
    const c = rawChunk as Record<string, unknown>;
    const id = isStr(c.id) ? c.id : '';
    if (!id || !/^[a-z0-9-]+$/.test(id)) continue;
    if (seenIds.has(id)) continue;
    const title = isStr(c.title) ? c.title.trim() : '';
    const content = isStr(c.content) ? c.content.trim() : '';
    if (!title || !content) continue;
    if (!Array.isArray(c.tags)) continue;
    const tags = (c.tags as unknown[]).filter(
      (t): t is string => typeof t === 'string' && /^[a-z0-9-]+$/.test(t),
    );
    if (tags.length === 0) continue;
    seenIds.add(id);
    out.push({ id, title, content, tags });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 解析 + 校验剧本 llmConfig。返 undefined 表示"全用框架默认"。
 * 每个字段独立判断,有效字段才保留;非法字段静默丢弃(不抛错,避免坏 DLC 整个剧本不可用)。
 */
function parseLlmConfig(raw: unknown): ScenarioLlmConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const lc = raw as Record<string, unknown>;
  const out: ScenarioLlmConfig = {};
  if (isStr(lc.model) && lc.model.trim()) out.model = lc.model.trim();
  if (typeof lc.temperature === 'number' && lc.temperature >= 0 && lc.temperature <= 2) {
    out.temperature = lc.temperature;
  }
  if (typeof lc.maxTokens === 'number' && lc.maxTokens > 0 && lc.maxTokens <= 32768) {
    out.maxTokens = Math.floor(lc.maxTokens);
  }
  if (typeof lc.historyLimit === 'number' && lc.historyLimit > 0 && lc.historyLimit <= 500) {
    out.historyLimit = Math.floor(lc.historyLimit);
  }
  if (typeof lc.memoryLimit === 'number' && lc.memoryLimit >= 0 && lc.memoryLimit <= 50) {
    out.memoryLimit = Math.floor(lc.memoryLimit);
  }
  if (
    typeof lc.summaryTriggerRatio === 'number' &&
    lc.summaryTriggerRatio > 0 &&
    lc.summaryTriggerRatio <= 1
  ) {
    out.summaryTriggerRatio = lc.summaryTriggerRatio;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 解析 + 校验剧本 promptSegments。
 * insert 项必须:
 *   - id kebab-case 且不能跟 SegmentId 重名
 *   - 必须指定 before 或 after 之一
 *   - content 非空
 * 不满足的项静默丢弃。
 */
function parsePromptSegments(raw: unknown): ScenarioPromptSegments | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const ps = raw as Record<string, unknown>;
  const validSegments = new Set<string>(ALL_SEGMENT_IDS);
  const out: ScenarioPromptSegments = {};

  if (Array.isArray(ps.disabled)) {
    const filtered = (ps.disabled as unknown[]).filter(
      (s): s is SegmentId => typeof s === 'string' && validSegments.has(s),
    );
    if (filtered.length > 0) out.disabled = filtered;
  }

  if (Array.isArray(ps.insert)) {
    const inserts: NonNullable<ScenarioPromptSegments['insert']> = [];
    (ps.insert as unknown[]).forEach((rawIn) => {
      if (!rawIn || typeof rawIn !== 'object') return;
      const ins = rawIn as Record<string, unknown>;
      const before =
        typeof ins.before === 'string' && validSegments.has(ins.before)
          ? (ins.before as SegmentId)
          : undefined;
      const after =
        typeof ins.after === 'string' && validSegments.has(ins.after)
          ? (ins.after as SegmentId)
          : undefined;
      const id = typeof ins.id === 'string' ? ins.id : '';
      const content = typeof ins.content === 'string' ? ins.content : '';
      // id 必填 kebab-case + 不能跟默认段重名
      if (!id || !/^[a-z0-9-]+$/.test(id) || validSegments.has(id)) return;
      if (!content.trim()) return;
      // 必须指定锚点
      if (!before && !after) return;
      inserts.push({ before, after, id, content });
    });
    if (inserts.length > 0) out.insert = inserts;
  }

  return (out.disabled?.length ?? 0) > 0 || (out.insert?.length ?? 0) > 0 ? out : undefined;
}

/**
 * 规范化 scenes 数组。
 * 容错策略:可选字段缺了给默认值,但 beat.id / scene.id 必填且 kebab-case。
 */
function normalizeScenes(
  rawScenes: unknown[],
  scenarioId: string,
): { scenes: Scene[]; errors: string[] } {
  const errors: string[] = [];
  const scenes: Scene[] = [];
  const seenSceneIds = new Set<string>();
  const seenBeatIds = new Set<string>();

  rawScenes.forEach((rawScene, sceneIdx) => {
    if (!rawScene || typeof rawScene !== 'object') {
      errors.push(`scenes[${sceneIdx}] 不是对象`);
      return;
    }
    const sc = rawScene as Record<string, unknown>;
    const id = typeof sc.id === 'string' ? sc.id : '';
    if (!id || !/^[a-z0-9-]+$/.test(id)) {
      errors.push(`scenes[${sceneIdx}].id 必填(kebab-case)`);
      return;
    }
    if (seenSceneIds.has(id)) {
      errors.push(`scenes[${sceneIdx}].id "${id}" 重复`);
      return;
    }
    seenSceneIds.add(id);

    const name = typeof sc.name === 'string' && sc.name ? sc.name : `Scene ${sceneIdx + 1}`;
    const description = typeof sc.description === 'string' ? sc.description : '';

    // ── beats ──
    const beats: Beat[] = [];
    if (!Array.isArray(sc.beats)) {
      errors.push(`scenes[${sceneIdx}].beats 必填且为数组`);
      return;
    }
    sc.beats.forEach((rawBeat: unknown, beatIdx: number) => {
      if (!rawBeat || typeof rawBeat !== 'object') {
        errors.push(`scenes[${sceneIdx}].beats[${beatIdx}] 不是对象`);
        return;
      }
      const b = rawBeat as Record<string, unknown>;
      const bid = typeof b.id === 'string' ? b.id : '';
      if (!bid || !/^[a-z0-9-]+$/.test(bid)) {
        errors.push(`scenes[${sceneIdx}].beats[${beatIdx}].id 必填(kebab-case)`);
        return;
      }
      if (seenBeatIds.has(bid)) {
        errors.push(`beat id "${bid}" 重复`);
        return;
      }
      seenBeatIds.add(bid);
      const type: Beat['type'] = b.type === 'checkpoint' ? 'checkpoint' : 'optional';
      beats.push({
        id: bid,
        type,
        summary: typeof b.summary === 'string' ? b.summary : '',
        triggerHint: typeof b.triggerHint === 'string' ? b.triggerHint : '',
        unlockHint: typeof b.unlockHint === 'string' ? b.unlockHint : undefined,
        unlocksNext: Array.isArray(b.unlocksNext) ? (b.unlocksNext as unknown[]).filter(isStr) : undefined,
        trigger: parseBeatTrigger(b.trigger),
      });
    });
    if (beats.length === 0) {
      errors.push(`scenes[${sceneIdx}] "${id}" 无有效 beat`);
      return;
    }

    scenes.push({
      id,
      name,
      description,
      enterNarration: typeof sc.enterNarration === 'string' ? sc.enterNarration : undefined,
      imagePrompt: typeof sc.imagePrompt === 'string' ? sc.imagePrompt : undefined,
      beats,
      nextSceneId: typeof sc.nextSceneId === 'string' ? sc.nextSceneId : undefined,
      // C4/I-series:"身边" NPC 池 — DLC 化前漏处理过,现在补上
      // 用于 dialogue-targets.listNearbyTargets + character-tiers.classifyCharacter
      presentNpcIds: Array.isArray(sc.presentNpcIds)
        ? (sc.presentNpcIds as unknown[]).filter(isStr)
        : undefined,
    });
  });

  // 二次校验:nextSceneId 必须指向存在的 scene
  for (const sc of scenes) {
    if (sc.nextSceneId && !seenSceneIds.has(sc.nextSceneId)) {
      errors.push(`scenes[${sc.id}].nextSceneId "${sc.nextSceneId}" 不存在,会被忽略`);
      // 不直接 fail,Director 还能用数组顺序回退,只标记 warning
      sc.nextSceneId = undefined;
    }
  }
  // 至少有 1 个 checkpoint(否则完成度永远 0)
  const hasCheckpoint = scenes.some((s) => s.beats.some((b) => b.type === 'checkpoint'));
  if (scenes.length > 0 && !hasCheckpoint) {
    errors.push('剧情骨架必须至少有 1 个 type=checkpoint 的 beat,否则完成度永远 0');
  }

  return { scenes, errors };
}

function isStr(x: unknown): x is string {
  return typeof x === 'string';
}

// ─── 世界控制三件套解析(connections / sceneState / artifacts / trigger)──────

/** 通用 kebab-case id 列表过滤。空数组 → undefined(让 Scenario 字段保持 sparse)。 */
function parseKebabIdList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = (raw as unknown[]).filter(
    (s): s is string => typeof s === 'string' && /^[a-z0-9-]+$/.test(s),
  );
  return out.length > 0 ? out : undefined;
}

/**
 * 解析 location.sceneState(初始环境状态 KV)。
 *   - key:kebab/snake-case(字母数字下划线连字符)
 *   - value:必须是 string(避免 LLM 输出格式失控)
 * 不合规字段静默丢弃。
 */
function parseSceneState(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === 'string' && /^[a-z0-9_-]+$/.test(k) && typeof v === 'string') {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 解析 location.artifacts(可调查的线索 / 物件)。
 *   - id / name / description 必填,缺失项整条丢弃
 *   - id 剧本内唯一(同 location 内 dup 丢弃,跨 location 不强制 — 二次校验仅 warn)
 */
function parseLocationArtifacts(raw: unknown): LocationArtifact[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: LocationArtifact[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    const id = isStr(a.id) ? a.id : '';
    if (!id || !/^[a-z0-9-]+$/.test(id) || seen.has(id)) continue;
    const name = isStr(a.name) ? a.name.trim() : '';
    const description = isStr(a.description) ? a.description.trim() : '';
    if (!name || !description) continue;
    seen.add(id);
    out.push({
      id,
      name,
      description,
      requiresCompletedBeats: parseKebabIdList(a.requiresCompletedBeats),
      tags: parseKebabIdList(a.tags),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 解析 beat.trigger(硬性前置条件)。所有字段全无 → undefined。
 * 字段含义见 BeatTrigger 接口注释。
 */
function parseBeatTrigger(raw: unknown): BeatTrigger | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const out: BeatTrigger = {};
  if (isStr(t.location) && /^[a-z0-9-]+$/.test(t.location)) out.location = t.location;
  if (typeof t.visitCount === 'number' && Number.isFinite(t.visitCount) && t.visitCount > 0) {
    out.visitCount = Math.floor(t.visitCount);
  }
  if (
    t.timeOfDay === 'day' ||
    t.timeOfDay === 'night' ||
    t.timeOfDay === 'dawn' ||
    t.timeOfDay === 'dusk'
  ) {
    out.timeOfDay = t.timeOfDay;
  }
  const cb = parseKebabIdList(t.completedBeats);
  if (cb) out.completedBeats = cb;
  const da = parseKebabIdList(t.discoveredArtifacts);
  if (da) out.discoveredArtifacts = da;
  return Object.keys(out).length > 0 ? out : undefined;
}

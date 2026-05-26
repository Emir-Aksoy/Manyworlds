'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BridgeHealth,
  callLLM,
  checkAllLanes,
  checkBridgeHealth,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_BASE_URLS,
  exportImagePrompt,
  getKeyStoreWriteError,
  getPrefStoreWriteError,
  keyStore,
  LaneHealth,
  LlmMode,
  Message,
  prefStore,
  Provider,
} from '../lib/gateway';
import { getLaneDef, LANES, type LaneDef, LaneId, PRESETS, TASKS, TaskTag } from '../lib/models';
import { getDefaultTaskFallback, getRouterWriteError, router } from '../lib/router';
import { getVisibleLaneIds, isPublicMode } from '../lib/runtime-mode';
import {
  type CustomLane,
  getCustomLanesWriteError,
  listCustomLanes,
  removeCustomLane,
  upsertCustomLane,
} from '../lib/custom-lanes';
import {
  type CustomImageLane,
  getImageLanesWriteError,
  listImageLanes,
  removeImageLane,
  upsertImageLane,
} from '../lib/image-lanes';
import { DEFAULT_COMPANION_SUMMARY } from '../lib/companion';
import {
  buildStructuredDirectorPrompt,
  buildFreeDirectorPrompt,
  buildActionReactionPrompt,
  parseDirectorJson,
  type DirectorPlayerCtx,
} from '../lib/director';
import {
  getDialogueTarget,
  listNearbyTargets,
  isCompanionId,
  type DialogueTarget,
} from '../lib/dialogue-targets';
import { classifyCharacter, tierConfigFor, shouldCompress } from '../lib/character-tiers';
import { compressMessages, SUMMARY_PREFIX } from '../lib/messages-compress';
import {
  buildScenarioNpcRoster,
  buildSystemPromptForCharacter,
  getCharacter,
  isPortraitGeneratable,
} from '../lib/characters';
import {
  DEFAULT_SCENARIO_ID,
  getScenario,
  isBuiltinScenario,
  listAllCheckpoints,
  computeCompletion,
  computeForceReward,
  rollWishes,
  wishGrantRate,
  isDlcReady,
  subscribeDlcReady,
  dlcCount,
  getInitialLocation,
  getLocation,
  evaluateBeatTrigger,
  type ScenarioDifficulty,
  type ScenarioLocation,
} from '../lib/scenarios';
import { loadAllDlc, type DlcLoadResult } from '../lib/scenarios/dlc';
import { consolidateNpcMemory } from '../lib/memory-consolidate';
import { decideAndGenerateBanter } from '../lib/companion-banter';
import {
  ALL_EMOTIONS,
  EMOTION_ICONS,
  EMOTION_LABELS,
  buildEmotionPrompt,
  type Emotion,
} from '../lib/portrait-emotions';
import { detectNpcEmotion, getEmotionAutoTrust } from '../lib/emotion-detect';
import { analyzeReplyStructure, recordReplyMetrics } from '../lib/reply-metrics';
import { generateSceneImage, readSceneImage, writeSceneImage } from '../lib/scene-images';
import { resolveEmotionPolicy } from '../lib/plaza';
import { exportAllAsJson } from '../lib/full-export';
import {
  applyWcEventsToPlaza,
  applyWcStatEventsToPlaza,
  parseWcTrustEvents,
  detectChatMode,
  recordExternalFailure,
} from '../lib/llm-events';
import type { CombatStat } from '../lib/combat-stats';
import { removeCustomScenario } from '../lib/scenarios/custom';
import { parseScenarioJson, generateScenarioFromText, type GenerateResult } from '../lib/scenario-import';
import { addCustomScenario } from '../lib/scenarios/custom';
import type { Scenario } from '../lib/scenarios';
import type { CharacterSpec } from '../lib/character-spec';
import { listScenarios } from '../lib/scenarios';
import {
  plaza,
  isItemSuppressed,
  itemUpgradeCost,
  companionUpgradeCost,
  companionReviveCost,
  profileBaseImage,
  getPlazaWriteError,
  getPlazaStorageSize,
  type PlazaStorageStat,
  buildNpcPromptContext,
  MAGIC_SYSTEMS,
  subscribePlaza,
  type PlazaState,
  type CompanionEntry,
  type Item as PlazaItem,
  type CharacterProfile,
  type CharacterImage,
  type MagicSystem,
  type PortraitPrefs,
  type UserProfile,
  type Gender,
  type EntryMode,
} from '../lib/plaza';

type Tab = 'plaza' | 'chat' | 'settings' | 'portrait' | 'memory' | 'models';

/**
 * 处理 LLM 输出里所有 WC-STAT / WC-EVENT 标记 + 弹通知。
 * 3 处调用:NPC chat 主对话 / Director 行动反应 / Director 推进。
 *
 * 流程:
 *   1. applyWcStatEventsToPlaza 解析 stat 变化(静默写入,只 console.log debug)
 *   2. applyWcEventsToPlaza 解析死亡 / 物品损毁(写入 + 返回净化文本 + 名字)
 *   3. 命中 死亡 / 物品损毁 时弹 alert(用 setTimeout 让 UI 先刷)
 *
 * @param rawText LLM 原始输出(可能含 WC-EVENT/STAT 注释)
 * @param source 调用源,只用于 console.log 上下文
 * @returns cleanedText 剥光标记的展示文本,适合写入 messages 历史
 */
function processWcMarkers(
  rawText: string,
  source: 'npc-chat' | 'director-action' | 'director-advance' | 'banter',
): string {
  const statChanges = applyWcStatEventsToPlaza(rawText);
  const {
    cleanedText,
    diedCompanionNames,
    lostItemNames,
    newLocation,
    newMilestoneIds,
    newlyDiscoveredArtifactIds,
    sceneStateChanges,
    newlySpawnedLocations,
  } = applyWcEventsToPlaza(rawText);

  if (statChanges.length > 0) {
    console.log(`[WC-STAT][${source}]`, statChanges);
  }
  if (newLocation) {
    console.log(`[WC-LOCATION][${source}]`, newLocation);
  }
  if (newMilestoneIds.length > 0) {
    console.log(`[WC-MILESTONE][${source}]`, newMilestoneIds);
  }
  if (newlyDiscoveredArtifactIds.length > 0) {
    console.log(`[WC-ARTIFACT][${source}]`, newlyDiscoveredArtifactIds);
  }
  if (sceneStateChanges.length > 0) {
    console.log(`[WC-SCENE-STATE][${source}]`, sceneStateChanges);
  }
  if (newlySpawnedLocations.length > 0) {
    console.log(
      `[WC-LOCATION-SPAWNED][${source}]`,
      newlySpawnedLocations.map((l) => `${l.id}(${l.name})`),
    );
    // 轻量提示:让玩家知道新场所诞生了。alert 太重(spawn 是普通叙事),用 setTimeout 控制台 + console 即可。
    // 后续若 UI 想要 toast/banner,在此添加。
  }

  if (diedCompanionNames.length > 0 || lostItemNames.length > 0) {
    const lines: string[] = [];
    if (diedCompanionNames.length > 0) {
      lines.push(`💀 队友陨落:${diedCompanionNames.join('、')}`);
      lines.push('(返回广场后可花原力复活,50 × 等级)');
    }
    if (lostItemNames.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(`⚰️ 物品永失:${lostItemNames.join('、')}`);
      lines.push('(损毁 / 掉落在剧本里,无法带回)');
    }
    window.setTimeout(() => {
      try {
        window.alert(lines.join('\n'));
      } catch {
        /* SSR */
      }
    }, 50);
  }

  return cleanedText;
}

/**
 * 构造给 Director 用的 combat ctx(从 plaza 当前 state 现取)。
 * 没在剧本里 → 返回 undefined(Director prompt 跳过此段)。
 *
 * 包含:
 *   - 隐藏数值 stats / subjectNames(WC-STAT 用)
 *   - 携带队友 / 物品白名单(WC-EVENT companion-died/item-lost 用)
 *   - 动态剧本的 locations / currentLocationId(WC-EVENT location-changed 用)
 *   - milestonesEnabled(WC-EVENT milestone-reached 用)
 */
function buildDirectorCombatCtx(): {
  stats: Record<string, CombatStat>;
  subjectNames: Record<string, string>;
  carriedCompanions: Array<{ id: string; name: string }>;
  carriedItems: Array<{ id: string; name: string }>;
  locations?: Array<{ id: string; name: string; description?: string }>;
  currentLocationId?: string | null;
  milestonesEnabled?: boolean;
} | undefined {
  const s = plaza.get();
  if (!s.inScenario || !s.currentRunLoadout) return undefined;
  const carriedCompanions: Array<{ id: string; name: string }> = [];
  const subjectNames: Record<string, string> = { player: '主角' };
  for (const cid of s.currentRunLoadout.companionIds) {
    const c = s.companions.find((x) => x.characterId === cid);
    if (!c) continue;
    const name =
      c.profile.origin?.split('·')[0]?.trim() || c.characterId.replace(/^companion-/, '');
    carriedCompanions.push({ id: c.characterId, name });
    subjectNames[c.characterId] = name;
  }
  const carriedItems = s.currentRunLoadout.itemIds
    .map((id) => {
      const i = s.inventory.find((x) => x.id === id);
      return i ? { id: i.id, name: i.name } : null;
    })
    .filter((x): x is { id: string; name: string } => !!x);
  // 动态剧本信息从 scenario 取
  const scenario = getScenario(s.inScenario);
  const locations = scenario?.locations;
  const milestonesEnabled =
    !!scenario?.targetMilestones && scenario.targetMilestones > 0;
  return {
    stats: s.currentCombatStats,
    subjectNames,
    carriedCompanions,
    carriedItems,
    locations,
    currentLocationId: s.currentLocation,
    milestonesEnabled,
  };
}

// ─── I-series:从 plaza state 解析"prompt 用的玩家身份 + 愿望" ─────────────

/**
 * NPC system prompt 要的 playerIdentity ctx 形状 — 跟 characters.ts SystemPromptContext.playerIdentity 一致。
 * 单独定义一份是为了让 page.tsx 不用 import 内部 type(降低 coupling)。
 */
type PromptPlayerIdentity = {
  mode: 'soul' | 'body';
  displayName: string;
  gender: 'male' | 'female' | 'other' | 'unspecified';
  age: number;
  background: string;
  bodyEntryContext?: string;
};

/**
 * 从 plaza state 反推"NPC system prompt 用的玩家身份段"。
 *   - scenarioId 没有对应 progress 或 entryMode 缺省 → 返回 undefined(prompt 跳过此段)
 *   - 'soul' + scenario.playerSoulIdentity 存在 → 用 soul 身份(性别/年龄默认继承玩家真实身份)
 *   - 'soul' + scenario.playerSoulIdentity 缺失 → 兜底降到 body 模式(避免 prompt 引用空字段)
 *   - 'body' → 玩家真实身份 + bodyEntryContext(若 LLM 还在生成中,bodyEntryContext 暂为 undefined,prompt 用 fallback 文本)
 */
function resolvePlayerIdentityForPrompt(scenarioId: string): PromptPlayerIdentity | undefined {
  const s = plaza.get();
  const progress = s.scenarioProgress[scenarioId];
  if (!progress?.entryMode) return undefined;
  const scenario = getScenario(scenarioId);
  const userProfile = s.userProfile;
  const nickname = userProfile.nickname?.trim() || '旅人';

  if (progress.entryMode === 'soul' && scenario?.playerSoulIdentity) {
    const soul = scenario.playerSoulIdentity;
    return {
      mode: 'soul',
      displayName: soul.name,
      gender: soul.gender ?? userProfile.gender,
      age: typeof soul.age === 'number' && soul.age > 0 ? soul.age : userProfile.age,
      background: soul.background,
    };
  }
  // body(包括 soul-fallback)
  return {
    mode: 'body',
    displayName: nickname,
    gender: userProfile.gender,
    age: userProfile.age,
    background:
      progress.bodyEntryContext ||
      '一个来自其他世界的访客 — 具体的来历由他/她自己讲述,你可以观察、好奇、警觉,但不必盘问。',
    bodyEntryContext: progress.bodyEntryContext,
  };
}

/**
 * 从 plaza state 反推"prompt 用的愿望段"。
 *   - 无 wishes 或空数组 → undefined(prompt 跳过此段)
 *   - 有 wishes 时按 wishesGranted 下标拆分成 granted/denied 两个文本数组
 */
function resolveWishesForPrompt(
  scenarioId: string,
): { granted: string[]; denied: string[] } | undefined {
  const progress = plaza.get().scenarioProgress[scenarioId];
  if (!progress?.wishes || progress.wishes.length === 0) return undefined;
  const grantedIdx = new Set(progress.wishesGranted ?? []);
  const granted: string[] = [];
  const denied: string[] = [];
  progress.wishes.forEach((w, i) => {
    if (grantedIdx.has(i)) granted.push(w);
    else denied.push(w);
  });
  return { granted, denied };
}

/** 组装 Director extraCtx(给 director.ts prompt 用)。 */
function resolveDirectorExtraCtx(scenarioId: string): DirectorPlayerCtx {
  return {
    playerIdentity: resolvePlayerIdentityForPrompt(scenarioId),
    wishes: resolveWishesForPrompt(scenarioId),
  };
}

const EVENTS_KEY = 'wc_poc_events';

/** 容错读 sessionStorage 里的事件列表，外部污染 / 半写入也兜底成 []。 */
function readEvents(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(EVENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeEvents(events: string[]) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  } catch {
    /* quota / disabled / 都吞掉 */
  }
}

// ── 会话 / 立绘持久化（切 tab/刷新不丢） ──────────────────────────────
// v2: messages 按 NPC 隔离存储 { [characterId]: Message[] },让用户跟不同 NPC 各聊各的
const MSG_KEY_V2 = 'wc_poc_messages_v2';
/**
 * 立绘缓存。v2 起按情绪嵌套:{ [characterId]: { [emotion]: dataUrl } }。
 * 读时若检测到旧 v1 平铺结构(value 是 string),自动迁移成 { neutral: <string> }。
 */
const PORTRAIT_CACHE_KEY = 'wc_poc_portraits_v1';
const CURRENT_NPC_KEY = 'wc_poc_current_npc'; // 用户上一次选的 NPC ID

function isValidMessage(m: unknown): m is Message {
  return (
    !!m &&
    typeof m === 'object' &&
    'role' in m &&
    'content' in m &&
    ((m as Message).role === 'user' || (m as Message).role === 'assistant') &&
    typeof (m as Message).content === 'string'
  );
}

/**
 * F3:消息缓存按 `scenarioId::npcId` 复合 key 存,避免不同剧本复用同 npcId 时污染。
 *
 * Migration:旧版只用 npcId 当 key。读时若发现旧格式(value 是数组而不是 nested map),
 * 自动归到 "starmail::<npcId>"(PoC 阶段只有 starmail 一个内置剧本,这是最安全的迁移)。
 *
 * 新结构:{ [scenarioId]: { [npcId]: Message[] } }
 */
type MsgStore = Record<string, Record<string, Message[]>>; // [scenarioId][npcId] = Message[]

function readMsgStore(): MsgStore {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(MSG_KEY_V2);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    // 旧格式检测:第一层 value 是数组 → 旧扁平结构,迁移到 'starmail' namespace
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length > 0 && Array.isArray(entries[0][1])) {
      const migrated: MsgStore = { [DEFAULT_SCENARIO_ID]: {} };
      for (const [npcId, arr] of entries) {
        if (Array.isArray(arr)) {
          migrated[DEFAULT_SCENARIO_ID][npcId] = arr.filter(isValidMessage);
        }
      }
      return migrated;
    }
    // 新格式
    const out: MsgStore = {};
    for (const [sid, npcMap] of entries) {
      if (!npcMap || typeof npcMap !== 'object') continue;
      out[sid] = {};
      for (const [npcId, arr] of Object.entries(npcMap as Record<string, unknown>)) {
        if (Array.isArray(arr)) out[sid][npcId] = arr.filter(isValidMessage);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeMsgStore(store: MsgStore) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(MSG_KEY_V2, JSON.stringify(store));
  } catch {
    /* quota */
  }
}

function readMessagesFor(scenarioId: string, npcId: string): Message[] {
  const store = readMsgStore();
  return store[scenarioId]?.[npcId] ?? [];
}

function writeMessagesFor(scenarioId: string, npcId: string, msgs: Message[]) {
  const store = readMsgStore();
  if (!store[scenarioId]) store[scenarioId] = {};
  store[scenarioId][npcId] = msgs;
  writeMsgStore(store);
}

/** B1:列出当前剧本下所有有非空对话的 NPC ID(F3:scoped by scenario)。 */
function listChattedNpcIds(scenarioId: string): string[] {
  const store = readMsgStore();
  const npcMap = store[scenarioId] ?? {};
  return Object.keys(npcMap).filter((k) => npcMap[k].length >= 2);
}

/**
 * B1:返广场时跑多 NPC 记忆固化。
 * 遍历本 session 跟玩家有过对话的所有 NPC,挨个调 consolidateNpcMemory,
 * 返回汇总信息让 UI 弹给用户。
 *
 * 内部容错:某个 NPC 固化失败不影响其他;无对话 NPC 跳过。
 */
async function consolidateAllChattedNpcs(scenarioId: string): Promise<{
  succeeded: { npcName: string; added: number }[];
  failed: { npcName: string; error: string }[];
}> {
  const ids = listChattedNpcIds(scenarioId);
  const succeeded: { npcName: string; added: number }[] = [];
  const failed: { npcName: string; error: string }[] = [];
  // 串行跑:LLM 调用并发可能撞 rate limit / Codex 池
  for (const npcId of ids) {
    // G15:scope 到当前剧本(自定义剧本若复用 npcId 也不会拿错)
    const npc = getCharacter(npcId, scenarioId);
    if (!npc) continue;
    const msgs = readMessagesFor(scenarioId, npcId).filter(
      (m) => !m.content.startsWith(NARRATION_PREFIX) && !m.content.startsWith(COMPANION_PREFIX),
    );
    if (msgs.length < 2) continue;
    try {
      const res = await consolidateNpcMemory({
        npcId,
        npcName: npc.identity.name,
        scenarioId,
        conversation: msgs.slice(-20),
        existingMemoryCount: plaza.listNpcMemories(npcId, scenarioId).length,
      });
      if (res.ok && res.added > 0) {
        succeeded.push({ npcName: npc.identity.name, added: res.added });
      } else if (!res.ok) {
        failed.push({ npcName: npc.identity.name, error: res.error ?? '未知错误' });
      }
    } catch (e) {
      failed.push({ npcName: npc.identity.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { succeeded, failed };
}

function formatConsolidationSummary(result: {
  succeeded: { npcName: string; added: number }[];
  failed: { npcName: string; error: string }[];
}): string {
  const lines: string[] = [];
  if (result.succeeded.length > 0) {
    lines.push('🧠 记忆已固化:');
    lines.push(
      result.succeeded.map((s) => `  • ${s.npcName}: ${s.added} 条`).join('\n'),
    );
  }
  if (result.failed.length > 0) {
    lines.push('⚠ 固化失败:');
    lines.push(result.failed.map((f) => `  • ${f.npcName}: ${f.error}`).join('\n'));
  }
  if (lines.length === 0) {
    lines.push('(本次没有可固化的对话内容)');
  }
  return lines.join('\n');
}

function readCurrentNpcId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(CURRENT_NPC_KEY);
  } catch {
    return null;
  }
}

function writeCurrentNpcId(id: string) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(CURRENT_NPC_KEY, id);
  } catch {
    /* quota */
  }
}

/** v2 嵌套结构:{ [characterId]: { [emotion]: dataUrl } }(v1 平铺也兼容读) */
type PortraitMap = Record<string, Partial<Record<Emotion, string>> | string>;

function readPortraitMap(): PortraitMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(PORTRAIT_CACHE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    return obj as PortraitMap;
  } catch {
    return {};
  }
}

/**
 * 读某角色某情绪的立绘。
 *  - v2:obj[id][emotion]
 *  - v1 兼容:obj[id] 是 string 时,等同 neutral
 *  - 没找到:fallback 到 neutral(如果调用方要的不是 neutral)
 */
function readPortrait(characterId: string, emotion: Emotion = 'neutral'): string | null {
  const map = readPortraitMap();
  const entry = map[characterId];
  if (!entry) return null;
  if (typeof entry === 'string') {
    // v1 旧格式:只有一张,当作 neutral
    return emotion === 'neutral' ? entry : null;
  }
  const val = entry[emotion];
  return typeof val === 'string' ? val : null;
}

/**
 * 把 portrait map 写回 sessionStorage,quota 时 LRU 淘汰非 neutral 情绪后重试。
 * 返回 true = 写成功,false = quota 满且 fallback 也失败(本次不缓存)。
 */
function tryWritePortraitMap(map: PortraitMap): boolean {
  try {
    window.sessionStorage.setItem(PORTRAIT_CACHE_KEY, JSON.stringify(map));
    return true;
  } catch (e) {
    // QuotaExceededError:开始淘汰
    const err = e as { name?: string };
    if (err?.name !== 'QuotaExceededError' && err?.name !== 'NS_ERROR_DOM_QUOTA_REACHED') {
      console.warn('[portrait-cache] write 失败(非 quota):', e);
      return false;
    }
    // Pass 1:把所有 character 的非 neutral 情绪丢掉(留 neutral 是最低基线)
    let pruned = false;
    for (const charId of Object.keys(map)) {
      const entry = map[charId];
      if (typeof entry === 'string') continue;
      for (const emo of ALL_EMOTIONS) {
        if (emo === 'neutral') continue;
        if (entry[emo]) {
          delete entry[emo];
          pruned = true;
        }
      }
    }
    if (pruned) {
      try {
        window.sessionStorage.setItem(PORTRAIT_CACHE_KEY, JSON.stringify(map));
        console.warn('[portrait-cache] quota 满,丢弃所有非 neutral 情绪后重试成功');
        return true;
      } catch {
        // 还是不行,放弃
      }
    }
    console.warn('[portrait-cache] quota 满且无法清理,本次写入放弃');
    return false;
  }
}

function writePortrait(characterId: string, emotion: Emotion, dataUrl: string) {
  if (typeof window === 'undefined') return;
  const map = readPortraitMap();
  const prev = map[characterId];
  let entry: Partial<Record<Emotion, string>>;
  if (!prev) {
    entry = {};
  } else if (typeof prev === 'string') {
    // v1 旧值升级:旧的 string 当 neutral
    entry = { neutral: prev };
  } else {
    entry = { ...prev };
  }
  entry[emotion] = dataUrl;
  map[characterId] = entry;
  tryWritePortraitMap(map);
}

/**
 * 检查某角色的情绪缓存是否达到 tier 上限的 80% — 是的话丢掉最不重要的情绪(非 neutral 中按 ALL_EMOTIONS 顺序的最后几个)。
 * 在 ensurePortraitFor 决定要生新情绪前调用,避免无限累积。
 *
 * @param characterId 角色 id
 * @param emotionsMax 该 tier 允许的情绪数(neutral 算 1 个)
 */
function maybeCompressPortraitsFor(characterId: string, emotionsMax: number) {
  if (typeof window === 'undefined') return;
  const map = readPortraitMap();
  const entry = map[characterId];
  if (!entry || typeof entry === 'string') return;
  const cached = ALL_EMOTIONS.filter((e) => entry[e]);
  if (cached.length < Math.floor(emotionsMax * 0.8)) return; // 还没到 80%
  // 优先级:neutral 必留,其他按 ALL_EMOTIONS 顺序保留前 emotionsMax-1 个
  const keep = new Set<Emotion>(['neutral']);
  for (const e of ALL_EMOTIONS) {
    if (keep.size >= emotionsMax) break;
    if (entry[e]) keep.add(e);
  }
  let pruned = false;
  for (const e of ALL_EMOTIONS) {
    if (!keep.has(e) && entry[e]) {
      delete entry[e];
      pruned = true;
    }
  }
  if (pruned) {
    map[characterId] = entry;
    tryWritePortraitMap(map);
  }
}

/** 叙事内容前缀标记（Director beat 用 assistant role 但 content 加前缀区分视觉） */
const NARRATION_PREFIX = '[叙事] ';
/** B3:队友插嘴消息的前缀。content 形如 "[队友 小明] 别忘了带咖啡" */
const COMPANION_PREFIX = '[队友 ';
const COMPANION_PREFIX_RE = /^\[队友 ([^\]]+)\] /;
/** C1:玩家行动消息前缀(走 ⚡ 行动 tab 发出),UI 区分跟"对话"消息 */
const ACTION_PREFIX = '[行动] ';

/** 兼容空字符串 / 非数字输入的 int 解析。 */
function safeInt(raw: string, fallback: number): number {
  if (raw === '' || raw === '-') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export default function Home() {
  // 默认进广场;但若上次关闭时玩家正在某副本里(plaza.inScenario != null),
  // 直接进 chat tab — 不要每次刷新都把玩家弹回广场。
  // lazy init 函数在 SSR 时返回 'plaza'(typeof window 保护),client mount 时才读 localStorage。
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'plaza';
    try {
      return plaza.get().inScenario ? 'chat' : 'plaza';
    } catch {
      return 'plaza';
    }
  });
  const [hasKey, setHasKey] = useState(false);
  const [mode, setMode] = useState<LlmMode>('apikey');
  const [presetLabel, setPresetLabel] = useState('Codex First');

  // ─── DLC 加载启动屏障 ─────────────────────────────────────────────
  //
  // 剧本(scenarios)从 bundle 拆出来 → public/dlc/*.json,client 启动时 fetch + register。
  // 加载完之前 getScenario()/listScenarios() 返回空,UI 上几乎所有东西都依赖 scenario,
  // 直接渲染会一片"Unknown scenario"。所以顶层卡一道 loading 屏障。
  //
  // SSR 时 dlcReady=false 也是渲染 loading screen,client hydration 后 useEffect 触发 loadAllDlc
  // → 全部 register 完 → setDlcReady(true) → 解除屏障。
  const [dlcReady, setDlcReady] = useState<boolean>(() => isDlcReady());
  const [dlcLoadResult, setDlcLoadResult] = useState<DlcLoadResult | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // 已经 ready 跳过(热重载场景)
    if (isDlcReady()) {
      setDlcReady(true);
      return;
    }
    let cancelled = false;
    void loadAllDlc().then((result) => {
      if (cancelled) return;
      setDlcLoadResult(result);
      setDlcReady(true);
      if (result.fatalError) {
        console.error('[dlc] fatal:', result.fatalError);
      }
      if (result.failed.length > 0) {
        console.warn('[dlc] failed scenarios:', result.failed);
      }
      console.log(
        `[dlc] ${result.fromCache ? 'cached' : 'fetched'}: ${result.loaded.length} loaded, ${result.failed.length} failed`,
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 备用:别的窗口/手动 reloadDlc → 订阅 ready 事件让本窗口也同步
  useEffect(() => {
    return subscribeDlcReady(() => setDlcReady(true));
  }, []);

  // S2 修复:把 inScenarioId 提升到 Home,所有 Tab 共享。
  // 每次 tab 切换 / plaza state 变动 都重新读 plaza.get().inScenario,避免 stale。
  const [inScenarioId, setInScenarioIdState] = useState<string | null>(null);
  const refreshInScenario = () => {
    if (typeof window === 'undefined') return;
    setInScenarioIdState(plaza.get().inScenario);
  };
  // 给 PlazaTab/ChatTab 调用,显式更新顶层状态(也会顺手 setInScenarioIdState)
  const setInScenarioId = (v: string | null) => setInScenarioIdState(v);

  // I-series:玩家真人身份(性别/年龄/昵称)。filled=false 时强制弹 Onboarding 模态。
  const [userProfile, setUserProfileState] = useState<UserProfile>(() => ({
    gender: 'unspecified',
    age: 0,
    filled: true, // SSR 默认 true,避免 hydration 误显;实际值在 useEffect 里同步
  }));
  const refreshUserProfile = () => {
    if (typeof window === 'undefined') return;
    setUserProfileState(plaza.get().userProfile);
  };

  // I-series:入境模态状态 — 用户点了 PlazaTab"进入"按钮后,顶层接管:
  //   { scenarioId, startSceneId }:展示 EntryModal,等用户选 soul/body + 填愿望
  //   null:模态关闭
  const [pendingEntry, setPendingEntry] = useState<{
    scenarioId: string;
    startSceneId?: string;
  } | null>(null);

  const refreshHasKey = () => setHasKey(!!keyStore.get('anthropic'));
  const refreshMode = () => setMode(prefStore.get().llmMode ?? 'apikey');
  const refreshPreset = () => setPresetLabel(router.getPreset().label);

  useEffect(() => {
    refreshHasKey();
    refreshMode();
    refreshPreset();
    refreshInScenario();
    refreshUserProfile();
    const onStorage = (e: StorageEvent) => {
      // P0 修复:apikey listener 要覆盖所有 BYOK provider(anthropic/openai/deepseek),不能只看 anthropic。
      // hasAnyKey(line 808-809)已经在看 3 家了,这里 listener 不跟上会导致 tab A 填 deepseek 后 tab B 仍弹 onboarding。
      if (e.key === null || e.key.startsWith('wc_poc_apikey_')) refreshHasKey();
      if (e.key === null || e.key === 'wc_poc_pref_v1') refreshMode();
      // P0 修复:router 实际 storage key 是 v2(见 router.ts:22),v1 是死代码 typo。
      if (e.key === null || e.key === 'wc_poc_router_v2') refreshPreset();
      // 多窗口同步:别的 tab 改了 plaza,本 tab 也更新
      if (e.key === null || e.key === 'wc_poc_plaza_v1') {
        refreshInScenario();
        refreshUserProfile();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // 同窗口 plaza 订阅(storage event 不在同窗口触发)
  useEffect(() => {
    const unsub = subscribePlaza(() => {
      refreshInScenario();
      refreshUserProfile();
    });
    return unsub;
  }, []);

  // S2 修复:Tab 切换时主动刷一遍,避免别的 Tab 改 plaza 后回来时 stale
  useEffect(() => {
    refreshInScenario();
  }, [tab]);

  // LAUNCH-T4:BYOK 首屏 onboarding —— 仅 public 模式 + 没填任何 key + 没 dismiss 过
  const [showByokOnboarding, setShowByokOnboarding] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isPublicMode()) return;
    // 已 dismiss 过(本浏览器)
    if (window.localStorage.getItem(BYOK_ONBOARDED_KEY) === '1') return;
    // 已填任何 BYOK key → 视为已经引导过
    const hasAnyKey =
      !!keyStore.get('deepseek') || !!keyStore.get('openai') || !!keyStore.get('anthropic');
    if (hasAnyKey) {
      window.localStorage.setItem(BYOK_ONBOARDED_KEY, '1');
      return;
    }
    setShowByokOnboarding(true);
  }, []);

  const statusText = `🧭 路由预设: ${presetLabel}`;

  // DLC 还在加载 → 渲染极简 loading screen 屏蔽所有依赖 scenario 的组件
  if (!dlcReady) {
    return <DlcLoadingScreen result={dlcLoadResult} />;
  }

  return (
    <div className="wrap">
      {showByokOnboarding && (
        <ByokOnboardingModal
          onGoToSettings={() => {
            window.localStorage.setItem(BYOK_ONBOARDED_KEY, '1');
            setShowByokOnboarding(false);
            setTab('settings');
          }}
          onDismiss={() => {
            window.localStorage.setItem(BYOK_ONBOARDED_KEY, '1');
            setShowByokOnboarding(false);
          }}
        />
      )}
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>World Crossing — PoC</h1>
        <p className="muted">
          跨剧本 AI 队友 · 最小可跑骨架 · 已加载 <b>{dlcCount()}</b> 个 DLC 剧本
        </p>
      </header>

      <nav className="row" style={{ marginBottom: 16 }}>
        {(
          [
            ['plaza', '广场'],
            ['chat', '聊天'],
            ['memory', '记忆固化'],
            ['portrait', '立绘'],
            ['models', '模型路由'],
            ['settings', '设置 / 凭证'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? 'primary' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto' }} className="muted">
          {statusText}
        </span>
      </nav>

      {/* I-series:首次进入应用强制弹 Onboarding。filled=false 时遮罩,无法跳过。 */}
      {!userProfile.filled && (
        <OnboardingModal
          onSubmit={(patch) => {
            plaza.setUserProfile(patch);
            // subscribePlaza 触发 refreshUserProfile,模态自动消失
          }}
        />
      )}

      {/* I-series:点了"进入"按钮的副本 → 弹 EntryModal 等用户选 soul/body + 填愿望 */}
      {pendingEntry && (
        <EntryModal
          scenarioId={pendingEntry.scenarioId}
          startSceneId={pendingEntry.startSceneId}
          userProfile={userProfile}
          onCancel={() => setPendingEntry(null)}
          onSubmit={async (entry) => {
            const sc = getScenario(pendingEntry.scenarioId);
            if (!sc) {
              setPendingEntry(null);
              return;
            }
            // 1) 原力扣 + ScenarioProgress 建立 + 携带快照写入
            const r = plaza.enterScenario(
              sc.id,
              sc.entryCost,
              pendingEntry.startSceneId,
              entry.loadout,
            );
            if (!r.ok) {
              alert(r.reason);
              setPendingEntry(null);
              return;
            }
            // 2) 写入身份 + 愿望(wishesGranted 在 EntryModal 内部已摇好)
            plaza.setScenarioEntry(sc.id, {
              entryMode: entry.entryMode,
              wishes: entry.wishes,
              wishesGranted: entry.wishesGranted,
            });
            // 2.5) 动态剧本:初始化 currentLocation 为 scenario.initialLocation
            //      (静态剧本 / scenes 模式:scenario.locations 为空 → getInitialLocation 返 null → 不设)
            const initLoc = getInitialLocation(sc);
            if (initLoc) plaza.setCurrentLocation(initLoc);
            // 3) 关闭模态 + 切 tab(不等 M4 生成 — 它异步进 ChatTab 后再注入)
            setPendingEntry(null);
            setInScenarioId(sc.id);
            setTab('chat');
            // 4) M4:body 模式 → 异步生穿越背景,完成时 setBodyEntryContext
            if (entry.entryMode === 'body') {
              void generateBodyEntryContext(sc, userProfile, entry.wishes).then((ctx) => {
                if (ctx && ctx.trim()) plaza.setBodyEntryContext(sc.id, ctx);
              });
            }
          }}
        />
      )}

      {tab === 'plaza' && (
        <PlazaTab
          onEnterScenario={(id, startSceneId) => {
            // I-series:不再直接 enterScenario,改为打开 EntryModal 让玩家选身份 + 填愿望
            setPendingEntry({ scenarioId: id, startSceneId });
          }}
          onExitScenario={() => setInScenarioId(null)}
          onForceRefresh={refreshInScenario}
        />
      )}
      {/*
        ChatTab 永远 mount(只用 display 控制可见)。
        原因:切走时 React 会 unmount,正在跑的 fetch 响应没地方落,setState 失败 → 看着像被"打断"。
        永远挂着 + display:none,LLM 响应能正常写入,切回来无缝。
      */}
      <div style={{ display: tab === 'chat' ? 'block' : 'none' }}>
        <ChatTab
          onKeyChange={refreshHasKey}
          inScenarioId={inScenarioId}
          isVisible={tab === 'chat'}
          onReturnToPlaza={() => {
            setInScenarioId(null);
            setTab('plaza');
          }}
          onNavigateToTab={setTab}
        />
      </div>
      {tab === 'memory' && <MemoryTab />}
      {tab === 'portrait' && <PortraitTab />}
      {tab === 'models' && <ModelsTab onPresetChange={refreshPreset} />}
      {tab === 'settings' && <SettingsTab onChanged={() => { refreshHasKey(); refreshMode(); }} />}

      {/* LAUNCH-T7:法务 footer + 隐私声明 */}
      <SiteFooter />
    </div>
  );
}

// ─── LAUNCH-T7:法务 footer ─────────────────────────────────────────
//
// 公网试玩部署必须有的最低法务披露:
//   - 同人 / 非商业声明
//   - 隐私:不收集 / BYOK / 本地存储(很强,因为我们真的什么都不存)
//   - 涉及 IP 列表(黄易 / Games Workshop 等)+ 归原作者所有
//
// dev 模式也显示(便于本地校对文案),没什么副作用。

function SiteFooter() {
  const [showDetails, setShowDetails] = useState(false);
  return (
    <footer
      style={{
        marginTop: 40,
        paddingTop: 20,
        borderTop: '1px solid #2a2d3e',
        fontSize: 11,
        color: '#888',
        textAlign: 'center',
        lineHeight: 1.7,
      }}
    >
      <div>
        <b style={{ color: '#aaa' }}>World Crossing PoC</b> · 同人 fan project · 与各 IP 版权方无关 ·
        仅供个人非商业试玩
      </div>
      <div style={{ marginTop: 2 }}>
        🔒 无账号 · 不收集任何数据 · 所有进度只存你浏览器 · API 调用 BYOK 直发第三方
      </div>
      <div style={{ marginTop: 6 }}>
        <a
          onClick={() => setShowDetails((v) => !v)}
          style={{ color: '#7aa', cursor: 'pointer', textDecoration: 'underline', fontSize: 11 }}
        >
          {showDetails ? '收起完整声明 ▲' : '完整声明 / 涉及作品 / 隐私详版 ▼'}
        </a>
      </div>
      {showDetails && (
        <div
          style={{
            marginTop: 12,
            padding: 16,
            background: '#0f1119',
            border: '1px solid #2a2d3e',
            borderRadius: 6,
            textAlign: 'left',
            color: '#aaa',
            maxWidth: 720,
            margin: '12px auto 0',
          }}
        >
          <h4 style={{ marginTop: 0, color: '#ddd' }}>📜 完整声明</h4>

          <p>
            本站(World Crossing PoC)是一个由社区维护的、由 LLM 驱动的角色扮演同人 demo。
            所有剧本、人设、世界观借用自第三方作品,版权归原作者 / 版权方所有。本站<b>不出售、
            不展示广告、不收取任何费用</b>,亦未与任何 IP 持有方建立商业关系。如版权方认为某剧本
            构成侵权,请联系我们移除。
          </p>

          <h4 style={{ color: '#ddd' }}>涉及主要作品</h4>
          <ul style={{ paddingLeft: 18, marginTop: 4 }}>
            <li>《大唐双龙传》— 黄易</li>
            <li>《战锤 40,000》— Games Workshop Ltd.</li>
            <li>《云荒》系列 — 沧月 / 苍狼</li>
            <li>其他用户自创剧本 — 归各自作者所有</li>
          </ul>

          <h4 style={{ color: '#ddd' }}>🔒 隐私声明</h4>
          <ul style={{ paddingLeft: 18, marginTop: 4 }}>
            <li>本站<b>不收集</b>任何个人身份数据(无注册 / 无登录 / 无 cookie 追踪)</li>
            <li>所有游戏进度只存在你浏览器 localStorage,可随时在设置导出 / 清空</li>
            <li>
              你提供的 LLM API key 只存你浏览器,调用从你浏览器直接发给对应供应商(OpenAI /
              Anthropic / DeepSeek);本站服务器仅做必要的 CORS 转发,不持久化 / 不日志
            </li>
            <li>关闭浏览器或清缓存 = 完全退场,无任何残留</li>
          </ul>

          <h4 style={{ color: '#ddd' }}>⚠ 内容声明</h4>
          <p>
            对话内容由 LLM 实时生成,可能出现与原作设定不符 / 不当 / 错误的内容。请勿当作官方设定
            参考。<b>本站对生成内容不负任何责任。</b>
          </p>

          <div style={{ marginTop: 12, fontSize: 11, color: '#666' }}>
            如有问题或建议,可通过 GitHub Issues 反馈(部署方填写实际链接)。
          </div>
        </div>
      )}
    </footer>
  );
}

// ─── Friendly 错误卡片 ───────────────────────────────────────────────
//
// LAUNCH-T5:把原来的 "错误:所有 lane 都不可用..." 单行红字改成分类卡片。
// 检测 3 类常见错误,给出明确下一步:
//   1) 缺 API key       → 跳"设置 Tab"填一个
//   2) 网络全挂(TLS / 所有 lane fail) → 给排查清单 + 跳"模型路由"换 lane
//   3) 其他              → 原样 + 关闭按钮
//
// 父组件传 onNavigateToTab(实际是 setTab),按钮跨 tab 跳。原始错误信息留在
// <details> 里,折叠默认不显示(避免吓人但保留 debug 能力)。

function FriendlyError({
  error,
  onDismiss,
  onNavigateToTab,
}: {
  error: string;
  onDismiss: () => void;
  onNavigateToTab: (tab: Tab) => void;
}) {
  const lower = error.toLowerCase();
  const isMissingKey =
    lower.includes('api key 未设置') ||
    (lower.includes('api key') && (lower.includes('未') || lower.includes('missing'))) ||
    lower.includes('api key 无效');
  const isAllFailed = error.includes('所有 lane') || lower.includes('all lanes');
  const isTlsLike =
    lower.includes('tls') ||
    lower.includes('handshake') ||
    lower.includes('eof') ||
    lower.includes('fetch failed') ||
    lower.includes('network');
  const isPublic = isPublicMode();

  // Case 1:缺 key — 最常见的"按钮明确"场景
  if (isMissingKey) {
    return (
      <div className="card" style={{ borderColor: '#a44' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fbb' }}>🔑 还没填 API key</div>
        <p className="muted" style={{ marginTop: 6, fontSize: 13 }}>
          {isPublic
            ? '本站需要你自己的 LLM API key 才能跟 NPC 对话(我们不收集 / 不存储任何 key,所有调用从你浏览器直接出去)。'
            : '当前任务所选 lane 需要 API key,请去设置填一个,或在模型路由里换条 lane。'}
        </p>
        <div className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center' }}>
          <button
            onClick={() => onNavigateToTab('settings')}
            style={{ background: '#3a5a7c', color: '#fff', padding: '6px 14px' }}
          >
            去设置填 key
          </button>
          {!isPublic && (
            <button onClick={() => onNavigateToTab('models')} style={{ padding: '6px 14px' }}>
              换条 lane
            </button>
          )}
          <button onClick={onDismiss} className="muted" style={{ marginLeft: 'auto' }}>
            关闭
          </button>
        </div>
      </div>
    );
  }

  // Case 2:网络全挂 — fallback 链全失败
  if (isAllFailed || isTlsLike) {
    return (
      <div className="card" style={{ borderColor: '#a44' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fbb' }}>🌐 LLM 服务连不上</div>
        <p style={{ marginTop: 6, fontSize: 13, color: '#ddd' }}>
          所有可用的 lane 都失败了。可能原因:
        </p>
        <ul style={{ marginTop: 4, fontSize: 12, paddingLeft: 20, color: '#bbb', lineHeight: 1.6 }}>
          <li>
            API key 没填 / 失效 →{' '}
            <a
              onClick={() => onNavigateToTab('settings')}
              style={{ color: '#7aa', cursor: 'pointer', textDecoration: 'underline' }}
            >
              去检查
            </a>
          </li>
          <li>
            当前任务路由到的 lane 不可用 →{' '}
            <a
              onClick={() => onNavigateToTab('models')}
              style={{ color: '#7aa', cursor: 'pointer', textDecoration: 'underline' }}
            >
              换条 lane
            </a>
          </li>
          <li>网络问题(TLS handshake / DNS / VPN)— 等一会儿再试</li>
          {!isPublic && (
            <li>
              本地 bridge / Gemma 没启 → 重跑 <code>npm run dev:all</code> 或双击 Gemma 启动脚本
            </li>
          )}
        </ul>
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: '#888' }}>
            原始错误信息
          </summary>
          <code
            style={{
              fontSize: 10,
              color: '#a77',
              display: 'block',
              marginTop: 4,
              wordBreak: 'break-all',
              padding: 8,
              background: '#0a0a14',
              borderRadius: 4,
            }}
          >
            {error}
          </code>
        </details>
        <div className="row" style={{ gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
          <button onClick={onDismiss} className="muted">
            关闭
          </button>
        </div>
      </div>
    );
  }

  // Case 3:其他错误,原样 + dismiss
  return (
    <div className="card" style={{ borderColor: '#a44' }}>
      <div style={{ color: '#fbb', fontSize: 13 }}>⚠ {error}</div>
      <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
        <button onClick={onDismiss} className="muted">
          关闭
        </button>
      </div>
    </div>
  );
}

// ─── BYOK 新手 Onboarding Modal ──────────────────────────────────────
//
// LAUNCH-T4:public 模式(部署到公网的 production build)+ 用户没填任何 BYOK key
// + 没 dismiss 过 → 首屏弹 onboarding。讲清楚:
//   1) 这是个 LLM 驱动的角色扮演 PoC
//   2) 隐私保证:不收集数据 / key 留浏览器
//   3) 怎么搞个 API key(三选一,推荐 DeepSeek 因为便宜)
//   4) "去填 key" 按钮跳设置 tab
//
// 一旦填了任何 key(deepseek/openai/anthropic),或者用户点了 dismiss,
// 都会 set localStorage wc_poc_byok_onboarded=1,后续不再弹。

const BYOK_ONBOARDED_KEY = 'wc_poc_byok_onboarded';

function ByokOnboardingModal({
  onGoToSettings,
  onDismiss,
}: {
  onGoToSettings: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={onDismiss}
    >
      <div
        className="card"
        style={{
          maxWidth: 560,
          width: '100%',
          padding: 28,
          background: '#141826',
          border: '1px solid #3a3d4e',
          maxHeight: '90vh',
          overflow: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ marginTop: 0, color: '#ffd86b' }}>👋 欢迎来 World Crossing</h2>
        <p style={{ color: '#ddd' }}>
          跟剧本里的 NPC 自由对话,推进剧情、组队、战斗、解谜 — 全部由 LLM 实时生成。
        </p>

        <div
          style={{
            background: '#1a2030',
            padding: 12,
            borderRadius: 6,
            margin: '16px 0',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6, color: '#9cf' }}>🔒 隐私保证</div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 13,
              lineHeight: 1.6,
              color: '#bbb',
            }}
          >
            <li>
              本站<b>不收集任何用户数据</b>,所有进度只存在你浏览器 localStorage
            </li>
            <li>API key 由你提供(BYOK),只存在你浏览器,服务端不持久化</li>
            <li>LLM 调用 client → 第三方,服务器仅做必要的 CORS 转发,不日志 key</li>
            <li>关掉浏览器或清缓存 = 完全退场,我们没有任何账号系统</li>
          </ul>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            🔑 开始之前你需要一个 LLM API key
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 13,
              lineHeight: 1.8,
              color: '#ddd',
            }}
          >
            <li>
              <b>DeepSeek</b>($0.07/$0.28 per 1M tok,最便宜,推荐){' '}
              —{' '}
              <a
                href="https://platform.deepseek.com/api_keys"
                target="_blank"
                rel="noreferrer"
                style={{ color: '#7aa' }}
              >
                申请 key
              </a>
            </li>
            <li>
              <b>OpenAI</b>(GPT-5 系列){' '}
              —{' '}
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noreferrer"
                style={{ color: '#7aa' }}
              >
                申请 key
              </a>
            </li>
            <li>
              <b>Anthropic</b>(Claude Sonnet,对话最自然){' '}
              —{' '}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noreferrer"
                style={{ color: '#7aa' }}
              >
                申请 key
              </a>
            </li>
          </ul>
        </div>

        <p className="muted" style={{ fontSize: 12, marginBottom: 16 }}>
          填任意一个就能开始,也可以同时填多个让 fallback 链兜底。
          <br />
          <b>想接 OpenRouter / Groq / 自建模型</b>等其他 OpenAI 兼容服务?进站后去
          <b style={{ color: '#9cf' }}>"模型路由" Tab</b> → "🛠 自定义 Lane",填 base URL + model + key。
        </p>

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onDismiss} className="muted">
            我先看看
          </button>
          <button
            onClick={onGoToSettings}
            style={{
              background: '#3a5a7c',
              color: '#fff',
              padding: '8px 16px',
              fontWeight: 600,
            }}
          >
            去设置填 key →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 聊天 Tab ──────────────────────────────────────────────────────

function ChatTab({
  onKeyChange,
  onReturnToPlaza,
  inScenarioId,
  isVisible,
  onNavigateToTab,
}: {
  onKeyChange: () => void;
  onReturnToPlaza: () => void;
  /** S1+S2 修复:从 Home 顶层传入,跨剧本路由依赖这个 */
  inScenarioId: string | null;
  /** F10:tab 切回 chat 时为 true,用于 refresh 跨 tab 改过的偏好 / plaza state */
  isVisible: boolean;
  /** T5:friendly error 卡片里的"去设置"/"换 lane"按钮要能跨 tab 跳转 */
  onNavigateToTab: (tab: Tab) => void;
}) {
  // S1 修复:scenarioId 不再硬编码 DEFAULT_SCENARIO_ID,而是优先用 plaza 当前所在剧本。
  // 玩家从广场进了"红楼梦"自定义剧本 → 这里就是红楼梦的 id → 加载红楼梦的 NPC 选择条。
  const scenarioId = inScenarioId ?? DEFAULT_SCENARIO_ID;
  const scenario = getScenario(scenarioId);
  const defaultNpcId = scenario?.defaultNpcId ?? 'starmail-npc-halia';

  // 当前对话的角色 ID(初始 = 剧本默认 NPC,挂载后会被 sessionStorage 里的覆盖)
  // 注意:可能是 NPC(starmail-npc-xxx)也可能是 companion(companion-xxx)
  const [currentNpcId, setCurrentNpcId] = useState<string>(defaultNpcId);
  /**
   * F2:跟随 currentNpcId 的 ref。
   * 异步回调(maybeDetectAndSwapEmotion / maybeCompanionBanter / maybeCompressHistory)
   * 在自己 closure 里看到的 currentNpcId 是旧值;用 ref 实时同步,允许它们做"用户是否还在原 NPC"的判断。
   */
  const currentNpcIdRef = useRef<string>(currentNpcId);
  useEffect(() => {
    currentNpcIdRef.current = currentNpcId;
  }, [currentNpcId]);

  /**
   * G11:plaza 写入时 tick++,让所有依赖 plaza state 的 useMemo 失效重算。
   * 不再每 render 都 plaza.get() 读 localStorage。
   */
  const [plazaTick, setPlazaTick] = useState(0);
  useEffect(() => {
    const unsub = subscribePlaza(() => setPlazaTick((t) => t + 1));
    return unsub;
  }, []);

  /** 当前对话目标(包装 NPC 或 companion 为统一 DialogueTarget) */
  // G11:用 useMemo 缓存,只在 currentNpcId/scenarioId/plaza 变动时重算
  const currentTarget: DialogueTarget | undefined = useMemo(
    () => getDialogueTarget(currentNpcId, scenarioId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentNpcId, scenarioId, plazaTick],
  );
  const currentNpc: CharacterSpec | undefined = currentTarget?.spec;
  /** 当前对话目标是否是队友(影响 UI 显示 + portrait 加载方式) */
  const currentIsCompanion = currentTarget?.kind === 'companion';

  // SSR 兼容: 初始空,切 NPC effect 会立刻填充
  const [messages, setMessages] = useState<Message[]>([]);
  // F8:per-tab input 隔离 — 对话框写一半切到行动 tab 不应该被当成行动发出
  const [inputs, setInputs] = useState<{ dialogue: string; action: string }>({
    dialogue: '',
    action: '',
  });
  const [loading, setLoading] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [returningToPlaza, setReturningToPlaza] = useState(false);
  const companionSummary = DEFAULT_COMPANION_SUMMARY; // PoC 阶段固定,未来从队友卡读
  const [error, setError] = useState<string | null>(null);
  /** C1:输入模式 — 'dialogue' 跟身边角色说话 / 'action' 自由行动让 Director 描述反应 */
  const [inputMode, setInputMode] = useState<'dialogue' | 'action'>('dialogue');
  /** 当前 tab 的输入内容(代理到 inputs[inputMode]) */
  const input = inputs[inputMode];
  const setInput = (v: string) => setInputs((prev) => ({ ...prev, [inputMode]: v }));
  /**
   * G16:taskTag 不再让玩家手选 — 根据 inputMode + 目标 tier 自动派生。
   *   - ⚡ 行动 → director.beat
   *   - 💬 对话 + companion → companion.deep
   *   - 💬 对话 + core NPC → npc.core.dialogue
   *   - 💬 对话 + side/passing NPC → npc.side.dialogue
   * UI 上只展示路由结果给玩家看,不让他选(因为当前 UNIFIED_MATRIX 共用,选了也无差别)。
   */
  const taskTag = useMemo<TaskTag>(() => {
    if (inputMode === 'action') return 'director.beat';
    if (currentIsCompanion) return 'companion.deep';
    const progress = plaza.getScenarioProgress(scenarioId);
    const scene = scenario?.scenes && progress?.currentSceneId
      ? scenario.scenes.find((s) => s.id === progress.currentSceneId)
      : undefined;
    const tier = classifyCharacter(currentNpcId, scenario, scene);
    return tier === 'core' ? 'npc.core.dialogue' : 'npc.side.dialogue';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputMode, currentIsCompanion, currentNpcId, scenarioId, plazaTick]);
  const [lastLaneUsed, setLastLaneUsed] = useState<LaneId | null>(null);
  const [lastFallback, setLastFallback] = useState<LaneId[] | null>(null);
  const [lastDuration, setLastDuration] = useState<number | null>(null);
  const [portrait, setPortrait] = useState<string | null>(null);
  /** 当前显示的情绪 — 切 NPC 重置 neutral,emotion-detect 完成后会被更新 */
  const [currentEmotion, setCurrentEmotion] = useState<Emotion>('neutral');
  /**
   * Per-(character, emotion) loading state — key = `${characterId}::${emotion}`。
   * 允许同 NPC 的多张情绪并发生成,也允许多 NPC 排队生成时各自的进度独立追踪。
   */
  const [portraitLoadingMap, setPortraitLoadingMap] = useState<Record<string, boolean>>({});
  const [portraitError, setPortraitError] = useState<string | null>(null);
  const portraitLoading = !!portraitLoadingMap[`${currentNpcId}::${currentEmotion}`];
  /**
   * 立绘偏好 — G11:用 useMemo 跟随 plazaTick 自动失效,plaza 改了立刻反应。
   * 不再需要手动 refreshPortraitPrefs / isVisible 监听 / storage 监听。
   */
  const portraitPrefs = useMemo(
    () => plaza.getPortraitPrefs(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plazaTick],
  );
  const refreshPortraitPrefs = () => setPlazaTick((t) => t + 1); // 调用方仍可以手动 nudge
  /** 当前 NPC 是否启用多情绪('on' / 'off' / 'ask') */
  const emotionPolicy: 'on' | 'off' | 'ask' = currentNpc
    ? resolveEmotionPolicy(portraitPrefs, currentNpcId)
    : 'off';
  /** 场景插画:scenarioId+sceneId → dataUrl(从 sessionStorage 读) */
  const [sceneImage, setSceneImage] = useState<string | null>(null);
  const [sceneImageLoading, setSceneImageLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 当前任务标签解析到的目标 lane(路由预览)
  const targetLane = typeof window !== 'undefined' ? router.resolveLane(taskTag) : 'local_gemma';

  // ① Mount: 把 sessionStorage 里上次选的角色同步过来(NPC 或 companion 都允许)
  useEffect(() => {
    const stored = readCurrentNpcId();
    if (stored && getDialogueTarget(stored, scenarioId) && stored !== currentNpcId) {
      setCurrentNpcId(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // F12:currentTarget 失效(比如选中的 companion 被 toggle 成 inactive)→ 切回 default NPC
  useEffect(() => {
    if (!inScenarioId) return;
    if (currentTarget) return;
    // currentNpcId 找不到目标 → 退回剧本默认 NPC
    setCurrentNpcId(defaultNpcId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTarget, inScenarioId]);

  // P1 新增:优先返回 NPC.appearance.portraits[] 里匹配 emotion / default 的 user_uploaded 立绘 URL
  // 优先级:① context === emotion ② default_portrait_id 指向的 ③ 第一张 ④ null(走 SDXL)
  const resolveUploadedPortrait = (npcId: string, emotion: Emotion): string | null => {
    const target = getDialogueTarget(npcId, scenarioId);
    if (!target) return null;
    const portraits = target.spec.appearance?.portraits;
    if (!portraits || portraits.length === 0) return null;
    const byContext = portraits.find((p) => p.context === emotion);
    if (byContext) return byContext.url;
    const defaultId = target.spec.appearance?.default_portrait_id;
    if (defaultId) {
      const byDefault = portraits.find((p) => p.id === defaultId);
      if (byDefault) return byDefault.url;
    }
    return portraits[0]?.url ?? null;
  };

  // ② 切角色: 加载该角色的会话 + 立绘(默认 neutral) + 重置错误
  // companion 用 profile.images 当立绘(用户导入的);NPC 优先用 user_uploaded portrait,否则走 SDXL 缓存
  // F1:玩家还没进剧本时不预读不烧 SDXL — ChatTab 永远 mount 但只在 inScenarioId 有值后激活
  useEffect(() => {
    if (!inScenarioId) return;
    setMessages(readMessagesFor(scenarioId, currentNpcId));
    setCurrentEmotion('neutral');
    if (isCompanionId(currentNpcId)) {
      const c = plaza.get().companions.find((x) => x.characterId === currentNpcId);
      setPortrait(c ? profileBaseImage(c.profile) : null);
    } else {
      // P1:user_uploaded portrait 优先 → SDXL cache fallback
      const uploaded = resolveUploadedPortrait(currentNpcId, 'neutral');
      setPortrait(uploaded ?? readPortrait(currentNpcId, 'neutral'));
    }
    setPortraitError(null);
    setError(null);
    refreshPortraitPrefs(); // 每次切角色重读 prefs(用户可能在别处改过)
    if (typeof window !== 'undefined') {
      writeCurrentNpcId(currentNpcId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNpcId, inScenarioId]);

  /** setMessages 的 wrapper: 同时写 storage,避开 useEffect 时序坑(避免空数组冲掉已存会话)。 */
  const updateMessages = (next: Message[]) => {
    setMessages(next);
    writeMessagesFor(scenarioId, currentNpcId, next);
  };

  /**
   * 按需生成指定 NPC + 情绪的立绘。
   * 缓存命中 / 正在生 / base_prompt 缺失 → 都早返;否则后台调 SDXL,完成后写缓存。
   * 如果生的是"当前 NPC + 当前情绪",同步更新 UI。
   */
  const ensurePortraitFor = (npcId: string, emotion: Emotion) => {
    if (typeof window === 'undefined') return;
    // G15:用 getDialogueTarget 统一查找,scope 到当前剧本 + 处理 companion
    // companion 的 base_prompt 是 `[companion ...]`,isPortraitGeneratable 返 false → 自然早返
    const target = getDialogueTarget(npcId, scenarioId);
    if (!target) return;
    const npc = target.spec;
    if (readPortrait(npcId, emotion)) return; // 已缓存
    if (!isPortraitGeneratable(npc)) return;
    if (!npc.appearance.base_prompt.trim()) {
      if (npcId === currentNpcId)
        setPortraitError('(此 NPC 缺立绘 prompt,跳过自动生图)');
      return;
    }
    const loadKey = `${npcId}::${emotion}`;
    setPortraitLoadingMap((m) => (m[loadKey] ? m : { ...m, [loadKey]: true }));
    setPortraitError(null);
    const negative =
      npc.appearance.negative_prompt || 'deformed, extra limbs, low quality, blurry';
    const emotionPrompt = buildEmotionPrompt(npc.appearance.base_prompt, emotion);

    // IMAGE-T5:运行模式分流
    //   dev   → /api/local-sdxl(本地 Gemma UI / Gradio,免费)
    //   public → /api/image-compat(用户自加的 Image Lane,BYOK)
    //
    // public 模式下若未配 Image Lane,静默跳过 — 不报错给用户(他可能没打算用在线生图,
    // 走"上传图片"路径就够了)。控制台 warn 一行供诊断。
    const publicMode = isPublicMode();
    let fetchPromise: Promise<Response>;
    if (publicMode) {
      const imageLanes = listImageLanes();
      if (imageLanes.length === 0) {
        if (typeof console !== 'undefined') {
          console.warn(
            `[auto-portrait] public 模式未配 Image Lane,跳过 ${npc.identity.name}/${emotion}。` +
              ' 去 ModelsTab → 🎨 自定义 Image Lane 加一条。',
          );
        }
        setPortraitLoadingMap((m) => {
          const next = { ...m };
          delete next[loadKey];
          return next;
        });
        return;
      }
      // 默认用列表第一条 lane(用户加的就是想用它,不做复杂选择 UI)
      const lane = imageLanes[0];
      fetchPromise = fetch('/api/image-compat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${lane.apiKey}`,
          'X-Wc-Base-Url': lane.baseUrl,
        },
        body: JSON.stringify({
          model: lane.model,
          prompt: emotionPrompt,
          negativePrompt: negative,
          size: lane.size,
          quality: lane.quality,
          responseFormat: lane.responseFormat ?? 'b64_json',
        }),
      });
    } else {
      fetchPromise = fetch('/api/local-sdxl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: emotionPrompt,
          negative,
          // 不同情绪用不同 seed → 跟 neutral 拉开差异(同 seed 在 SDXL 4-step 会几乎一样)
          seed: 42 + ALL_EMOTIONS.indexOf(emotion),
          steps: 4,
          cfg: 0.0,
        }),
      });
    }
    fetchPromise
      .then(async (resp) => {
        const text = await resp.text();
        let data: { dataUrl?: string; error?: string; detail?: string };
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
        }
        if (!resp.ok) {
          throw new Error(
            `${data.error ?? `HTTP ${resp.status}`}${data.detail ? ': ' + data.detail : ''}`,
          );
        }
        if (!data.dataUrl) throw new Error('SDXL 响应缺 dataUrl');
        writePortrait(npcId, emotion, data.dataUrl);
        // 只在用户当前停在这个 NPC + 这个情绪时,主动更新 UI
        if (npcId === currentNpcId && emotion === currentEmotion) {
          setPortrait(data.dataUrl);
        }
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (npcId === currentNpcId && emotion === currentEmotion) setPortraitError(msg);
        console.warn(`[auto-portrait] ${npc.identity.name}/${emotion} 立绘失败:`, msg);
      })
      .finally(() => {
        setPortraitLoadingMap((m) => {
          const next = { ...m };
          delete next[loadKey];
          return next;
        });
      });
  };

  // ③ 切 NPC 时如果该 NPC 没 neutral 立绘 + 能生图,后台调 SDXL
  // F1:玩家还在广场时不烧 SDXL
  // P1:如果已有 user_uploaded portrait,跳过 SDXL(避免浪费一次生成 + 后续 dataUrl 覆盖 uploaded)
  useEffect(() => {
    if (!inScenarioId) return;
    if (resolveUploadedPortrait(currentNpcId, 'neutral')) return; // user 已经提供,不烧 SDXL
    ensurePortraitFor(currentNpcId, 'neutral');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNpcId, inScenarioId]);

  // ③.b 若开启多情绪,后台按 tier 配额预生(neutral 已由 ③ 处理)
  // core 角色 5 种全开,side 3 种,passing 只 neutral(不预生)
  useEffect(() => {
    if (!inScenarioId) return; // F1:玩家在广场时不预生
    if (emotionPolicy !== 'on') return;
    if (!currentNpc || !isPortraitGeneratable(currentNpc)) return;
    if (!currentNpc.appearance.base_prompt.trim()) return;
    const progress = plaza.getScenarioProgress(scenarioId);
    const scene = scenario?.scenes && progress?.currentSceneId
      ? scenario.scenes.find((s) => s.id === progress.currentSceneId)
      : undefined;
    const tier = tierConfigFor(currentNpcId, scenario, scene);
    const emotionBudget = tier.emotionsMax; // neutral 已经占 1 个
    if (emotionBudget <= 1) return; // passing tier 只 neutral
    // 80% 软压缩:超 budget 时按 ALL_EMOTIONS 顺序保留前 N 个
    maybeCompressPortraitsFor(currentNpcId, emotionBudget);
    // 决定要预生哪些情绪(按 ALL_EMOTIONS 顺序前 emotionBudget 个)
    const allowed = ALL_EMOTIONS.slice(0, emotionBudget);
    const others = allowed.filter((e) => e !== 'neutral');
    const timers: number[] = [];
    others.forEach((e, idx) => {
      const t = window.setTimeout(() => {
        ensurePortraitFor(currentNpcId, e);
      }, 1200 * (idx + 1));
      timers.push(t);
    });
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNpcId, emotionPolicy, inScenarioId]);

  // ③.c 当前 emotion 变化时 → 优先用 user_uploaded 匹配 context 的图,否则走 SDXL cache
  useEffect(() => {
    if (!inScenarioId) return; // F1
    if (!currentNpc) return;
    // P1:user_uploaded 优先(每个 emotion 都先查一次,因为不同 emotion 可能映射到不同上传图)
    const uploaded = resolveUploadedPortrait(currentNpcId, currentEmotion);
    if (uploaded) {
      setPortrait(uploaded);
      setPortraitError(null);
      return;
    }
    const cached = readPortrait(currentNpcId, currentEmotion);
    if (cached) {
      setPortrait(cached);
      setPortraitError(null);
    } else if (emotionPolicy !== 'off') {
      // 未缓存且未关闭多情绪 → 按需生
      ensurePortraitFor(currentNpcId, currentEmotion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEmotion, currentNpcId, inScenarioId]);

  // ④ 场景插画:根据当前剧本进度 + scene.imagePrompt,按需生 banner 底图
  // 触发条件:scenes 骨架存在 + currentSceneId 有值 + 该 scene 有 imagePrompt + 偏好开启
  // 缓存命中直接显示;否则后台生成。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setSceneImage(null);
    if (!inScenarioId) return; // F1:广场不生场景图
    if (!portraitPrefs.sceneImagesEnabled) return;
    if (!scenario?.scenes || scenario.scenes.length === 0) return;
    const progress = plaza.getScenarioProgress(scenarioId);
    const sceneId = progress?.currentSceneId ?? scenario.startSceneId ?? scenario.scenes[0]?.id;
    if (!sceneId) return;
    const scene = scenario.scenes.find((s) => s.id === sceneId);
    if (!scene?.imagePrompt?.trim()) return;
    const cached = readSceneImage(scenarioId, sceneId);
    if (cached) {
      setSceneImage(cached);
      return;
    }
    let cancelled = false;
    setSceneImageLoading(true);
    generateSceneImage(scene.imagePrompt)
      .then((dataUrl) => {
        if (cancelled) return;
        writeSceneImage(scenarioId, sceneId, dataUrl);
        setSceneImage(dataUrl);
      })
      .catch((e) => {
        console.warn(`[scene-image] ${scene.name} 场景图失败:`, e);
      })
      .finally(() => {
        if (!cancelled) setSceneImageLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // 用 messages.length 当 tick 因为 advanceStory 切 scene 后 messages 会变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioId, messages.length, portraitPrefs.sceneImagesEnabled, inScenarioId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading, advancing]);

  async function send() {
    if (!input.trim() || loading || advancing || !currentNpc) return;
    const userMsg: Message = { role: 'user', content: input.trim() };
    const newMessages = [...messages, userMsg];
    updateMessages(newMessages);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      // A1+A2+A3:从 plaza 现取队友/物品/记忆/关系/当前 scene,注入 NPC system prompt
      // I-series:同步注入"玩家身份"(soul/body)+"愿望(granted/denied)"两段
      const npcCtx = buildNpcPromptContext(currentNpcId, scenarioId);
      // 重剧本轻框架:剧本可通过 scenario.llmConfig 覆盖 model/temperature/maxTokens
      const llm = scenario?.llmConfig;
      const combatStatsNow = plaza.get().currentCombatStats;
      // E 方案:渐进披露 — 按玩家消息特征决定 chatMode (casual 模式下 WC-EVENT/STAT 段大幅瘦身)
      const chatMode = detectChatMode(userMsg.content, combatStatsNow);
      const resp = await callLLM({
        systemPrompt: buildSystemPromptForCharacter(currentNpc, {
          scenarioId,
          currentSceneId: npcCtx.currentSceneId ?? undefined,
          currentLocation: npcCtx.currentLocation,
          // 世界控制三件套(connections/sceneState/artifacts/visitCount/completedBeats)
          currentSceneStateOverrides: npcCtx.currentSceneStateOverrides,
          discoveredArtifactIds: npcCtx.discoveredArtifactIds,
          currentLocationVisitCount: npcCtx.currentLocationVisitCount,
          completedBeatIds: npcCtx.completedBeatIds,
          activeCompanions: npcCtx.activeCompanions,
          inventory: npcCtx.inventory,
          relationship: npcCtx.relationship,
          memories: npcCtx.memories,
          summary: npcCtx.summary, // G14:注入跨 session 持久化的摘要
          playerIdentity: resolvePlayerIdentityForPrompt(scenarioId),
          wishes: resolveWishesForPrompt(scenarioId),
          // 隐藏数值系统:把当前剧本内主角+携带队友的 HP/体力/意志 给 LLM 看
          combatStats: combatStatsNow,
          chatMode,
        }),
        messages: newMessages,
        task: taskTag,
        model: llm?.model,
        temperature: llm?.temperature,
        maxTokens: llm?.maxTokens,
      });
      // WC-STAT / WC-EVENT 一站处理:解析数值变化(静默)+ 死亡 / 损毁(弹窗)+ 返回净化文本
      const cleanedText = processWcMarkers(resp.text, 'npc-chat');

      // WC-TRUST:NPC 自评跟玩家关系的变化(只在 NPC chat 路径生效,Director 有自己的 trustDeltas)
      const trustEvents = parseWcTrustEvents(resp.text);
      if (trustEvents.length > 0) {
        const t = trustEvents[0]; // 一次回复最多 1 个(parser 已 break 在 1 上)
        plaza.adjustRelationship(currentNpcId, scenarioId, t.delta, t.reason);
        console.log(
          `[WC-TRUST][npc-chat] ${currentNpcId} ${t.delta > 0 ? '+' : ''}${t.delta} "${t.reason}"`,
        );
      }

      // C2:对白结构指标(纯本地字符串分析,零成本派生信号)
      // 用 cleanedText 而不是 resp.text — 已剥掉 WC-* 注释,只算实际对白
      const replyMetrics = analyzeReplyStructure(cleanedText);
      recordReplyMetrics(currentNpcId, replyMetrics);
      console.debug(
        `[reply-metrics] ${currentNpcId} engagement=${replyMetrics.engagementHint} len=${replyMetrics.length} q=${replyMetrics.questionRatio.toFixed(2)} excl=${replyMetrics.exclamationRatio.toFixed(2)} self=${replyMetrics.selfRefRatio.toFixed(2)}`,
      );

      const messagesAfterNpc: Message[] = [...newMessages, { role: 'assistant', content: cleanedText }];
      updateMessages(messagesAfterNpc);
      setLastLaneUsed(resp.laneUsed ?? null);
      setLastFallback(resp.fallbackPath ?? null);
      setLastDuration(resp.durationSec ?? null);
      // 把 episodic event 临时存进 sessionStorage,记忆 tab 会读
      const events = readEvents();
      events.push(`玩家: ${userMsg.content}`);
      events.push(`${currentNpc.identity.name}: ${cleanedText}`);
      writeEvents(events);

      // B3:队友插嘴(异步,不阻塞主响应显示)
      void maybeCompanionBanter({
        npcIdAtCall: currentNpcId,
        playerMsg: userMsg.content,
        npcReply: resp.text,
        npcName: currentNpc.identity.name,
        scenario,
        baselineMessages: messagesAfterNpc,
      });

      // Ⓑ-emot:情绪检测 + 立绘切换(异步,emotionPolicy='off' 跳过)
      // C1:把"本轮是否有显式 WC-TRUST"传进去 — 兜底逻辑只在 LLM 没写 trust 时启动
      void maybeDetectAndSwapEmotion({
        npcIdAtCall: currentNpcId,
        npcName: currentNpc.identity.name,
        npcSummary: currentNpc.core_persona.summary,
        playerMessage: userMsg.content,
        npcReply: resp.text,
        hadExplicitTrustChange: trustEvents.length > 0,
        scenarioIdAtCall: scenarioId,
      });

      // 分级压缩:对话历史达到 tier 上限 80% 时,LLM 摘要旧消息(异步,不阻塞 UI)
      void maybeCompressHistory({
        npcIdAtCall: currentNpcId,
        characterName: currentNpc.identity.name,
        messagesAfterNpc,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onKeyChange();
    } finally {
      setLoading(false);
    }
  }

  /**
   * 对话历史压缩:达到 tier 上限 80% 时触发。
   * - core 角色 80 条 → 64 条触发
   * - side 角色 40 条 → 32 条触发
   * - passing 角色 20 条 → 16 条触发
   * 压缩后保留最近一半,前面的浓缩成 1 条 [摘要]。
   * 异步,失败不影响主对话。
   */
  async function maybeCompressHistory(args: {
    npcIdAtCall: string;
    characterName: string;
    messagesAfterNpc: Message[];
  }) {
    const progress = plaza.getScenarioProgress(scenarioId);
    const scene = scenario?.scenes && progress?.currentSceneId
      ? scenario.scenes.find((s) => s.id === progress.currentSceneId)
      : undefined;
    const tier = tierConfigFor(args.npcIdAtCall, scenario, scene);
    // 重剧本轻框架:剧本可覆盖触发比例(默认 0.8)
    const triggerRatio = scenario?.llmConfig?.summaryTriggerRatio;
    if (!shouldCompress(args.messagesAfterNpc.length, tier.messagesMax, triggerRatio)) return;
    try {
      const result = await compressMessages({
        characterName: args.characterName,
        messages: args.messagesAfterNpc,
        // 保留一半:压完只剩 max/2 条原始 + 1 条 [摘要] = max/2+1
        keepRecent: Math.floor(tier.messagesMax / 2),
      });
      if (!result) return;
      // G14:把摘要文本持久化到 plaza.npcSummaries(跨 session 不丢)
      plaza.setNpcSummary(args.npcIdAtCall, scenarioId, result.summaryText);
      // F2:切 NPC 后才完成?用 ref 读实时值,不是 closure 旧值
      if (args.npcIdAtCall !== currentNpcIdRef.current) {
        // 仍然落地到 sessionStorage(对的 NPC 那边),但不刷新 UI
        writeMessagesFor(scenarioId, args.npcIdAtCall, result.compressed);
        return;
      }
      updateMessages(result.compressed);
      console.info(`[compress] ${args.characterName}: 摘要 ${result.summarized} 条`);
    } catch {
      /* 静默 */
    }
  }

  // B3:队友插嘴的 banter 频次控制
  // 用 ref 而非 state,避免 send() 期间的 stale closure。
  const lastBanterAtTurnRef = useRef<number>(-99);
  const turnIndexRef = useRef<number>(0);

  /**
   * 决定 active 队友是否插嘴,并把结果异步附到对话流。
   * 不 await 整个流程 — send() 立即返回,banter 在后台跑;
   * 失败 / 不插嘴时静默,不打扰用户。
   */
  async function maybeCompanionBanter(args: {
    /** F2:调用时的 NPC id,用 ref 跟当前实时值比较防止跨 NPC 污染 */
    npcIdAtCall: string;
    playerMsg: string;
    npcReply: string;
    npcName: string;
    scenario: Scenario | undefined;
    /** banter 要追加到这个 list 后面;捕获时已包含 NPC 回复 */
    baselineMessages: Message[];
  }) {
    turnIndexRef.current++;
    // 频次:跟上次插嘴至少隔 2 轮(每 3 条对话最多 1 次)
    if (turnIndexRef.current - lastBanterAtTurnRef.current < 3) return;
    const state = plaza.get();
    const activeCompanions = state.companions.filter((c) => c.active);
    if (activeCompanions.length === 0) return;
    // 每次最多 1 个队友插嘴(挑第一个;以后可以加优先级判断)
    const c = activeCompanions[0];
    try {
      const result = await decideAndGenerateBanter({
        companion: c,
        playerMessage: args.playerMsg,
        npcReply: args.npcReply,
        npcName: args.npcName,
        scenario: args.scenario,
      });
      if (!result.line) return;
      lastBanterAtTurnRef.current = turnIndexRef.current;
      const banterContent = `${COMPANION_PREFIX}${c.profile.characterId.replace(/^companion-/, '')}] ${result.line}`;
      const updated: Message[] = [...args.baselineMessages, { role: 'assistant', content: banterContent }];
      // F2:用户切走时,banter 落到原 NPC 的历史(sessionStorage),不刷新 UI
      if (args.npcIdAtCall !== currentNpcIdRef.current) {
        writeMessagesFor(scenarioId, args.npcIdAtCall, updated);
      } else {
        updateMessages(updated);
      }
      const events = readEvents();
      events.push(`[队友] ${result.line}`);
      writeEvents(events);
    } catch {
      // 静默吞错 — 队友插嘴是 nice-to-have,不影响主对话
    }
  }

  /**
   * Ⓑ-emot:NPC 回复后跑情绪分类 + 切立绘。
   * - emotionPolicy='off':直接返,啥都不做
   * - emotionPolicy='ask':不主动 detect(避免烧本地算力)
   * - emotionPolicy='on':调 LLM 分类 → setCurrentEmotion(下游 useEffect 接管立绘加载/生成)
   *
   * fire-and-forget:失败 / 切 NPC 都静默吞,不影响主对话。
   */
  async function maybeDetectAndSwapEmotion(args: {
    npcIdAtCall: string;
    npcName: string;
    npcSummary?: string;
    playerMessage: string;
    npcReply: string;
    /** C1:本轮 LLM 是否已写显式 WC-TRUST(true → 不再用 emotion 兜底,避免双重计入) */
    hadExplicitTrustChange?: boolean;
    /** C1:scenarioId 锁定 — emotion 在异步检测完成后,玩家可能已切剧本,要 verify */
    scenarioIdAtCall?: string;
  }) {
    // 实时重读 prefs 避免 stale(send 期间用户可能在 plaza tab 切过模式)
    const policy = resolveEmotionPolicy(plaza.getPortraitPrefs(), args.npcIdAtCall);
    if (policy !== 'on') return;
    try {
      const result = await detectNpcEmotion({
        npcName: args.npcName,
        npcSummary: args.npcSummary,
        playerMessage: args.playerMessage,
        npcReply: args.npcReply,
      });
      // F2:用 ref 读实时值,closure 里的 currentNpcId 是旧值
      if (args.npcIdAtCall !== currentNpcIdRef.current) return;
      setCurrentEmotion(result.emotion);

      // C1:emotion → trust 兜底
      // 仅在 LLM 没写显式 WC-TRUST 时启动 — 避免显式 ±5 之类被多塞个 ±1 偏离 LLM 判断
      // 仅在 emotion 来自 LLM 检测时启动 — fallback 模式信号噪声太大不可信
      if (!args.hadExplicitTrustChange && result.source === 'llm' && args.scenarioIdAtCall) {
        const autoDelta = getEmotionAutoTrust(result.emotion);
        if (autoDelta !== 0) {
          plaza.adjustRelationship(
            args.npcIdAtCall,
            args.scenarioIdAtCall,
            autoDelta,
            `[自动·情绪派生:${result.emotion}]`,
          );
          console.log(
            `[WC-TRUST][auto-emotion] ${args.npcIdAtCall} ${autoDelta > 0 ? '+' : ''}${autoDelta} (emotion=${result.emotion})`,
          );
        }
      }
    } catch (err) {
      // A6:不再静默吞错。记入 parse-fail ring buffer + console.warn,emotion 仍留 neutral
      const msg = err instanceof Error ? err.message : String(err);
      recordExternalFailure(
        'emotion-detect',
        `npc=${args.npcIdAtCall} player="${args.playerMessage.slice(0, 40)}"`,
        `detectNpcEmotion 失败: ${msg}`,
      );
    }
  }

  /**
   * C3 ⚡ 行动模式:玩家描述自己要做什么,Director 描述世界反应。
   * 跟 advanceStory(推进模式)的差别:
   *   - 推进模式 = Director 主动产剧情(导演视角)
   *   - 行动模式 = Director 被动反应玩家行动(世界视角),不强推剧情
   * Beat 触发仍然评估(玩家行动可能恰好满足某个 beat 的 triggerHint)。
   * 没有 moveToScene — 行动模式不主动切场景(由 advanceStory 或 auto-check 切)。
   */
  async function act() {
    if (!input.trim() || loading || advancing) return;
    const playerAction = input.trim();
    // 玩家行动作为 user role 消息(用 "[行动] " 前缀,UI 区分)
    const actionMsg: Message = { role: 'user', content: ACTION_PREFIX + playerAction };
    const newMessages = [...messages, actionMsg];
    updateMessages(newMessages);
    setInput('');
    setAdvancing(true);
    setError(null);

    try {
      const roster = buildScenarioNpcRoster(scenarioId);
      const progress = plaza.getScenarioProgress(scenarioId);
      const hasSkeleton = !!scenario?.scenes && scenario.scenes.length > 0;
      const currentScene = hasSkeleton && progress?.currentSceneId
        ? scenario!.scenes!.find((s) => s.id === progress.currentSceneId)
        : hasSkeleton
          ? scenario!.scenes![0]
          : undefined;
      const completedSet = new Set(progress?.completedBeatIds ?? []);
      // T8:beat.trigger 硬性前置评估 — 过滤掉 trigger 未满足的 beat,不暴露给 Director
      // (无 trigger 的 beat 总满足,等同旧行为;有 trigger 的 beat 必须 location/visitCount/前置 beat/前置 artifact 全部就绪)
      const plazaStateForBeat = plaza.get();
      const visitCounts = plazaStateForBeat.locationVisitCount[scenarioId] ?? {};
      const discoveredArtifactsForBeat = new Set(
        plazaStateForBeat.discoveredArtifacts[scenarioId] ?? [],
      );
      const beatTriggerCtx = {
        currentLocation: plazaStateForBeat.currentLocation,
        visitCounts,
        completedBeatIds: completedSet,
        discoveredArtifactIds: discoveredArtifactsForBeat,
      };
      const pendingBeats =
        currentScene?.beats.filter(
          (b) => !completedSet.has(b.id) && evaluateBeatTrigger(b, beatTriggerCtx),
        ) ?? [];
      const presentNpcsList =
        nearbyTargets
          .filter((t) => t.kind === 'npc')
          .map((t) => `- ${t.name}(${t.spec.character_id}): ${t.oneLiner}`)
          .join('\n') || '(无)';

      // I-series:Director 也吃玩家身份 + 愿望(soul/body 各有不同的叙事视角)
      const directorExtraCtx: DirectorPlayerCtx = resolveDirectorExtraCtx(scenarioId);
      // 隐藏数值 + 不可逆事件上下文(主角 / 携带队友 / 携带物品)
      const directorCombatCtx = buildDirectorCombatCtx();
      const directorSystem = hasSkeleton
        ? buildActionReactionPrompt(
            scenario!.name,
            scenario!.description,
            roster,
            presentNpcsList,
            currentScene,
            pendingBeats,
            playerAction,
            directorExtraCtx,
            directorCombatCtx,
          )
        : buildFreeDirectorPrompt(
            scenario?.name ?? scenarioId,
            scenario?.description ?? '',
            roster,
            currentTarget?.name ?? '(无)',
          );

      // 把最近 messages 一起喂给 Director 当 context(它能看见对话历史)
      const seed: Message[] = newMessages.length > 0 ? newMessages : [{ role: 'user', content: playerAction }];
      const directorLlm = scenario?.llmConfig;
      const resp = await callLLM({
        systemPrompt: directorSystem,
        messages: seed,
        task: 'director.beat',
        maxTokens: directorLlm?.maxTokens ?? (hasSkeleton ? 1200 : 800),
        model: directorLlm?.model,
        temperature: directorLlm?.temperature,
      });

      let narrationText = resp.text;
      let triggeredBeatIds: string[] = [];
      let trustDeltas: Array<{ npcId: string; delta: number; reason?: string }> = [];

      if (hasSkeleton) {
        const parsed = parseDirectorJson(resp.text);
        if (parsed) {
          narrationText = typeof parsed.narration === 'string' ? parsed.narration : resp.text;
          triggeredBeatIds = Array.isArray(parsed.triggeredBeatIds)
            ? (parsed.triggeredBeatIds as unknown[]).filter((x): x is string => typeof x === 'string')
            : [];
          trustDeltas = Array.isArray(parsed.trustDeltas)
            ? (parsed.trustDeltas as unknown[])
                .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
                .map((t) => ({
                  npcId: typeof t.npcId === 'string' ? t.npcId : '',
                  delta: typeof t.delta === 'number' ? t.delta : 0,
                  reason: typeof t.reason === 'string' ? t.reason : undefined,
                }))
                .filter((t) => t.npcId && t.delta !== 0)
            : [];
        }
        // 落地 beat
        const validBeatIds = new Set(currentScene?.beats.map((b) => b.id) ?? []);
        const filteredBeats = triggeredBeatIds.filter((id) => validBeatIds.has(id));
        const newOnes = filteredBeats.length > 0 ? plaza.triggerBeats(scenarioId, filteredBeats) : [];
        // F4:trust 变动 — 校验 npcId 必须是剧本 roster 里的(LLM 写错时丢弃,避免脏 key)
        const validNpcIds = new Set((scenario?.npcs ?? []).map((n) => n.character_id));
        for (const td of trustDeltas) {
          if (!validNpcIds.has(td.npcId)) {
            console.warn(`[trustDeltas] 丢弃未识别 npcId: ${td.npcId}(reason: ${td.reason})`);
            continue;
          }
          plaza.adjustRelationship(td.npcId, scenarioId, td.delta, td.reason);
        }
        // C5:行动模式也自动检查 scene 推进 — 本 scene 所有 checkpoint 满足时切下一个
        let autoMovedSceneName: string | null = null;
        if (currentScene) {
          const updatedProgress = plaza.getScenarioProgress(scenarioId);
          const allCkInThisScene = currentScene.beats.filter((b) => b.type === 'checkpoint');
          const completedSet2 = new Set(updatedProgress?.completedBeatIds ?? []);
          const allDone =
            allCkInThisScene.length > 0 && allCkInThisScene.every((b) => completedSet2.has(b.id));
          if (allDone) {
            const sceneIdx = scenario!.scenes!.findIndex((s) => s.id === currentScene.id);
            const nextId =
              currentScene.nextSceneId ?? scenario!.scenes![sceneIdx + 1]?.id ?? null;
            if (nextId && scenario!.scenes!.some((s) => s.id === nextId)) {
              plaza.setCurrentScene(scenarioId, nextId);
              autoMovedSceneName = scenario!.scenes!.find((s) => s.id === nextId)?.name ?? nextId;
            }
          }
        }
        if (newOnes.length > 0 || autoMovedSceneName) {
          const lines: string[] = [];
          if (newOnes.length > 0) {
            lines.push('🎬 触发剧情节点:');
            lines.push(
              newOnes
                .map((bid) => {
                  const beat = currentScene?.beats.find((b) => b.id === bid);
                  return beat?.unlockHint ?? `✨ ${beat?.summary ?? bid}`;
                })
                .join('\n'),
            );
          }
          if (autoMovedSceneName) {
            if (lines.length > 0) lines.push('');
            lines.push(`🎞 本场景 checkpoint 已完成,推进到:${autoMovedSceneName}`);
          }
          window.setTimeout(() => {
            try {
              window.alert(lines.join('\n'));
            } catch {
              /* SSR */
            }
          }, 50);
        }
      }

      // WC-STAT / WC-EVENT 处理:Director narration 里可能含战斗 / 数值变化 / 死亡标记
      narrationText = processWcMarkers(narrationText, 'director-action');

      // 行动反应作为 assistant 的 [叙事] 消息加进对话流
      const reactionMsg: Message = { role: 'assistant', content: NARRATION_PREFIX + narrationText };
      const finalMessages = [...newMessages, reactionMsg];
      updateMessages(finalMessages);
      setLastLaneUsed(resp.laneUsed ?? null);
      setLastFallback(resp.fallbackPath ?? null);
      setLastDuration(resp.durationSec ?? null);
      const events = readEvents();
      events.push(`[行动] ${playerAction}`);
      events.push(`[Director] ${narrationText}`);
      writeEvents(events);

      // 行动也算长对话的一部分,触发分级压缩
      void maybeCompressHistory({
        npcIdAtCall: currentNpcId,
        characterName: currentTarget?.name ?? 'NPC',
        messagesAfterNpc: finalMessages,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      onKeyChange();
    } finally {
      setAdvancing(false);
    }
  }

  /**
   * 让 Director 推进剧情。
   * 新版(P4):若剧本有 scenes 骨架,Director 输出结构化 JSON,包含:
   *   - narration:旁白文本
   *   - triggeredBeatIds:触发的 beat ids
   *   - trustDeltas:[{ npcId, delta, reason }] 关系变动
   *   - moveToScene:可选,推进到下一个 scene
   * 旧版(无骨架剧本):退化到自由叙事模式。
   */
  async function advanceStory() {
    if (loading || advancing) return;
    setAdvancing(true);
    setError(null);
    try {
      const roster = buildScenarioNpcRoster(scenarioId);
      const progress = plaza.getScenarioProgress(scenarioId);
      const hasSkeleton = !!scenario?.scenes && scenario.scenes.length > 0;
      const currentScene = hasSkeleton && progress?.currentSceneId
        ? scenario!.scenes!.find((s) => s.id === progress.currentSceneId)
        : hasSkeleton
          ? scenario!.scenes![0]
          : undefined;

      // 构造未完成 beats 描述
      const completedSet = new Set(progress?.completedBeatIds ?? []);
      const pendingBeats =
        currentScene?.beats.filter((b) => !completedSet.has(b.id)) ?? [];

      // I-series:advance 模式同样注入玩家身份 + 愿望(让"世界引导"贴合 soul/body 视角)
      const advanceExtraCtx: DirectorPlayerCtx = resolveDirectorExtraCtx(scenarioId);
      const advanceCombatCtx = buildDirectorCombatCtx();
      const directorSystem = hasSkeleton
        ? buildStructuredDirectorPrompt(
            scenario!.name,
            scenario!.description,
            roster,
            currentNpc?.identity.name ?? '(无)',
            currentScene,
            pendingBeats,
            advanceExtraCtx,
            advanceCombatCtx,
          )
        : buildFreeDirectorPrompt(
            scenario?.name ?? scenarioId,
            scenario?.description ?? '',
            roster,
            currentNpc?.identity.name ?? '(无)',
          );

      const seed: Message[] = messages.length > 0 ? messages : [{ role: 'user', content: '(剧本开场)' }];
      const directorLlm2 = scenario?.llmConfig;
      const resp = await callLLM({
        systemPrompt: directorSystem,
        messages: seed,
        task: 'director.beat',
        // 结构化模式下 token 多留点(JSON 包了一层)
        maxTokens: directorLlm2?.maxTokens ?? (hasSkeleton ? 1500 : 1024),
        model: directorLlm2?.model,
        temperature: directorLlm2?.temperature,
      });

      let narrationText = resp.text;
      let triggeredBeatIds: string[] = [];
      let trustDeltas: Array<{ npcId: string; delta: number; reason?: string }> = [];
      let moveToScene: string | null = null;

      if (hasSkeleton) {
        // 期待 LLM 输出 JSON 块
        const parsed = parseDirectorJson(resp.text);
        if (parsed) {
          narrationText = typeof parsed.narration === 'string' ? parsed.narration : resp.text;
          triggeredBeatIds = Array.isArray(parsed.triggeredBeatIds)
            ? (parsed.triggeredBeatIds as unknown[]).filter((x): x is string => typeof x === 'string')
            : [];
          trustDeltas = Array.isArray(parsed.trustDeltas)
            ? (parsed.trustDeltas as unknown[])
                .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
                .map((t) => ({
                  npcId: typeof t.npcId === 'string' ? t.npcId : '',
                  delta: typeof t.delta === 'number' ? t.delta : 0,
                  reason: typeof t.reason === 'string' ? t.reason : undefined,
                }))
                .filter((t) => t.npcId && t.delta !== 0)
            : [];
          moveToScene = typeof parsed.moveToScene === 'string' ? parsed.moveToScene : null;
        }
        // 落地 beat
        const validBeatIds = new Set(currentScene?.beats.map((b) => b.id) ?? []);
        const filteredBeats = triggeredBeatIds.filter((id) => validBeatIds.has(id));
        const newOnes = filteredBeats.length > 0 ? plaza.triggerBeats(scenarioId, filteredBeats) : [];
        // F4:trust 变动 — 校验 npcId 在 roster 里
        const validNpcIds = new Set((scenario?.npcs ?? []).map((n) => n.character_id));
        for (const td of trustDeltas) {
          if (!validNpcIds.has(td.npcId)) {
            console.warn(`[trustDeltas] 丢弃未识别 npcId: ${td.npcId}(reason: ${td.reason})`);
            continue;
          }
          plaza.adjustRelationship(td.npcId, scenarioId, td.delta, td.reason);
        }
        // scene 转换:Director 主动 moveToScene 优先
        let movedToSceneByDirector = false;
        if (moveToScene && scenario!.scenes!.some((s) => s.id === moveToScene)) {
          plaza.setCurrentScene(scenarioId, moveToScene);
          movedToSceneByDirector = true;
        }
        // B2:Director 没主动切的话,前端自动检查 — 本 scene 所有 checkpoint 都触发了就切下一个
        let autoMovedSceneName: string | null = null;
        if (!movedToSceneByDirector && currentScene) {
          const updatedProgress = plaza.getScenarioProgress(scenarioId);
          const allCkInThisScene = currentScene.beats.filter((b) => b.type === 'checkpoint');
          const completedSet2 = new Set(updatedProgress?.completedBeatIds ?? []);
          const allDone =
            allCkInThisScene.length > 0 && allCkInThisScene.every((b) => completedSet2.has(b.id));
          if (allDone) {
            // 决定下一个 scene:优先 currentScene.nextSceneId,否则数组中的下一个
            const sceneIdx = scenario!.scenes!.findIndex((s) => s.id === currentScene.id);
            const nextId =
              currentScene.nextSceneId ?? scenario!.scenes![sceneIdx + 1]?.id ?? null;
            if (nextId && scenario!.scenes!.some((s) => s.id === nextId)) {
              plaza.setCurrentScene(scenarioId, nextId);
              autoMovedSceneName = scenario!.scenes!.find((s) => s.id === nextId)?.name ?? nextId;
            }
          }
        }
        // 弹 beat 触发提示(连同自动切 scene 一起弹一个综合通知)
        if (newOnes.length > 0 || autoMovedSceneName) {
          const lines: string[] = [];
          if (newOnes.length > 0) {
            lines.push('🎬 触发剧情节点:');
            lines.push(
              newOnes
                .map((bid) => {
                  const beat = currentScene?.beats.find((b) => b.id === bid);
                  return beat?.unlockHint ?? `✨ ${beat?.summary ?? bid}`;
                })
                .join('\n'),
            );
          }
          if (autoMovedSceneName) {
            if (lines.length > 0) lines.push('');
            lines.push(`🎞 本场景所有 checkpoint 已完成,推进到下一场景:\n${autoMovedSceneName}`);
          }
          // 触发弹窗(非阻塞,简短确认)
          window.setTimeout(() => {
            try {
              window.alert(lines.join('\n'));
            } catch {
              /* SSR safe */
            }
          }, 50);
        }
      }

      // WC-STAT / WC-EVENT 处理:advance 路径里 Director 也可能产生战斗 / 死亡
      narrationText = processWcMarkers(narrationText, 'director-advance');

      const beat: Message = { role: 'assistant', content: NARRATION_PREFIX + narrationText };
      updateMessages([...messages, beat]);
      setLastLaneUsed(resp.laneUsed ?? null);
      setLastFallback(resp.fallbackPath ?? null);
      setLastDuration(resp.durationSec ?? null);
      const events = readEvents();
      events.push(`[Director] ${narrationText}`);
      writeEvents(events);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      onKeyChange();
    } finally {
      setAdvancing(false);
    }
  }

  // C4:"身边角色"列表(给 selector)— 包含当前 scene 在场 NPC + active companions
  // G11:useMemo + plazaTick 失效,避免每 render 都跑 plaza.get() + 多份 scene 查找
  const nearbyTargets: DialogueTarget[] = useMemo(() => {
    const progress = plaza.getScenarioProgress(scenarioId);
    const currentScene =
      scenario?.scenes && progress?.currentSceneId
        ? scenario.scenes.find((s) => s.id === progress.currentSceneId)
        : scenario?.scenes?.[0];
    // 动态剧本:用 plaza.currentLocation 做 location 过滤
    const currentLocation = plaza.get().currentLocation;
    return listNearbyTargets(scenarioId, currentScene, currentLocation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioId, plazaTick]);
  const npcName = currentTarget?.name ?? 'NPC';
  /** H3:截断长名字防止按钮 / tab 文字撑爆 row(自定义剧本可能产生 10+ 字的角色名) */
  const npcNameShort = npcName.length > 8 ? npcName.slice(0, 7) + '…' : npcName;

  return (
    <>
      {/* 剧本中 → 返回广场横幅 */}
      {inScenarioId && (
        <SceneProgressBanner
          scenarioId={inScenarioId}
          // 触发刷新的 tick:advancing 状态变化 / messages 长度变化时也强制重读 plaza progress
          revision={advancing ? 1 : 0}
          messageCount={messages.length}
          returningToPlaza={returningToPlaza}
          setReturningToPlaza={setReturningToPlaza}
          onReturnToPlaza={onReturnToPlaza}
        />
      )}

      {/* Ⓑ:场景插画 banner(若 scene.imagePrompt 存在且偏好开启) */}
      {portraitPrefs.sceneImagesEnabled && (sceneImage || sceneImageLoading) && (
        <div
          className="card"
          style={{
            padding: 0,
            position: 'relative',
            overflow: 'hidden',
            height: 140,
            background: '#0a0a14',
          }}
        >
          {sceneImage ? (
            <img
              src={sceneImage}
              alt="scene"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block',
                opacity: 0.85,
              }}
            />
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: '#7aa',
                fontSize: 12,
              }}
            >
              生成场景插画中…
            </div>
          )}
          {/* 显示当前 scene 名(比"场景插画"标签更有信息量) */}
          {(() => {
            const progress = plaza.getScenarioProgress(scenarioId);
            const scene = scenario?.scenes && progress?.currentSceneId
              ? scenario.scenes.find((s) => s.id === progress.currentSceneId)
              : scenario?.scenes?.[0];
            if (!scene?.name) return null;
            return (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  padding: '6px 12px',
                  background: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.75) 100%)',
                  color: '#ffd86b',
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                {scene.name}
              </div>
            );
          })()}
        </div>
      )}

      {/* 身边可对话的角色选择器 — 包含在场 NPC + active 队友 */}
      <div
        className="card"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
      >
        <span className="muted" style={{ fontSize: 12, marginRight: 4 }}>
          身边的人:
        </span>
        {nearbyTargets.map((t) => {
          const active = t.id === currentNpcId;
          const kindTag = t.kind === 'companion' ? '👥 ' : '';
          return (
            <button
              key={t.id}
              className={active ? 'primary' : ''}
              style={{
                fontSize: 13,
                padding: '4px 10px',
                ...(t.kind === 'companion'
                  ? { borderColor: '#c97', color: active ? undefined : '#c97' }
                  : {}),
              }}
              onClick={() => setCurrentNpcId(t.id)}
              title={`${t.kind === 'companion' ? '[队友] ' : ''}${t.oneLiner}…`}
            >
              {kindTag}{t.name}
            </button>
          );
        })}
        <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }}>
          剧本: {scenario?.name ?? scenarioId}
        </span>
      </div>

      {/* 角色卡 */}
      <div className="card row" style={{ alignItems: 'flex-start' }}>
        <div
          className="portrait"
          style={{ overflow: 'hidden', padding: 0, position: 'relative' }}
          title={portraitError ?? undefined}
        >
          {portrait ? (
            <img
              src={portrait}
              alt={npcName}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : (
            <div style={{ padding: 12, fontSize: 12, textAlign: 'center', lineHeight: 1.4 }}>
              {npcName}
              <br />
              <span className="muted" style={{ fontSize: 11 }}>
                {portraitLoading
                  ? '生成中…'
                  : currentNpc && !isPortraitGeneratable(currentNpc)
                    ? '(主线未解锁)'
                    : portraitError
                      ? '(SDXL 未就绪)'
                      : '(等待生成)'}
              </span>
            </div>
          )}
          {/* Ⓑ-emot:当前情绪 overlay(仅 emotionPolicy='on' 且非 neutral 时显示) */}
          {emotionPolicy === 'on' && currentEmotion !== 'neutral' && (
            <div
              style={{
                position: 'absolute',
                top: 4,
                right: 4,
                background: 'rgba(0,0,0,0.65)',
                color: '#ffd86b',
                fontSize: 11,
                padding: '2px 6px',
                borderRadius: 4,
              }}
              title={`当前情绪:${EMOTION_LABELS[currentEmotion]}`}
            >
              {EMOTION_ICONS[currentEmotion]} {EMOTION_LABELS[currentEmotion]}
            </div>
          )}
          {portraitLoading && portrait && (
            <div
              style={{
                position: 'absolute',
                bottom: 4,
                left: 4,
                background: 'rgba(0,0,0,0.65)',
                color: '#9cf',
                fontSize: 10,
                padding: '2px 6px',
                borderRadius: 4,
              }}
            >
              ⟳ 生成中
            </div>
          )}
        </div>
        <div style={{ flex: 1 }}>
          <h3 style={{ marginBottom: 4 }}>
            {npcName}
            {currentNpc?.identity.pronouns && (
              <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                {currentNpc.identity.pronouns}
              </span>
            )}
          </h3>
          <p className="muted" style={{ marginTop: 4 }}>
            {(currentNpc?.core_persona.traits ?? []).slice(0, 5).map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </p>
          <p className="muted" style={{ marginTop: 8 }}>
            {currentNpc?.core_persona.summary ?? ''}
          </p>
          <div style={{ marginTop: 12, padding: 10, background: '#1a1d29', borderRadius: 6 }}>
            <div className="muted" style={{ marginBottom: 4 }}>
              你携带的队友：
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{companionSummary}</pre>
          </div>

          {/* Ⓑ-emot:'ask' 模式下 — 提示玩家为此角色启用多情绪 */}
          {emotionPolicy === 'ask' && currentNpc && isPortraitGeneratable(currentNpc) && (
            <div
              style={{
                marginTop: 10,
                padding: '8px 10px',
                background: '#1c1a14',
                borderRadius: 6,
                fontSize: 12,
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ color: '#ffd86b' }}>🎭</span>
              <span>为 <b>{npcName}</b> 启用多情绪立绘?(对话时会按情绪自动切换)</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => {
                    plaza.setCharacterEmotionPolicy(currentNpcId, 'on');
                    refreshPortraitPrefs();
                  }}
                >
                  启用
                </button>
                <button
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => {
                    plaza.setCharacterEmotionPolicy(currentNpcId, 'off');
                    refreshPortraitPrefs();
                  }}
                >
                  不启用
                </button>
              </div>
            </div>
          )}

          {/* Ⓑ-emot:情绪手动切换条(emotionPolicy='on' 时显示) — F7:按 tier 截取允许情绪 */}
          {emotionPolicy === 'on' && currentNpc && isPortraitGeneratable(currentNpc) && (() => {
            // 当前 scene
            const progress2 = plaza.getScenarioProgress(scenarioId);
            const scene2 = scenario?.scenes && progress2?.currentSceneId
              ? scenario.scenes.find((s) => s.id === progress2.currentSceneId)
              : undefined;
            const tier2 = tierConfigFor(currentNpcId, scenario, scene2);
            const allowedEmotions = ALL_EMOTIONS.slice(0, tier2.emotionsMax);
            return (
            <div
              style={{
                marginTop: 10,
                padding: '6px 10px',
                background: '#1a1d29',
                borderRadius: 6,
                fontSize: 11,
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <span className="muted" style={{ marginRight: 2 }}>
                情绪
                {tier2.emotionsMax < ALL_EMOTIONS.length && (
                  <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>
                    ({classifyCharacter(currentNpcId, scenario, scene2)} tier · {tier2.emotionsMax} 种)
                  </span>
                )}
                :
              </span>
              {allowedEmotions.map((e) => {
                const cached = !!readPortrait(currentNpcId, e);
                const active = e === currentEmotion;
                return (
                  <button
                    key={e}
                    className={active ? 'primary' : ''}
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      opacity: cached || active ? 1 : 0.5,
                    }}
                    onClick={() => setCurrentEmotion(e)}
                    title={cached ? '已缓存' : '点击触发生成'}
                  >
                    {EMOTION_ICONS[e]} {EMOTION_LABELS[e]}
                    {!cached && <span style={{ marginLeft: 3, opacity: 0.6 }}>⚪</span>}
                  </button>
                );
              })}
              <button
                style={{ fontSize: 10, padding: '2px 6px', marginLeft: 'auto' }}
                onClick={() => {
                  plaza.setCharacterEmotionPolicy(currentNpcId, 'off');
                  refreshPortraitPrefs();
                  setCurrentEmotion('neutral');
                }}
                title="为此角色关闭多情绪"
              >
                关闭
              </button>
            </div>
            );
          })()}
        </div>
      </div>

      {/* 会话区 */}
      <div
        className="card"
        ref={scrollRef}
        style={{ height: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
      >
        {messages.length === 0 && (
          <div className="msg system">
            {scenario?.openingNarration ?? `* 试着对 ${npcName} 说点什么。*`}
          </div>
        )}
        {messages.map((m, i) => {
          // 压缩摘要(达到 tier 80% 时自动产生,浓缩早期对话)
          const isSummary =
            m.role === 'assistant' && m.content.startsWith(SUMMARY_PREFIX);
          if (isSummary) {
            return (
              <div
                key={i}
                className="msg system"
                style={{
                  fontStyle: 'italic',
                  borderLeft: '3px solid #678',
                  paddingLeft: 10,
                  background: '#15181f',
                  fontSize: 12,
                  opacity: 0.85,
                }}
                title="早期对话已浓缩为摘要,节省 token"
              >
                <span className="muted" style={{ fontSize: 10, marginRight: 6 }}>
                  📜 早期对话摘要
                </span>
                {m.content.slice(SUMMARY_PREFIX.length)}
              </div>
            );
          }
          const isNarration =
            m.role === 'assistant' && m.content.startsWith(NARRATION_PREFIX);
          if (isNarration) {
            return (
              <div
                key={i}
                className="msg system"
                style={{ fontStyle: 'italic', borderLeft: '3px solid #4a7', paddingLeft: 10 }}
              >
                {m.content.slice(NARRATION_PREFIX.length)}
              </div>
            );
          }
          // B3:队友插嘴 — content 形如 "[队友 小明] xxx",抽 NPC 名独立样式
          if (m.role === 'assistant') {
            const banterMatch = COMPANION_PREFIX_RE.exec(m.content);
            if (banterMatch) {
              const companionName = banterMatch[1];
              const line = m.content.slice(banterMatch[0].length);
              return (
                <div
                  key={i}
                  className="msg assistant"
                  style={{
                    borderLeft: '3px solid #c97',
                    paddingLeft: 10,
                    background: '#1f1a14',
                    fontSize: 13,
                  }}
                >
                  <span className="muted" style={{ fontSize: 11, marginRight: 6 }}>
                    👥 {companionName}
                  </span>
                  {line}
                </div>
              );
            }
          }
          // C1:玩家行动消息([行动] 前缀)— 蓝色样式区分纯对话
          if (m.role === 'user' && m.content.startsWith(ACTION_PREFIX)) {
            return (
              <div
                key={i}
                className="msg user"
                style={{
                  borderLeft: '3px solid #7cf',
                  paddingLeft: 10,
                  background: '#0e1822',
                }}
              >
                <span className="muted" style={{ fontSize: 11, marginRight: 6 }}>
                  ⚡ 行动
                </span>
                {m.content.slice(ACTION_PREFIX.length)}
              </div>
            );
          }
          return (
            <div key={i} className={`msg ${m.role}`}>
              {m.content}
            </div>
          );
        })}
        {loading && <div className="msg system">{npcName} 正在想……</div>}
        {advancing && <div className="msg system">Director 在编排下一幕……</div>}
      </div>

      {error && (
        <FriendlyError
          error={error}
          onDismiss={() => setError(null)}
          onNavigateToTab={onNavigateToTab}
        />
      )}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {/* C1:输入模式 tab(💬 对话 / ⚡ 行动) */}
        <div
          className="row"
          style={{
            gap: 0,
            background: '#0f1119',
            borderBottom: '1px solid #2a2d3e',
            padding: 0,
          }}
        >
          <button
            onClick={() => setInputMode('dialogue')}
            style={{
              flex: 1,
              padding: '10px 16px',
              border: 'none',
              borderRadius: 0,
              background: inputMode === 'dialogue' ? '#1a1d29' : 'transparent',
              color: inputMode === 'dialogue' ? '#ffd86b' : '#666',
              fontWeight: inputMode === 'dialogue' ? 700 : 400,
              cursor: 'pointer',
              borderBottom: inputMode === 'dialogue' ? '2px solid #ffd86b' : '2px solid transparent',
            }}
          >
            💬 对话{' '}
            {inputMode === 'dialogue' && (
              <span title={`→ ${npcName}`}>→ {npcNameShort}</span>
            )}
          </button>
          <button
            onClick={() => setInputMode('action')}
            style={{
              flex: 1,
              padding: '10px 16px',
              border: 'none',
              borderRadius: 0,
              background: inputMode === 'action' ? '#1a1d29' : 'transparent',
              color: inputMode === 'action' ? '#7cf' : '#666',
              fontWeight: inputMode === 'action' ? 700 : 400,
              cursor: 'pointer',
              borderBottom: inputMode === 'action' ? '2px solid #7cf' : '2px solid transparent',
            }}
          >
            ⚡ 行动 {inputMode === 'action' && '→ Director'}
          </button>
        </div>

        {/* 模式提示 + 路由信息 */}
        <div style={{ padding: '8px 14px 0 14px' }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            {inputMode === 'dialogue' ? (
              <>
                💬 对{' '}
                <b
                  style={{
                    color: '#ffd86b',
                    display: 'inline-block',
                    maxWidth: 180,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    verticalAlign: 'bottom',
                    whiteSpace: 'nowrap',
                  }}
                  title={npcName}
                >
                  {npcName}
                </b>{' '}
                说话{currentIsCompanion && <span style={{ color: '#c97' }}>(队友)</span>} ·
                走 <b style={{ color: '#7aa' }}>{getLaneDef(targetLane)?.shortLabel}</b>
              </>
            ) : (
              <>
                ⚡ 描述你的行动(Director 描述世界反应,不替你决定) ·
                走 <b style={{ color: '#7aa' }}>Director.beat</b>
              </>
            )}
            {lastLaneUsed && (
              <span style={{ marginLeft: 8, opacity: 0.6 }}>
                · 上次:{getLaneDef(lastLaneUsed)?.shortLabel}
                {lastDuration !== null && ` · ${lastDuration.toFixed(1)}s`}
              </span>
            )}
          </div>

          {/* G16:fallback 路径(仅在出现 fallback 时显示) */}
          {lastFallback && lastFallback.length > 1 && (
            <div className="muted" style={{ fontSize: 10, marginBottom: 6, color: '#fb7' }}>
              ⚠ 上次走了 fallback: {lastFallback.map((l) => getLaneDef(l)?.shortLabel).join('→')}
            </div>
          )}
        </div>

        <div style={{ padding: '0 14px 14px 14px' }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              inputMode === 'dialogue'
                ? `对 ${npcName} 说点什么……（按 Cmd/Ctrl+Enter 发送）`
                : '描述你要做什么……比如 "我去翻 Halia 的抽屉" / "我冲过去拦住那个人" / "我在角落坐下,装作没听见"（按 Cmd/Ctrl+Enter 执行）'
            }
            style={{
              borderColor: inputMode === 'action' ? '#7cf' : undefined,
              minHeight: 80,
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (inputMode === 'dialogue') send();
                else act();
              }
            }}
          />
          <div className="row" style={{ marginTop: 8 }}>
            {inputMode === 'dialogue' ? (
              <button
                className="primary"
                disabled={loading || advancing || !input.trim()}
                onClick={send}
              >
                {loading ? `${npcNameShort} 回复中…` : `💬 对 ${npcNameShort} 说`}
              </button>
            ) : (
              <button
                className="primary"
                disabled={loading || advancing || !input.trim()}
                onClick={act}
                style={{ background: '#236' }}
              >
                {advancing ? 'Director 反应中…' : '⚡ 执行行动'}
              </button>
            )}
            <button
              disabled={loading || advancing}
              onClick={advanceStory}
              title="让世界本身指出主线方向 — Director 用 NPC 一句话 / 环境暗示 / 远处动静的方式自然暴露当前目标(玩家仍然可以不按提示走)"
              style={{ fontSize: 12 }}
            >
              {advancing ? '世界引导中…' : '⏩ 推进剧情(指方向)'}
            </button>
            <button
              disabled={messages.length === 0 || loading || advancing}
              onClick={() => {
                if (!window.confirm(`清空跟 ${npcName} 的对话?(立绘缓存保留)`)) return;
                updateMessages([]);
                writeEvents([]);
              }}
              style={{ fontSize: 12, marginLeft: 'auto' }}
            >
              清空对话
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── 记忆固化 Tab ──────────────────────────────────────────────────

function MemoryTab() {
  const [events, setEvents] = useState<string[]>(() => readEvents());
  /** F5:固化结果改成调真函数 consolidateAllChattedNpcs,结果会写回 plaza.npcMemories */
  const [result, setResult] = useState<{
    succeeded: { npcName: string; added: number }[];
    failed: { npcName: string; error: string }[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inScenarioId, setInScenarioId] = useState<string | null>(null);

  // mount 时读 events 和当前剧本
  useEffect(() => {
    setEvents(readEvents());
    setInScenarioId(plaza.get().inScenario);
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === EVENTS_KEY) setEvents(readEvents());
      if (e.key === null || e.key === 'wc_poc_plaza_v1') {
        setInScenarioId(plaza.get().inScenario);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  async function consolidate() {
    if (!inScenarioId) {
      setError('需要在剧本里(广场状态不固化)');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      // F5:走真正的固化流程,会写回 plaza.npcMemories(按 tier 配额)
      const res = await consolidateAllChattedNpcs(inScenarioId);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h3>记忆固化 (Memory Consolidation)</h3>
      <p className="muted" style={{ marginTop: 4, marginBottom: 12 }}>
        把跟每个 NPC 的对话提炼成长期记忆,写进 plaza.npcMemories — 下次再进同剧本时
        NPC 会"记得"这些事。<b>返广场时会自动跑</b>,这里是手动触发(剧本进行中也想固化)。
      </p>

      {!inScenarioId && (
        <p className="muted" style={{ color: '#fb7' }}>
          ⚠ 你当前在广场。先进入剧本才能固化记忆。
        </p>
      )}

      <h4 style={{ marginBottom: 8 }}>本次 episodic 事件 ({events.length})</h4>
      {events.length === 0 && (
        <p className="muted">还没有事件 — 去聊天 tab 先聊几句。</p>
      )}
      <ul style={{ paddingLeft: 20, fontSize: 13, maxHeight: 200, overflowY: 'auto' }}>
        {events.slice(-30).map((e, i) => (
          <li key={i} style={{ marginBottom: 4 }}>
            {e}
          </li>
        ))}
      </ul>

      <div className="row" style={{ marginTop: 16 }}>
        <button
          className="primary"
          onClick={consolidate}
          disabled={loading || !inScenarioId || events.length === 0}
        >
          {loading ? '正在固化……' : '🧠 手动固化(写回 plaza)'}
        </button>
      </div>

      {error && <div style={{ marginTop: 16, color: '#f88' }}>错误:{error}</div>}

      {result && (
        <div style={{ marginTop: 16, background: '#1a1d29', padding: 12, borderRadius: 6 }}>
          <h4 style={{ marginBottom: 8 }}>固化结果</h4>
          {result.succeeded.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                ✓ 成功 {result.succeeded.length} 个 NPC:
              </div>
              <ul style={{ paddingLeft: 20, fontSize: 13 }}>
                {result.succeeded.map((s, i) => (
                  <li key={i}>
                    {s.npcName} <span className="muted">+{s.added} 条新记忆</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.failed.length > 0 && (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4, color: '#fb7' }}>
                ✗ 失败 {result.failed.length} 个:
              </div>
              <ul style={{ paddingLeft: 20, fontSize: 12, color: '#fb7' }}>
                {result.failed.map((f, i) => (
                  <li key={i}>
                    {f.npcName}: {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.succeeded.length === 0 && result.failed.length === 0 && (
            <p className="muted">没有需要固化的对话(每个 NPC 至少要聊 2 条才行)。</p>
          )}
        </div>
      )}

      {/* A3:NPC 记忆库(plaza.npcMemories 持久化) */}
      <NpcMemoryLedger />
    </div>
  );
}

/** 展示 plaza.npcMemories — 每个 NPC 的长期记忆条目。 */
function NpcMemoryLedger() {
  const [memories, setMemories] = useState<Record<string, ReturnType<typeof plaza.listNpcMemories>>>({});

  useEffect(() => {
    const s = plaza.get();
    const out: Record<string, ReturnType<typeof plaza.listNpcMemories>> = {};
    for (const npcId of Object.keys(s.npcMemories)) {
      const list = s.npcMemories[npcId];
      if (list && list.length > 0) out[npcId] = list;
    }
    setMemories(out);
  }, []);

  const npcIds = Object.keys(memories);

  return (
    <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #2a2d3e' }}>
      <h4 style={{ marginBottom: 6 }}>
        🧠 NPC 长期记忆库
        <span className="muted" style={{ fontSize: 12, fontWeight: 'normal', marginLeft: 8 }}>
          (返广场时自动固化,跨 session 保留)
        </span>
      </h4>
      {npcIds.length === 0 ? (
        <p className="muted" style={{ fontSize: 12 }}>
          (暂无记忆 — 进剧本聊几句,返回广场就会自动整理)
        </p>
      ) : (
        npcIds.map((npcId) => {
          const npc = getCharacter(npcId);
          const list = memories[npcId];
          return (
            <details
              key={npcId}
              style={{ marginTop: 8, background: '#181a23', padding: 8, borderRadius: 4 }}
            >
              <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                <b>{npc?.identity.name ?? npcId}</b>
                <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
                  ({list.length} 条)
                </span>
              </summary>
              <ul style={{ paddingLeft: 18, marginTop: 6, fontSize: 12 }}>
                {list.map((m, i) => {
                  const w = m.emotional_weight ?? 0;
                  const color = w > 0.3 ? '#7cf' : w < -0.3 ? '#f88' : '#bbb';
                  return (
                    <li key={i} style={{ marginBottom: 4, color }}>
                      {m.scene}
                      {m.tags && m.tags.length > 0 && (
                        <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
                          [{m.tags.join(', ')}]
                        </span>
                      )}
                      <span className="muted" style={{ marginLeft: 6, fontSize: 10 }}>
                        ({m.scenarioId} · weight {w.toFixed(2)})
                      </span>
                    </li>
                  );
                })}
              </ul>
            </details>
          );
        })
      )}
    </div>
  );
}

// ─── 立绘 Tab（Lane A 本地 SDXL + Lane B 导出）─────────────────────

function PortraitTab() {
  // DLC 化:不再静态 import HALIA,在渲染时从 registry 拿(此时 DLC 早已加载完毕)。
  // 找不到(极端情况:DLC 没加载完就切到立绘 tab)→ 用占位字符串,功能仍可用。
  const halia = useMemo(() => getCharacter('starmail-npc-halia', 'starmail'), []);
  const haliaId = halia?.character_id ?? 'starmail-npc-halia';
  const haliaBasePrompt =
    halia?.appearance.base_prompt ??
    'a 50-year-old Asian woman, short black hair, sharp eyes, wearing a navy IPU postal uniform, slight limp, stern but kind expression';

  // Lane B 导出包
  const exportObj = exportImagePrompt({
    characterId: haliaId,
    context: 'neutral, standing at Coriolis dock',
    basePrompt: haliaBasePrompt,
  });
  const json = JSON.stringify(exportObj, null, 2);

  // Lane A 本地 SDXL
  const [prompt, setPrompt] = useState(haliaBasePrompt);
  const [negative, setNegative] = useState(
    'deformed, extra limbs, low quality, blurry, smiling, young, glamorous',
  );
  const [seed, setSeed] = useState(42);
  const [steps, setSteps] = useState(4);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ dataUrl: string; status: string; durationSec: number | null } | null>(null);

  async function generateLocal() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const resp = await fetch('/api/local-sdxl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, negative, steps, seed, cfg: 0.0 }),
      });
      // 容错：上游返回非 JSON（例如 502 HTML 错误页）时不要再次抛 SyntaxError
      const text = await resp.text();
      let data: { error?: string; detail?: string; dataUrl?: string; status?: string; durationSec?: number | null };
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      if (!resp.ok) {
        throw new Error(`${data.error ?? resp.status}${data.detail ? '\n' + data.detail : ''}`);
      }
      if (!data.dataUrl) {
        throw new Error('响应缺少 dataUrl');
      }
      setResult({
        dataUrl: data.dataUrl,
        status: data.status ?? '',
        durationSec: data.durationSec ?? null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="card">
        <h3>立绘生成 Lane A · 本地 SDXL Turbo（MLX）</h3>
        <p className="muted" style={{ marginTop: 4, marginBottom: 12 }}>
          调用本地 Gemma UI（127.0.0.1:7860）暴露的 SDXL Turbo MLX 接口。
          <br />
          前置：请先双击 <code>Start-Gemma4.command</code> 启动 Gemma UI。
          冷启动 30–90 秒；之后单张 5–15 秒。
        </p>

        <label className="muted">Prompt</label>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div style={{ height: 8 }} />
        <label className="muted">Negative</label>
        <textarea value={negative} onChange={(e) => setNegative(e.target.value)} />

        <div className="row" style={{ marginTop: 12, gap: 16 }}>
          <label className="muted">
            Steps:{' '}
            <input
              type="number"
              min={1}
              max={8}
              value={steps}
              onChange={(e) => setSteps(safeInt(e.target.value, 4))}
              style={{ width: 60 }}
            />
          </label>
          <label className="muted">
            Seed:{' '}
            <input
              type="number"
              value={seed}
              onChange={(e) => setSeed(safeInt(e.target.value, -1))}
              style={{ width: 100 }}
            />
          </label>
          <button className="primary" disabled={loading || !prompt.trim()} onClick={generateLocal}>
            {loading ? '生成中…（冷启动会等久一点）' : '生成（本地 SDXL）'}
          </button>
        </div>

        {error && (
          <div style={{ marginTop: 16, color: '#f88', whiteSpace: 'pre-wrap' }}>
            ⚠ {error}
          </div>
        )}

        {result && (
          <div style={{ marginTop: 16 }}>
            <img
              src={result.dataUrl}
              alt="generated portrait"
              style={{ maxWidth: 480, borderRadius: 8, border: '1px solid #2a2d3e' }}
            />
            <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              {result.status}
              {result.durationSec ? ` · ${result.durationSec.toFixed(1)}s` : ''}
            </p>
          </div>
        )}
      </div>

      {/* IMAGE-T5:Lane C —— 走 BYOK Image Lane,公网模式下的核心生图路径 */}
      <PortraitLaneC defaultPrompt={haliaBasePrompt} />

      <div className="card">
        <h3>立绘生成 Lane B · 导出 prompt + 外部生图 + 上传</h3>
        <p className="muted" style={{ marginTop: 4, marginBottom: 12 }}>
          给希望用 A1111 / ComfyUI / Midjourney / NovelAI 等外部工具的用户。
          导出 prompt 包，外部跑完再上传立绘到队友卡。
        </p>
        <pre
          style={{
            background: '#1a1d29',
            padding: 12,
            borderRadius: 6,
            fontSize: 12,
            overflow: 'auto',
            maxHeight: 240,
          }}
        >
          {json}
        </pre>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            onClick={() => {
              const blob = new Blob([json], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'halia_prompt.json';
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            下载 prompt.json
          </button>
          <button
            onClick={() => {
              navigator.clipboard.writeText(exportObj.mainPrompt);
              alert('Prompt 已复制到剪贴板');
            }}
          >
            复制主 prompt
          </button>
        </div>
      </div>
    </>
  );
}

// ─── IMAGE-T5:PortraitTab 内 Lane C(BYOK 在线生图测试)─────────────
//
// 给已经在 ModelsTab 加了 Image Lane 的用户一个直观的测试入口:
// 在这里选 lane → 输 prompt → 生 → 看结果 / 看耗时 / 看服务有没有 revised_prompt。
//
// 这个组件**不**写入 plaza state(不绑特定 NPC),只是验证链路通不通。
// 真正给 NPC 生立绘的路径在 ensurePortraitFor — 那里会按 emotion 写 portrait cache。

function PortraitLaneC({ defaultPrompt }: { defaultPrompt: string }) {
  const [lanes, setLanes] = useState<CustomImageLane[]>([]);
  const [selectedLaneId, setSelectedLaneId] = useState<string>('');
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [negative, setNegative] = useState(
    'deformed, extra limbs, low quality, blurry',
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    dataUrl: string;
    durationSec: number | null;
    revisedPrompt?: string;
  } | null>(null);

  // 进 PortraitTab 时拉一次 lane 列表;切回 ModelsTab 加了新 lane,
  // 用户回到 PortraitTab 应该看到。挂个 storage 事件监听处理跨 tab 改动。
  useEffect(() => {
    const refresh = () => {
      const all = listImageLanes();
      setLanes(all);
      // 自动选第一条(跟 ensurePortraitFor 一致),除非用户已选过
      setSelectedLaneId((prev) => (prev && all.some((l) => l.id === prev) ? prev : all[0]?.id ?? ''));
    };
    refresh();
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === 'wc_poc_custom_image_lanes_v1') refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  async function generateOnline() {
    const lane = lanes.find((l) => l.id === selectedLaneId);
    if (!lane) {
      setError('请先选一条 Image Lane');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const resp = await fetch('/api/image-compat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${lane.apiKey}`,
          'X-Wc-Base-Url': lane.baseUrl,
        },
        body: JSON.stringify({
          model: lane.model,
          prompt,
          negativePrompt: negative,
          size: lane.size,
          quality: lane.quality,
          responseFormat: lane.responseFormat ?? 'b64_json',
        }),
      });
      const text = await resp.text();
      let data: {
        dataUrl?: string;
        durationSec?: number;
        revisedPrompt?: string;
        error?: string;
        detail?: string;
      };
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      if (!resp.ok) {
        throw new Error(
          `${data.error ?? `HTTP ${resp.status}`}${data.detail ? '\n' + data.detail : ''}`,
        );
      }
      if (!data.dataUrl) throw new Error('响应缺 dataUrl');
      setResult({
        dataUrl: data.dataUrl,
        durationSec: data.durationSec ?? null,
        revisedPrompt: data.revisedPrompt,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ border: '1px solid #5a3a5a' }}>
      <h3>立绘生成 Lane C · BYOK 在线生图(OpenAI Images API)</h3>
      <p className="muted" style={{ marginTop: 4, marginBottom: 12 }}>
        走<b>模型路由 Tab → 🎨 自定义 Image Lane</b> 加好的服务(OpenAI / Together /
        SiliconFlow / 通义万相 / Azure 等)。<b>公网部署下立绘自动生图走的就是这条路径</b>
        ,默认用列表第一条 lane。这里只是手工测试单张图 + 看链路通不通。
      </p>

      {lanes.length === 0 ? (
        <p className="muted" style={{ fontStyle: 'italic', fontSize: 13 }}>
          (还没配 Image Lane。先到<b style={{ color: '#caf' }}>模型路由 Tab → 🎨 自定义 Image
          Lane</b> 加一条。)
        </p>
      ) : (
        <>
          <FormRow label="选择 Lane" hint="ensurePortraitFor 自动用第一条;手工测试可任选">
            <select
              value={selectedLaneId}
              onChange={(e) => setSelectedLaneId(e.target.value)}
              style={{ width: '100%' }}
            >
              {lanes.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label} ({l.model}){l.size ? ` ${l.size}` : ''}
                  {l.quality ? `/${l.quality}` : ''}
                </option>
              ))}
            </select>
          </FormRow>

          <label className="muted">Prompt</label>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div style={{ height: 8 }} />
          <label className="muted">Negative Prompt(仅部分服务支持,OpenAI 会忽略)</label>
          <textarea value={negative} onChange={(e) => setNegative(e.target.value)} />

          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="primary"
              disabled={loading || !prompt.trim() || !selectedLaneId}
              onClick={generateOnline}
            >
              {loading ? '生成中…(在线服务通常 10-60s)' : '生成(走选中的 Image Lane)'}
            </button>
          </div>

          {error && (
            <div style={{ marginTop: 16, color: '#f88', whiteSpace: 'pre-wrap' }}>
              ⚠ {error}
            </div>
          )}

          {result && (
            <div style={{ marginTop: 16 }}>
              <img
                src={result.dataUrl}
                alt="generated portrait"
                style={{ maxWidth: 480, borderRadius: 8, border: '1px solid #2a2d3e' }}
              />
              <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                {result.durationSec ? `${result.durationSec.toFixed(1)}s` : ''}
                {result.revisedPrompt && (
                  <>
                    <br />
                    <span style={{ color: '#caf' }}>服务自动改写了 prompt:</span>{' '}
                    <i>{result.revisedPrompt}</i>
                  </>
                )}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── 模型路由 Tab ──────────────────────────────────────────────────

// ─── CUSTOM-LANE-C:自定义 Lane 管理 ─────────────────────────────────
//
// 让用户接任意 OpenAI 兼容服务(OpenRouter / Groq / SiliconFlow / Moonshot /
// 阿里通义 / 自建 vLLM / Ollama OpenAI 适配 ...)。每条 lane 由用户填:
//   - label(显示名)
//   - baseUrl(https://...,不带尾部 /v1)
//   - model(各服务自己的 model 名)
//   - apiKey(BYOK)
//
// 加好后会自动出现在下方"路由矩阵"和"fallback 链编辑器"的下拉里,
// 任意任务都可指过去。

function CustomLaneManager({ onChange }: { onChange: () => void }) {
  const [lanes, setLanes] = useState<CustomLane[]>([]);
  const [editing, setEditing] = useState<CustomLane | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLanes(listCustomLanes());
  }, []);

  function refresh() {
    setLanes(listCustomLanes());
    onChange();
  }

  function save(form: {
    label: string;
    baseUrl: string;
    model: string;
    apiKey: string;
    costNote: string;
  }) {
    try {
      upsertCustomLane({
        id: editing === 'new' || editing === null ? undefined : editing.id,
        label: form.label,
        baseUrl: form.baseUrl,
        model: form.model,
        apiKey: form.apiKey,
        costNote: form.costNote || undefined,
        protocol: 'openai_compat',
      });
      setEditing(null);
      setError(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function remove(id: string, label: string) {
    if (!window.confirm(`确定删除自定义 Lane "${label}"?\n\n如果路由矩阵里某个任务指向它,会失败到 fallback 链。`)) {
      return;
    }
    removeCustomLane(id);
    refresh();
  }

  return (
    <div className="card" style={{ border: '1px solid #3a5a4a' }}>
      <h3 style={{ marginTop: 0 }}>🛠 自定义 Lane(OpenAI 兼容)</h3>
      <p className="muted" style={{ marginTop: 4, marginBottom: 12, fontSize: 13 }}>
        接任意 OpenAI 兼容服务 — 填 <b>base URL + model + API key</b>,加进 Lane
        列表;然后到下方"路由矩阵"里把任意任务路由过去。
        <br />
        适用:OpenRouter / Together / Groq / SiliconFlow / Moonshot / 阿里通义 / Fireworks /
        Azure OpenAI / 自建 vLLM / Ollama (OpenAI adapter) 等。
      </p>

      {lanes.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          {lanes.map((l) => (
            <div
              key={l.id}
              style={{
                padding: 10,
                background: '#1a1d29',
                borderRadius: 6,
                marginBottom: 8,
                borderLeft: '3px solid #5a8',
              }}
            >
              <div
                className="row"
                style={{ alignItems: 'baseline', justifyContent: 'space-between' }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ fontSize: 14 }}>{l.label}</b>{' '}
                  <code style={{ color: '#9cf', fontSize: 12 }}>{l.model}</code>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {l.baseUrl}
                  </div>
                  {l.costNote && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      {l.costNote}
                    </div>
                  )}
                  <div className="muted" style={{ fontSize: 10, marginTop: 2, color: '#666' }}>
                    id: <code>{l.id}</code>
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button onClick={() => setEditing(l)} style={{ fontSize: 12, padding: '4px 10px' }}>
                    编辑
                  </button>
                  <button
                    onClick={() => remove(l.id, l.label)}
                    style={{ fontSize: 12, padding: '4px 10px', color: '#f88' }}
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ fontStyle: 'italic', fontSize: 13, marginBottom: 12 }}>
          (还没添加自定义 Lane。点下方按钮加第一条。)
        </p>
      )}

      <button
        onClick={() => {
          setError(null);
          setEditing('new');
        }}
        style={{ background: '#3a5a4a', color: '#fff', padding: '6px 14px', fontSize: 13 }}
      >
        + 添加自定义 Lane
      </button>

      {error && (
        <p style={{ marginTop: 8, fontSize: 12, color: '#f88' }}>⚠ {error}</p>
      )}

      {editing && (
        <CustomLaneForm
          initial={editing === 'new' ? null : editing}
          onSave={save}
          onCancel={() => {
            setEditing(null);
            setError(null);
          }}
        />
      )}
    </div>
  );
}

function CustomLaneForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: CustomLane | null;
  onSave: (form: {
    label: string;
    baseUrl: string;
    model: string;
    apiKey: string;
    costNote: string;
  }) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '');
  const [costNote, setCostNote] = useState(initial?.costNote ?? '');
  const valid = label.trim() && baseUrl.trim() && model.trim() && apiKey.trim();

  return (
    <div
      style={{
        marginTop: 12,
        padding: 16,
        background: '#0f1119',
        borderRadius: 6,
        border: '1px solid #2a3d3a',
      }}
    >
      <h4 style={{ marginTop: 0, marginBottom: 12, fontSize: 14 }}>
        {initial ? `编辑「${initial.label}」` : '新增自定义 Lane'}
      </h4>

      <FormRow label="名称" hint="UI 显示名,可随便起">
        <input
          type="text"
          placeholder="例:Groq Llama 70B"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={{ width: '100%' }}
        />
      </FormRow>

      <FormRow
        label="API Base URL"
        hint="https:// 开头,不带尾部 /v1 或 /chat/completions。路径由我们拼。"
      >
        <input
          type="text"
          placeholder="例:https://api.groq.com/openai"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
        />
      </FormRow>

      <FormRow label="Model 名" hint="精确名,因服务而异。OpenRouter 形如 anthropic/claude-3.5-sonnet">
        <input
          type="text"
          placeholder="例:llama-3.3-70b-versatile"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
        />
      </FormRow>

      <FormRow label="API Key" hint="只存你浏览器 localStorage,server 不持久化">
        <input
          type="password"
          placeholder="例:gsk_... 或 sk-or-... 或 sk-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
        />
      </FormRow>

      <FormRow label="备注(可选)" hint="健康卡片会显示这一行,提醒你这条 lane 的价钱 / 用途">
        <input
          type="text"
          placeholder="例:Groq $0.59/$0.79 per 1M tok,800 tok/s"
          value={costNote}
          onChange={(e) => setCostNote(e.target.value)}
          style={{ width: '100%' }}
        />
      </FormRow>

      <div className="row" style={{ marginTop: 12, gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} className="muted">
          取消
        </button>
        <button
          className="primary"
          disabled={!valid}
          onClick={() =>
            onSave({
              label: label.trim(),
              baseUrl: baseUrl.trim(),
              model: model.trim(),
              apiKey: apiKey.trim(),
              costNote: costNote.trim(),
            })
          }
        >
          {initial ? '保存修改' : '添加 Lane'}
        </button>
      </div>
    </div>
  );
}

function FormRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        {label}
      </label>
      {children}
      {hint && (
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

// ─── IMAGE-T4:自定义 Image Lane 管理 ──────────────────────────────
//
// 跟 CustomLaneManager 平行,管理生图通道。差异:
//   - 不进路由矩阵 / fallback 链(生图是单点任务)
//   - 多 size / quality 两个生成参数
//   - id 前缀 custom_image_,跟 LLM lane 完全独立 store
//
// 用户加好后,PortraitTab 公网模式会用第一条 lane 给立绘自动生图。

function CustomImageLaneManager({ onChange }: { onChange: () => void }) {
  const [lanes, setLanes] = useState<CustomImageLane[]>([]);
  const [editing, setEditing] = useState<CustomImageLane | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLanes(listImageLanes());
  }, []);

  function refresh() {
    setLanes(listImageLanes());
    onChange();
  }

  function save(form: {
    label: string;
    baseUrl: string;
    model: string;
    apiKey: string;
    size: string;
    quality: string;
    costNote: string;
  }) {
    try {
      upsertImageLane({
        id: editing === 'new' || editing === null ? undefined : editing.id,
        label: form.label,
        baseUrl: form.baseUrl,
        model: form.model,
        apiKey: form.apiKey,
        size: form.size || undefined,
        quality: form.quality || undefined,
        costNote: form.costNote || undefined,
        protocol: 'openai_images_compat',
        responseFormat: 'b64_json',
      });
      setEditing(null);
      setError(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function remove(id: string, label: string) {
    if (!window.confirm(`确定删除自定义 Image Lane "${label}"?`)) return;
    removeImageLane(id);
    refresh();
  }

  return (
    <div className="card" style={{ border: '1px solid #5a3a5a' }}>
      <h3 style={{ marginTop: 0 }}>🎨 自定义 Image Lane(OpenAI Images API 兼容)</h3>
      <p className="muted" style={{ marginTop: 4, marginBottom: 12, fontSize: 13 }}>
        给立绘做在线生图。填 <b>base URL + model + API key</b>,公网模式下
        PortraitTab 会用<b>列表第一条</b>给 NPC 自动生立绘。
        <br />
        适用:OpenAI(DALL-E 3 / gpt-image-1)/ Together(FLUX) /
        SiliconFlow(Kolors) / 阿里 DashScope(通义万相) / Azure OpenAI / 自建 OpenAI Images 适配。
        <br />
        <span style={{ color: '#fa8' }}>
          注意:生图比文本贵得多(DALL-E 3 standard ~$0.04/张,hd ~$0.08)。生成的图存在
          <b>sessionStorage</b>(<code>wc_poc_portraits_v1</code>),~5MB 配额下 3-4 张就满,
          <b>关 tab 就清</b>、"导出全部进度"<b>不会带走立绘</b>。重度用建议一次玩到底,别中途关 tab。
        </span>
      </p>

      {lanes.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          {lanes.map((l) => (
            <div
              key={l.id}
              style={{
                padding: 10,
                background: '#1a1d29',
                borderRadius: 6,
                marginBottom: 8,
                borderLeft: '3px solid #a5e',
              }}
            >
              <div
                className="row"
                style={{ alignItems: 'baseline', justifyContent: 'space-between' }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ fontSize: 14 }}>{l.label}</b>{' '}
                  <code style={{ color: '#caf', fontSize: 12 }}>{l.model}</code>
                  <div
                    className="muted"
                    style={{
                      fontSize: 11,
                      marginTop: 2,
                      fontFamily: 'monospace',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {l.baseUrl}
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    {l.size ? `尺寸 ${l.size}` : '尺寸 默认'}
                    {l.quality ? ` · 质量 ${l.quality}` : ''}
                  </div>
                  {l.costNote && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      {l.costNote}
                    </div>
                  )}
                  <div className="muted" style={{ fontSize: 10, marginTop: 2, color: '#666' }}>
                    id: <code>{l.id}</code>
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    onClick={() => setEditing(l)}
                    style={{ fontSize: 12, padding: '4px 10px' }}
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => remove(l.id, l.label)}
                    style={{ fontSize: 12, padding: '4px 10px', color: '#f88' }}
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ fontStyle: 'italic', fontSize: 13, marginBottom: 12 }}>
          (还没添加 Image Lane。公网模式下立绘只能用上传图片或剧本预生成图。点下方按钮加第一条。)
        </p>
      )}

      <button
        onClick={() => {
          setError(null);
          setEditing('new');
        }}
        style={{ background: '#5a3a5a', color: '#fff', padding: '6px 14px', fontSize: 13 }}
      >
        + 添加 Image Lane
      </button>

      {error && (
        <p style={{ marginTop: 8, fontSize: 12, color: '#f88' }}>
          ⚠ {error}
        </p>
      )}

      {editing && (
        <CustomImageLaneForm
          initial={editing === 'new' ? null : editing}
          onSave={save}
          onCancel={() => {
            setEditing(null);
            setError(null);
          }}
        />
      )}
    </div>
  );
}

function CustomImageLaneForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: CustomImageLane | null;
  onSave: (form: {
    label: string;
    baseUrl: string;
    model: string;
    apiKey: string;
    size: string;
    quality: string;
    costNote: string;
  }) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '');
  const [size, setSize] = useState(initial?.size ?? '1024x1024');
  const [quality, setQuality] = useState(initial?.quality ?? '');
  const [costNote, setCostNote] = useState(initial?.costNote ?? '');
  const valid = label.trim() && baseUrl.trim() && model.trim() && apiKey.trim();

  return (
    <div
      style={{
        marginTop: 12,
        padding: 16,
        background: '#0f1119',
        borderRadius: 6,
        border: '1px solid #3d2a3d',
      }}
    >
      <h4 style={{ marginTop: 0, marginBottom: 12, fontSize: 14 }}>
        {initial ? `编辑「${initial.label}」` : '新增 Image Lane'}
      </h4>

      <FormRow label="名称" hint="UI 显示名,可随便起">
        <input
          type="text"
          placeholder="例:OpenAI DALL-E 3"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={{ width: '100%' }}
        />
      </FormRow>

      <FormRow
        label="API Base URL"
        hint="https:// 开头,不带尾部 /v1 或 /images/generations。路径由我们拼。"
      >
        <input
          type="text"
          placeholder="例:https://api.openai.com 或 https://api.together.xyz"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
        />
      </FormRow>

      <FormRow
        label="Model 名"
        hint="OpenAI: dall-e-3 / gpt-image-1。Together: black-forest-labs/FLUX.1-dev。SiliconFlow: Kwai-Kolors/Kolors。阿里 DashScope: wanx-v1。"
      >
        <input
          type="text"
          placeholder="例:dall-e-3"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
        />
      </FormRow>

      <FormRow label="API Key" hint="只存你浏览器 localStorage,server 不持久化">
        <input
          type="password"
          placeholder="例:sk-... 或 tg_..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
        />
      </FormRow>

      <FormRow
        label="尺寸(size)"
        hint="DALL-E 3: 1024x1024 / 1024x1792 / 1792x1024。gpt-image-1: 1024x1024 / 1024x1536 / 1536x1024。FLUX 接受自由 WxH。"
      >
        <input
          type="text"
          placeholder="例:1024x1024"
          value={size}
          onChange={(e) => setSize(e.target.value)}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
        />
      </FormRow>

      <FormRow
        label="质量(quality, 可选)"
        hint="DALL-E 3: standard / hd。gpt-image-1: low / medium / high / auto。其他服务多半忽略,留空即可。"
      >
        <input
          type="text"
          placeholder="例:standard"
          value={quality}
          onChange={(e) => setQuality(e.target.value)}
          style={{ width: '100%' }}
        />
      </FormRow>

      <FormRow label="备注(可选)" hint="列表卡片上显示,提醒自己这条 lane 的价钱 / 用途">
        <input
          type="text"
          placeholder="例:DALL-E 3 standard $0.04/张"
          value={costNote}
          onChange={(e) => setCostNote(e.target.value)}
          style={{ width: '100%' }}
        />
      </FormRow>

      <div className="row" style={{ marginTop: 12, gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} className="muted">
          取消
        </button>
        <button
          className="primary"
          disabled={!valid}
          onClick={() =>
            onSave({
              label: label.trim(),
              baseUrl: baseUrl.trim(),
              model: model.trim(),
              apiKey: apiKey.trim(),
              size: size.trim(),
              quality: quality.trim(),
              costNote: costNote.trim(),
            })
          }
        >
          {initial ? '保存修改' : '添加 Image Lane'}
        </button>
      </div>
    </div>
  );
}

// ─── 模型路由 Tab ──────────────────────────────────────────────────

function ModelsTab({ onPresetChange }: { onPresetChange: () => void }) {
  const [presetId, setPresetId] = useState(router.getState().presetId);
  const [matrix, setMatrix] = useState(router.getActiveMatrix());
  const [overrides, setOverrides] = useState(router.getState().overrides);
  const [lanes, setLanes] = useState<Record<LaneId, LaneHealth> | null>(null);
  const [checking, setChecking] = useState(false);
  const [expandedTask, setExpandedTask] = useState<TaskTag | null>(null);
  const [routerVersion, setRouterVersion] = useState(0); // 触发重渲染（fallback 链改动）
  // CUSTOM-LANE-C:自定义 lane 列表版本(增删时 bump,让 3 处下拉重渲染)
  const [customLanesVersion, setCustomLanesVersion] = useState(0);

  // 合并:内置可见 lane + 所有用户自定义 lane(用作所有下拉的数据源)
  const allVisibleLaneIds = useMemo(() => {
    const customIds = listCustomLanes().map((l) => l.id);
    return [...getVisibleLaneIds(), ...customIds];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customLanesVersion]);

  function refresh() {
    setPresetId(router.getState().presetId);
    setMatrix(router.getActiveMatrix());
    setOverrides(router.getState().overrides);
    setRouterVersion((v) => v + 1);
  }

  async function probeAll() {
    setChecking(true);
    try {
      setLanes(await checkAllLanes());
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    void probeAll();
  }, []);

  function applyPreset(id: string) {
    router.setPreset(id);
    refresh();
    onPresetChange();
  }

  function override(task: TaskTag, lane: LaneId) {
    router.setOverride(task, lane);
    refresh();
    onPresetChange();
  }

  function resetAllOverrides() {
    router.clearAllOverrides();
    refresh();
    onPresetChange();
  }

  const currentPreset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];

  return (
    <>
      {/* CUSTOM-LANE-C:自定义 Lane 管理(放最顶部,用户加的 lane 会出现在下方所有下拉里)*/}
      <CustomLaneManager
        onChange={() => {
          setCustomLanesVersion((v) => v + 1);
          void probeAll();
        }}
      />

      {/* IMAGE-T4:自定义 Image Lane 管理(独立 store,不进路由矩阵)*/}
      <CustomImageLaneManager
        onChange={() => {
          /* image lane 变更不影响 LLM probe / matrix,这里无操作。如果未来 PortraitTab
           * 显示在线生图入口,可以在这里 bump 一个版本号让它刷新 lane 下拉。 */
        }}
      />

      {/* Preset 选择 */}
      <div className="card">
        <h3>路由预设</h3>
        <p className="muted" style={{ marginTop: 4, marginBottom: 12, fontSize: 13 }}>
          每个预设给出 8 个任务标签的默认 Lane 映射。你可以在下面的矩阵里逐项覆盖。
        </p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={p.id === presetId ? 'primary' : ''}
              onClick={() => applyPreset(p.id)}
              title={p.description}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
          {currentPreset.description}
        </p>
        {Object.keys(overrides).length > 0 && (
          <p className="muted" style={{ marginTop: 8, fontSize: 12, color: '#fb7' }}>
            ⚠ 你已对 {Object.keys(overrides).length} 个任务做了手动覆盖。
            <button
              onClick={resetAllOverrides}
              style={{ marginLeft: 8, fontSize: 12, padding: '2px 8px' }}
            >
              重置所有覆盖
            </button>
          </p>
        )}
      </div>

      {/* Lane 健康表 */}
      <div className="card">
        <div className="row" style={{ marginBottom: 8, alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Lane 健康</h3>
          <button onClick={probeAll} disabled={checking} style={{ marginLeft: 'auto' }}>
            {checking ? '探活中…' : '重新探活'}
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {allVisibleLaneIds.map((lid) => {
            const def = getLaneDef(lid);
            if (!def) return null;
            const h = lanes?.[def.id];
            const ok = h?.ok;
            return (
              <div
                key={def.id}
                style={{
                  background: '#1a1d29',
                  padding: 10,
                  borderRadius: 6,
                  borderLeft: `3px solid ${ok === true ? '#5a8' : ok === false ? '#a55' : '#666'}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <b style={{ fontSize: 13 }}>{def.label}</b>
                  <span style={{ fontSize: 11, color: ok === true ? '#5a8' : ok === false ? '#a55' : '#888' }}>
                    {ok === true ? '✓ ready' : ok === false ? '✗ ' + (h?.reason ?? '') : '…'}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  {def.model} · {def.costNote}
                </div>
                {h && !ok && h.detail && (
                  <div style={{ fontSize: 11, marginTop: 4, color: '#a77' }}>{h.detail}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 全局 fallback 链批量控制 */}
      <div className="card">
        <h3>全局降级链路</h3>
        <p className="muted" style={{ marginTop: 4, marginBottom: 12, fontSize: 13 }}>
          目标 Lane 不可用时按顺序尝试。默认全任务统一为：
          <b style={{ marginLeft: 6, color: '#7aa' }}>
            {getDefaultTaskFallback().map((l) => getLaneDef(l)?.shortLabel).join(' → ')}
          </b>
          ；最末尾还会自动兜底 Lane 级链路（dev 模式落 <code>local_gemma</code>;public 模式落 <code>deepseek</code>）。
          下面的矩阵每行可单独编辑该任务的链。
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => {
              router.setAllTasksFallback(['codex_bridge']);
              refresh();
              onPresetChange();
            }}
          >
            全部统一为 Codex 主池
          </button>
          <button
            onClick={() => {
              router.setAllTasksFallback(['codex_bridge', 'claude_bridge', 'deepseek']);
              refresh();
              onPresetChange();
            }}
          >
            全部用 Codex → Claude → DeepSeek
          </button>
          <button
            onClick={() => {
              router.setAllTasksFallback(['local_gemma']);
              refresh();
              onPresetChange();
            }}
          >
            全部仅本地兜底
          </button>
          <button
            onClick={() => {
              router.clearAllTasksFallback();
              refresh();
              onPresetChange();
            }}
          >
            重置所有任务为默认
          </button>
        </div>
      </div>

      {/* 任务 × Lane 矩阵 */}
      <div className="card">
        <h3>任务 × Lane 矩阵</h3>
        <p className="muted" style={{ marginTop: 4, marginBottom: 12, fontSize: 13 }}>
          每个任务独立设置：主 Lane（左下拉）+ 降级链（▸ 点开编辑）。
          橙边框 = 已对默认做覆盖。
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2d3e', textAlign: 'left' }}>
              <th style={{ padding: '8px 4px' }}>任务</th>
              <th style={{ padding: '8px 4px' }}>主 Lane</th>
              <th style={{ padding: '8px 4px' }}>降级链路</th>
              <th style={{ padding: '8px 4px', width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {TASKS.map((task) => {
              void routerVersion; // 让闭包跟随 routerVersion 重渲染
              const currentLane = matrix[task.tag];
              const overridden = task.tag in overrides;
              const presetLane = currentPreset.matrix[task.tag];
              const fallback = router.getTaskFallback(task.tag);
              const fallbackCustom = router.isTaskFallbackCustomized(task.tag);
              const expanded = expandedTask === task.tag;
              return (
                <>
                  <tr key={task.tag} style={{ borderBottom: expanded ? 'none' : '1px solid #1a1d29' }}>
                    <td style={{ padding: '8px 4px' }}>
                      <div>
                        <b>{task.label}</b>{' '}
                        <code style={{ fontSize: 11, color: '#888' }}>{task.tag}</code>
                      </div>
                      <div className="muted" style={{ fontSize: 11 }}>{task.description}</div>
                    </td>
                    <td style={{ padding: '8px 4px' }}>
                      <select
                        value={currentLane}
                        onChange={(e) => override(task.tag, e.target.value as LaneId)}
                        style={{
                          background: overridden ? '#3a2d1a' : '#1a1d29',
                          color: 'inherit',
                          border: `1px solid ${overridden ? '#fb7' : '#2a2d3e'}`,
                          padding: '4px 8px',
                          borderRadius: 4,
                          minWidth: 200,
                        }}
                      >
                        {allVisibleLaneIds.map((lid) => {
                          const def = getLaneDef(lid);
                          if (!def) return null;
                          const h = lanes?.[def.id];
                          const indicator = h?.ok === true ? '✓' : h?.ok === false ? '✗' : '·';
                          return (
                            <option key={def.id} value={def.id}>
                              {indicator} {def.shortLabel}
                            </option>
                          );
                        })}
                      </select>
                    </td>
                    <td style={{ padding: '8px 4px' }}>
                      <button
                        onClick={() => setExpandedTask(expanded ? null : task.tag)}
                        style={{
                          fontSize: 12,
                          padding: '4px 8px',
                          background: fallbackCustom ? '#3a2d1a' : '#1a1d29',
                          border: `1px solid ${fallbackCustom ? '#fb7' : '#2a2d3e'}`,
                          borderRadius: 4,
                        }}
                      >
                        {expanded ? '▾' : '▸'}{' '}
                        {fallback.length > 0
                          ? fallback.map((l) => getLaneDef(l)?.shortLabel).join(' → ')
                          : '(无)'}
                      </button>
                    </td>
                    <td style={{ padding: '8px 4px' }}>
                      {overridden && (
                        <button
                          title={`恢复预设默认: ${getLaneDef(presetLane)?.shortLabel ?? presetLane}`}
                          onClick={() => {
                            router.clearOverride(task.tag);
                            refresh();
                            onPresetChange();
                          }}
                          style={{ fontSize: 11, padding: '2px 6px' }}
                        >
                          ↺
                        </button>
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <tr key={task.tag + '_edit'} style={{ borderBottom: '1px solid #1a1d29' }}>
                      <td colSpan={4} style={{ padding: '8px 12px 12px 24px', background: '#0e1018' }}>
                        <FallbackEditor
                          task={task.tag}
                          currentChain={fallback}
                          isCustom={fallbackCustom}
                          primaryLane={currentLane}
                          lanes={lanes}
                          allLaneIds={allVisibleLaneIds}
                          onChange={() => {
                            refresh();
                            onPresetChange();
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── Fallback 链编辑器（行内展开）─────────────────────────────────

function FallbackEditor({
  task,
  currentChain,
  isCustom,
  primaryLane,
  lanes,
  allLaneIds,
  onChange,
}: {
  task: TaskTag;
  currentChain: LaneId[];
  isCustom: boolean;
  primaryLane: LaneId;
  lanes: Record<LaneId, LaneHealth> | null;
  /** CUSTOM-LANE-C:全部可见 lane(含 custom),让 fallback 链编辑器也能选 custom lane */
  allLaneIds: LaneId[];
  onChange: () => void;
}) {
  const [addLane, setAddLane] = useState<LaneId>('codex_bridge');

  function removeAt(idx: number) {
    const next = currentChain.filter((_, i) => i !== idx);
    router.setTaskFallback(task, next);
    onChange();
  }

  function moveUp(idx: number) {
    if (idx === 0) return;
    const next = [...currentChain];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    router.setTaskFallback(task, next);
    onChange();
  }

  function moveDown(idx: number) {
    if (idx === currentChain.length - 1) return;
    const next = [...currentChain];
    [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
    router.setTaskFallback(task, next);
    onChange();
  }

  function append() {
    if (currentChain.includes(addLane) || addLane === primaryLane) return; // 去重 + 不含主 lane
    router.setTaskFallback(task, [...currentChain, addLane]);
    onChange();
  }

  function reset() {
    router.clearTaskFallback(task);
    onChange();
  }

  return (
    <div style={{ fontSize: 12 }}>
      <div className="muted" style={{ marginBottom: 8 }}>
        主 Lane <b style={{ color: '#7aa' }}>{getLaneDef(primaryLane)?.shortLabel}</b> 不可用时，按下面顺序尝试：
      </div>
      {currentChain.length === 0 && (
        <div className="muted" style={{ fontStyle: 'italic', marginBottom: 8 }}>
          (空链路 —— 完全依赖 Lane 级默认兜底)
        </div>
      )}
      {currentChain.map((lane, idx) => {
        const h = lanes?.[lane];
        const indicator = h?.ok === true ? '✓' : h?.ok === false ? '✗' : '·';
        return (
          <div
            key={`${lane}_${idx}`}
            className="row"
            style={{
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              background: '#1a1d29',
              borderRadius: 4,
              marginBottom: 4,
            }}
          >
            <span style={{ color: '#888', minWidth: 18 }}>{idx + 1}.</span>
            <span style={{ flex: 1 }}>
              {indicator} {getLaneDef(lane)?.label} <code style={{ color: '#888' }}>{getLaneDef(lane)?.model}</code>
            </span>
            <button onClick={() => moveUp(idx)} disabled={idx === 0} style={{ padding: '2px 6px', fontSize: 11 }}>↑</button>
            <button onClick={() => moveDown(idx)} disabled={idx === currentChain.length - 1} style={{ padding: '2px 6px', fontSize: 11 }}>↓</button>
            <button onClick={() => removeAt(idx)} style={{ padding: '2px 6px', fontSize: 11, color: '#f88' }}>×</button>
          </div>
        );
      })}
      <div className="row" style={{ marginTop: 8, gap: 6, alignItems: 'center' }}>
        <span className="muted">添加：</span>
        <select
          value={addLane}
          onChange={(e) => setAddLane(e.target.value as LaneId)}
          style={{ background: '#1a1d29', color: 'inherit', border: '1px solid #2a2d3e', padding: '4px 8px', borderRadius: 4 }}
        >
          {allLaneIds
            .map((lid) => getLaneDef(lid))
            .filter((d): d is LaneDef => !!d)
            .filter((d) => d.id !== primaryLane && !currentChain.includes(d.id))
            .map((d) => {
              const h = lanes?.[d.id];
              const ind = h?.ok === true ? '✓' : h?.ok === false ? '✗' : '·';
              return (
                <option key={d.id} value={d.id}>
                  {ind} {d.label}
                </option>
              );
            })}
        </select>
        <button onClick={append} style={{ padding: '4px 10px' }}>
          + 添加到链尾
        </button>
        {isCustom && (
          <button onClick={reset} style={{ padding: '4px 10px', marginLeft: 'auto' }}>
            ↺ 恢复默认链
          </button>
        )}
      </div>
      {!isCustom && (
        <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          ↑ 当前是全局默认链 (DEFAULT_TASK_FALLBACK)，改任意一项会变成该任务的私有 override
        </div>
      )}
    </div>
  );
}

// ─── BYOK-BASE-3:可选 API Base URL 输入框 ───────────────────────────
//
// 每个 provider key 输入框下面放一个折叠展开的"自定义 base URL"。
// 留空 = 用 DEFAULT_BASE_URLS(各家官方);填了 = 接 OpenAI 兼容服务
// (OpenRouter / Together / Groq / SiliconFlow / Moonshot / 阿里通义 / 自建 vLLM ...)。
//
// 输入框初始空 = 走默认。如果用户已经设过(localStorage 有值)默认展开,
// 让用户能看到当前指向哪里。

function BaseUrlInput({
  provider,
  examples,
}: {
  provider: Provider;
  /** 例子文案,比如 "OpenRouter: https://openrouter.ai/api · Groq: https://api.groq.com/openai" */
  examples?: string;
}) {
  const defaultBase = DEFAULT_BASE_URLS[provider];
  const [val, setVal] = useState('');
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const stored = keyStore.getBaseUrl(provider) ?? '';
    setVal(stored);
    if (stored) setOpen(true); // 已设过 = 默认展开,让用户看到
  }, [provider]);

  function save() {
    keyStore.setBaseUrl(provider, val);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function resetToOfficial() {
    setVal('');
    keyStore.setBaseUrl(provider, '');
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  const summary = val
    ? `(已自定义 → ${val.length > 40 ? val.slice(0, 40) + '…' : val})`
    : '(默认走官方)';

  return (
    <div style={{ marginTop: 8 }}>
      <a
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: 'pointer', color: '#7aa', fontSize: 12, userSelect: 'none' }}
      >
        {open ? '▼' : '▶'} 高级:自定义 API Base URL <span className="muted">{summary}</span>
      </a>
      {open && (
        <div
          style={{
            marginTop: 8,
            padding: 12,
            background: '#0f1119',
            borderRadius: 6,
            border: '1px solid #2a2d3e',
          }}
        >
          <p className="muted" style={{ marginTop: 0, marginBottom: 8, fontSize: 12 }}>
            留空 = 用官方 <code>{defaultBase}</code>。
            <br />
            填别的 = 接 OpenAI 兼容服务(只要它兼容 <code>/v1/chat/completions</code> 协议)。
            <br />
            <b>不要</b>带尾部 <code>/v1</code> 或 <code>/chat/completions</code>,路径由我们拼。
          </p>
          {examples && (
            <p className="muted" style={{ fontSize: 11, marginBottom: 8, fontFamily: 'monospace' }}>
              例:{examples}
            </p>
          )}
          <input
            type="text"
            placeholder={defaultBase}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            style={{ width: '100%', padding: '6px 10px', fontSize: 12, fontFamily: 'monospace' }}
          />
          <div className="row" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
            <button onClick={save} style={{ fontSize: 12, padding: '4px 12px' }}>
              保存
            </button>
            <button onClick={resetToOfficial} style={{ fontSize: 12, padding: '4px 12px' }}>
              用官方默认
            </button>
            {saved && (
              <span className="muted" style={{ fontSize: 11 }}>
                ✓ 已保存
              </span>
            )}
            <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }}>
              ⚠ 只允许 https,不能填 localhost / 内网 IP
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 设置 Tab ───────────────────────────────────────────────────────

function SettingsTab({ onChanged }: { onChanged: () => void }) {
  const [val, setVal] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState<LlmMode>('apikey');
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null);
  const [checkingBridge, setCheckingBridge] = useState(false);
  const [saved, setSaved] = useState(false);

  // 多 provider keys
  const [deepseekKey, setDeepseekKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  // 玩家级游戏体验偏好:允许 LLM 运行时即兴扩展新场所(双开关之一,剧本侧也要开)
  const [allowRuntimeExpansion, setAllowRuntimeExpansion] = useState(false);

  useEffect(() => {
    setVal(keyStore.get('anthropic') ?? '');
    setModel(prefStore.get().anthropicModel ?? '');
    setMode(prefStore.get().llmMode ?? 'apikey');
    setDeepseekKey(keyStore.get('deepseek') ?? '');
    setOpenaiKey(keyStore.get('openai') ?? '');
    setAllowRuntimeExpansion(plaza.getPlayerSettings().allowRuntimeExpansion);
  }, []);

  function toggleAllowRuntimeExpansion() {
    const next = !allowRuntimeExpansion;
    plaza.setAllowRuntimeExpansion(next);
    setAllowRuntimeExpansion(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function saveKey(provider: Provider, key: string) {
    if (key.trim()) keyStore.set(provider, key.trim());
    else keyStore.clear(provider);
    onChanged();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  async function pingBridge() {
    setCheckingBridge(true);
    try {
      setBridgeHealth(await checkBridgeHealth());
    } finally {
      setCheckingBridge(false);
    }
  }

  function switchMode(next: LlmMode) {
    prefStore.set({ ...prefStore.get(), llmMode: next });
    setMode(next);
    onChanged();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    if (next === 'bridge') void pingBridge();
  }

  return (
    <div className="card">
      <h3>LLM 调用模式</h3>
      <p className="muted" style={{ marginTop: 4, marginBottom: 12 }}>
        选你这次会话怎么连 Claude。模式切换会立即生效。
      </p>

      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button
          className={mode === 'apikey' ? 'primary' : ''}
          onClick={() => switchMode('apikey')}
        >
          🔑 API Key（BYOK）
        </button>
        <button
          className={mode === 'bridge' ? 'primary' : ''}
          onClick={() => switchMode('bridge')}
        >
          🌉 Bridge（Agent SDK Credit 池）
        </button>
        {saved && <span className="muted">✓ 已切换</span>}
      </div>

      {mode === 'apikey' && (
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          浏览器端直调 Anthropic（带 <code>anthropic-dangerous-direct-browser-access</code> 头）。
          按量扣你 Console 的 pay-as-you-go 余额，**不消耗** Agent SDK Credit 池。
        </p>
      )}

      {mode === 'bridge' && (
        <div
          style={{
            background: '#1a1d29',
            padding: 12,
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          <p style={{ marginTop: 0 }}>
            把 chat 请求转发到本机 <code>http://127.0.0.1:8765</code> 的 Claude Agent SDK Bridge，
            从而消耗你 Claude 订阅的 Agent SDK Credit 池（Pro $20 / Max 5x $100 / Max 20x $200 / 月）。
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            ⚠ 政策 2026-06-15 才生效。今天提前装也是空跑的（OAuth 调用会被 Anthropic 拒）。
          </p>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button onClick={pingBridge} disabled={checkingBridge}>
              {checkingBridge ? '检查中…' : '检查 Bridge 状态'}
            </button>
          </div>
          {bridgeHealth && (
            <pre style={{ marginTop: 12, fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {`reachable:     ${bridgeHealth.reachable ? '✓' : '✗'}
sdk loaded:    ${bridgeHealth.sdkLoaded ? '✓' : '✗'}${bridgeHealth.sdkLoadError ? ` (${bridgeHealth.sdkLoadError})` : ''}
oauth token:   ${bridgeHealth.hasOauthToken ? '✓' : '✗'}
port:          ${bridgeHealth.port ?? '?'}${bridgeHealth.detail ? `\ndetail:        ${bridgeHealth.detail}` : ''}`}
            </pre>
          )}
          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ cursor: 'pointer' }}>
              ▸ 启用流程（6-15 之后 / 现在可预先准备）
            </summary>
            <pre style={{ fontSize: 12, lineHeight: 1.6, marginTop: 8 }}>
{`# 1. 装 Claude Code CLI（拿 OAuth token 工具）
npm i -g @anthropic-ai/claude-code

# 2. 浏览器登录，拿 1 年 OAuth token
claude setup-token
#    输出形如 sk-ant-oat01-...

# 3. 写到 poc/.env.local
echo 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...' >> .env.local

# 4. 装 Agent SDK
cd poc && npm i @anthropic-ai/claude-agent-sdk

# 5. 启 bridge 进程（保持运行）
node scripts/claude_bridge.mjs

# 6. 回这里点 "检查 Bridge 状态" → 都 ✓ 就能聊了
`}
            </pre>
          </details>
        </div>
      )}

      <hr style={{ margin: '24px 0', border: 'none', borderTop: '1px solid #2a2d3e' }} />

      <h3>Anthropic API Key (BYOK)</h3>
      <p className="muted" style={{ marginTop: 4, marginBottom: 12 }}>
        Key 仅存在你浏览器的 localStorage，永不离开你的设备。
        <br />
        生产版会用 IndexedDB + WebCrypto 加密；PoC 简化为 localStorage 明文。
      </p>
      <input
        type="password"
        placeholder="sk-ant-..."
        value={val}
        onChange={(e) => setVal(e.target.value)}
      />
      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="primary"
          onClick={() => {
            if (val.trim()) {
              keyStore.set('anthropic', val.trim());
              setSaved(true);
              onChanged();
              setTimeout(() => setSaved(false), 2000);
            }
          }}
          disabled={!val.trim()}
        >
          保存
        </button>
        <button
          onClick={() => {
            keyStore.clear('anthropic');
            setVal('');
            onChanged();
          }}
        >
          清除
        </button>
        {saved && <span className="muted">✓ 已保存</span>}
      </div>
      <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
        去 <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a> 创建 key。
      </p>
      <BaseUrlInput
        provider="anthropic"
        examples="自建 Anthropic 兼容 proxy / Azure Anthropic 等(少见)"
      />

      <hr style={{ margin: '24px 0', border: 'none', borderTop: '1px solid #2a2d3e' }} />

      <h3>Anthropic Model（可选）</h3>
      <p className="muted" style={{ marginTop: 4, marginBottom: 12 }}>
        留空则用默认 alias <code>{DEFAULT_ANTHROPIC_MODEL}</code>。
        <br />
        如果默认 alias 你账号不可用（404 model_not_found），在这里填一个你账号可用的精确版本，比如：
        <br />
        <code>claude-sonnet-4-5-20250929</code> · <code>claude-haiku-4-5</code> · <code>claude-opus-4-5</code>
      </p>
      <input
        type="text"
        placeholder={DEFAULT_ANTHROPIC_MODEL}
        value={model}
        onChange={(e) => setModel(e.target.value)}
      />
      <div className="row" style={{ marginTop: 12 }}>
        <button
          onClick={() => {
            prefStore.set({ ...prefStore.get(), anthropicModel: model.trim() || undefined });
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
          }}
        >
          保存 model
        </button>
        <button
          onClick={() => {
            const p = prefStore.get();
            delete p.anthropicModel;
            prefStore.set(p);
            setModel('');
          }}
        >
          恢复默认
        </button>
      </div>

      <hr style={{ margin: '24px 0', border: 'none', borderTop: '1px solid #2a2d3e' }} />

      <h3>DeepSeek API Key</h3>
      <p className="muted" style={{ marginTop: 4, marginBottom: 12, fontSize: 13 }}>
        在 platform.deepseek.com 创建 key。用于 Lane <code>deepseek</code>（v4-flash 默认）。
        Key 仅存浏览器 localStorage，调用时通过 Authorization 头 → Next API route → DeepSeek。
      </p>
      <input
        type="password"
        placeholder="sk-..."
        value={deepseekKey}
        onChange={(e) => setDeepseekKey(e.target.value)}
      />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => saveKey('deepseek', deepseekKey)} disabled={!deepseekKey.trim()}>
          保存
        </button>
        <button onClick={() => { setDeepseekKey(''); saveKey('deepseek', ''); }}>清除</button>
      </div>
      <BaseUrlInput
        provider="deepseek"
        examples="OpenRouter: https://openrouter.ai/api · Groq: https://api.groq.com/openai · SiliconFlow: https://api.siliconflow.cn · Moonshot: https://api.moonshot.cn · 自建 vLLM: https://your-vllm.example.com"
      />

      <hr style={{ margin: '24px 0', border: 'none', borderTop: '1px solid #2a2d3e' }} />

      <h3>OpenAI API Key（Codex fallback）</h3>
      <p className="muted" style={{ marginTop: 4, marginBottom: 12, fontSize: 13 }}>
        在 platform.openai.com 创建 key。用于 Lane <code>codex_api</code>（gpt-5.2-codex / gpt-5.4 / 等）
        ——当 Codex CLI bridge 不可用（CLI 没装或没登录）时自动 fallback 到这里。
        <br />
        <b>注意</b>：这条扣 OpenAI Console pay-as-you-go 余额，<b>不</b>消耗你 ChatGPT Pro 订阅的 Codex 5h/7d 池。
        要走订阅池请装 codex CLI + 跑 codex_bridge.mjs（见「模型路由」tab 里的 Lane 健康卡片）。
      </p>
      <input
        type="password"
        placeholder="sk-..."
        value={openaiKey}
        onChange={(e) => setOpenaiKey(e.target.value)}
      />
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => saveKey('openai', openaiKey)} disabled={!openaiKey.trim()}>
          保存
        </button>
        <button onClick={() => { setOpenaiKey(''); saveKey('openai', ''); }}>清除</button>
      </div>
      <BaseUrlInput
        provider="openai"
        examples="OpenRouter: https://openrouter.ai/api · Together: https://api.together.xyz · Fireworks: https://api.fireworks.ai/inference · Azure OpenAI: https://YOUR.openai.azure.com"
      />

      <hr style={{ margin: '24px 0', border: 'none', borderTop: '1px solid #2a2d3e' }} />

      {/* CUSTOM-LANE-D:引导用户去 ModelsTab 加自定义 lane */}
      <div
        style={{
          padding: 12,
          background: '#0f1a14',
          border: '1px solid #2a3d3a',
          borderRadius: 6,
          marginBottom: 16,
          fontSize: 13,
        }}
      >
        <div style={{ fontWeight: 700, color: '#9ce', marginBottom: 4 }}>
          🛠 想接其他 OpenAI 兼容服务?
        </div>
        <p className="muted" style={{ marginTop: 4, marginBottom: 4 }}>
          OpenRouter / Groq / SiliconFlow / Moonshot / 阿里通义 / Fireworks / 自建 vLLM 等
          OpenAI 兼容服务,不必塞进上面 3 家固定的位置 — 去
          <b style={{ color: '#9cf' }}> 模型路由 Tab → 🛠 自定义 Lane </b>
          加任意条数的自定义 lane,每条都能在路由矩阵里指定给任意任务。
        </p>
      </div>

      <h3 style={{ marginBottom: 8 }}>游戏体验 · 实时世界扩展</h3>
      <p className="muted" style={{ marginTop: 4, marginBottom: 12, fontSize: 13 }}>
        允许 LLM 在剧情中**即兴新增场所**(玩家提到要去某个剧本没预设的具体地点时,
        AI 可以延展叙事并把新地点物化进存档,后续仍可重访)。
        <br />
        需要剧本作者也声明支持 — 不支持的剧本里此设置不生效。
      </p>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: 'pointer',
          padding: '8px 12px',
          background: allowRuntimeExpansion ? '#1a3a2a' : '#1a1d29',
          borderRadius: 6,
          border: `1px solid ${allowRuntimeExpansion ? '#2d6e4a' : '#2a2d3e'}`,
        }}
      >
        <input
          type="checkbox"
          checked={allowRuntimeExpansion}
          onChange={toggleAllowRuntimeExpansion}
          style={{ width: 16, height: 16 }}
        />
        <span style={{ fontWeight: 500 }}>允许 LLM 即兴扩展新场所</span>
        {saved && allowRuntimeExpansion && (
          <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
            ✓ 已开启
          </span>
        )}
      </label>
      <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
        关闭时(默认):LLM 只能在剧本预设的地点间引导玩家穿梭 — 戏剧节奏最贴近作者编排。
        <br />
        开启后:LLM 看到玩家提到"酒馆后院"这种未预设地点时,可即兴扩展并把它物化(每个 session 最多 ~8 个)。
        适合想深度沉浸某个剧本、走到天涯海角去探索的玩家。
      </p>

      <hr style={{ margin: '24px 0', border: 'none', borderTop: '1px solid #2a2d3e' }} />

      <h3 style={{ marginBottom: 8 }}>关于浏览器直调 Anthropic</h3>
      <p className="muted" style={{ fontSize: 12 }}>
        PoC 用 <code>anthropic-dangerous-direct-browser-access: true</code> 头让浏览器直连
        Anthropic API（避免在 PoC 阶段搭一个 server proxy）。这条路径
        Anthropic 官方不保证长期支持——如果未来某天报 CORS 错误或被关闭，需要切换到自己的 server-side proxy。
      </p>

      {/* LAUNCH-T6:存储用量监控 + 导出 */}
      <StorageUsagePanel />
    </div>
  );
}

// ─── LAUNCH-T6:存储用量面板 ─────────────────────────────────────────
//
// 所有 plaza state(进度 / 关系 / 库存 / 已 spawn 地点 / 立绘 dataUrl)都存在
// localStorage 一个 key 里,5-10MB 上限。立绘 dataUrl 是大头,长期玩会撞上限。
// 这个面板:
//   - 实时显示用量(orange >70%,red >90%)
//   - 一键导出整个 plaza 为 JSON(用户备份)
//   - 提示用户接近上限时去广场页面重置或删除大图

function StorageUsagePanel() {
  const [stat, setStat] = useState<PlazaStorageStat | null>(null);
  // P1-#4:聚合显示所有 store 的写入错误(plaza/router/customLanes/keyStore/prefStore)
  const [storeErrors, setStoreErrors] = useState<{ name: string; error: string }[]>([]);

  useEffect(() => {
    const refresh = () => {
      setStat(getPlazaStorageSize());
      const errs: { name: string; error: string }[] = [];
      const e1 = getPlazaWriteError();
      if (e1) errs.push({ name: '广场', error: e1 });
      const e2 = getRouterWriteError();
      if (e2) errs.push({ name: '路由配置', error: e2 });
      const e3 = getCustomLanesWriteError();
      if (e3) errs.push({ name: '自定义 Lane', error: e3 });
      const e4 = getKeyStoreWriteError();
      if (e4) errs.push({ name: 'API key/Base URL', error: e4 });
      const e5 = getPrefStoreWriteError();
      if (e5) errs.push({ name: '偏好设置', error: e5 });
      setStoreErrors(errs);
    };
    refresh();
    // plaza 写入会触发 sub;其他 store 的 error 在 plaza 也触发 / 用户切 tab 重渲时刷新
    return subscribePlaza(refresh);
  }, []);

  if (!stat) return null;

  const mb = (stat.bytes / 1_000_000).toFixed(2);
  const quotaMb = (stat.quota / 1_000_000).toFixed(0);
  const barColor = stat.level === 'danger' ? '#a55' : stat.level === 'warn' ? '#c93' : '#5a8';

  function download(includeKeys: boolean) {
    // 含 key 走二次确认 — 明文 BYOK secret 泄露后第三方可直接花用户的钱
    if (includeKeys) {
      const ok = window.confirm(
        '⚠ 即将导出含明文 API key 的备份。\n\n' +
          '这份 JSON 文件可以让任何拿到它的人直接花你 BYOK 账户的钱。\n\n' +
          '建议:\n' +
          '  · 只在自己机器上短暂保存\n' +
          '  · 立即加密 / 上传到密码管理器\n' +
          '  · 用完立刻删除\n\n' +
          '确定继续?',
      );
      if (!ok) return;
    }
    const json = exportAllAsJson({ includeKeys });
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const suffix = includeKeys ? '-with-keys' : '';
    a.download = `world-crossing-backup${suffix}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      style={{
        marginTop: 20,
        padding: 12,
        background: '#0f1119',
        borderRadius: 6,
        border: `1px solid ${stat.level === 'ok' ? '#2a2d3e' : barColor}`,
      }}
    >
      <div
        className="row"
        style={{ alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}
      >
        <h4 style={{ margin: 0, fontSize: 14 }}>💾 存储用量</h4>
        <span style={{ fontSize: 12, color: barColor, fontFamily: 'monospace' }}>
          {mb} MB / {quotaMb} MB ({stat.percent.toFixed(0)}%)
        </span>
      </div>
      <div
        style={{
          height: 8,
          background: '#1a1d29',
          borderRadius: 4,
          overflow: 'hidden',
          marginBottom: 8,
        }}
      >
        <div
          style={{
            width: `${stat.percent}%`,
            height: '100%',
            background: barColor,
            transition: 'width 0.3s ease',
          }}
        />
      </div>

      {stat.level === 'warn' && (
        <p className="muted" style={{ fontSize: 12, color: '#fc9', marginTop: 4, marginBottom: 8 }}>
          ⚠ 用量超过 70%。建议导出备份,或去广场重置某个剧本(立绘 dataUrl 是大头)。
        </p>
      )}
      {stat.level === 'danger' && (
        <p style={{ fontSize: 12, color: '#fbb', marginTop: 4, marginBottom: 8 }}>
          🚨 用量超过 90%,接近浏览器 localStorage 上限!下次写入可能失败。立刻导出备份 + 清理立绘 /
          重置剧本。
        </p>
      )}

      {storeErrors.length > 0 && (
        <div
          style={{
            marginBottom: 8,
            padding: 8,
            background: '#3a1a1a',
            borderRadius: 4,
            border: '1px solid #6a2a2a',
          }}
        >
          <div style={{ fontSize: 12, color: '#fbb', fontWeight: 600, marginBottom: 4 }}>
            ⚠ 最近 {storeErrors.length} 个 store 写入失败(撞 quota 或浏览器拒绝):
          </div>
          <ul style={{ fontSize: 11, color: '#fbb', margin: '4px 0 0 16px', padding: 0 }}>
            {storeErrors.map((e, i) => (
              <li key={i}>
                <b>{e.name}</b>: {e.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => download(false)} style={{ fontSize: 12, padding: '4px 12px' }}>
          ⬇ 导出全部进度(JSON)
        </button>
        <button
          onClick={() => download(true)}
          title="含明文 API key,只在自己机器上用,慎用"
          style={{
            fontSize: 11,
            padding: '4px 10px',
            background: '#3a2a1a',
            color: '#fc9',
            border: '1px solid #6a4a2a',
            borderRadius: 4,
          }}
        >
          🔑 含 key 备份(慎用)
        </button>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
        覆盖:广场进度 / 路由配置 / 自定义剧本 / 自定义 lane / Base URL / Onboarding 状态。
        <br />
        默认<b>不</b>含 API key 明文。导入功能待开发,目前需手动 paste 到 localStorage。
      </div>
    </div>
  );
}

// ─── 广场 Tab ──────────────────────────────────────────────────────

function magicSystemLabel(t: MagicSystem): string {
  return MAGIC_SYSTEMS.find((m) => m.id === t)?.label ?? t;
}

function PlazaTab({
  onEnterScenario,
  onExitScenario,
  onForceRefresh,
}: {
  /**
   * 用户点了"进入"按钮 — 顶层接管:弹 EntryModal 让玩家选 soul/body + 填愿望,
   * 提交后才真正 plaza.enterScenario。startSceneId 透传到 enterScenario 第三个参数。
   */
  onEnterScenario: (scenarioId: string, startSceneId?: string) => void;
  /** 离开剧本(顶层把 inScenarioId 设回 null) */
  onExitScenario: () => void;
  /** 任意 plaza 操作后让顶层重读 inScenario(防 stale) */
  onForceRefresh: () => void;
}) {
  // M4 修复:旧实现用 tick+useEffect 异步刷新,导致编辑保存时 `editing` 先变 false
  // 而 `profile` 在下一帧才更新,ProfileCard 的 useEffect 在中间帧把内部 state 重置成旧 profile,视觉上闪一帧旧值。
  // 改成同步读 plaza.get() 直接 setState,让 editing 和 profile 在同一批处理里到达 ProfileCard。
  const [state, setState] = useState<PlazaState | null>(null);
  const [editingPlayer, setEditingPlayer] = useState(false);
  const [editingCompanionId, setEditingCompanionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [returningFromPlaza, setReturningFromPlaza] = useState(false);

  // 初次 mount 时读 plaza(SSR 安全)
  useEffect(() => {
    setState(plaza.get());
  }, []);

  function refresh() {
    setState(plaza.get()); // 同步读,不再走 tick → useEffect 两步
    setActionError(null);
    // 顺手把 localStorage 写入错误(quota 满了)冒出来给用户
    const we = getPlazaWriteError();
    if (we) setActionError(we);
  }
  function showError(reason: string) {
    setActionError(reason);
  }

  if (!state) {
    return <div className="card">加载广场状态中...</div>;
  }

  const scenarios = listScenarios();
  const currentScenario = state.inScenario ? getScenario(state.inScenario) : null;

  return (
    <>
      {/* ─── 顶栏: 原力 + 状态 ─── */}
      <div className="card row" style={{ alignItems: 'center', gap: 16 }}>
        <div style={{ flex: 'none', minWidth: 140 }}>
          <div className="muted" style={{ fontSize: 12 }}>原力余额</div>
          <div
            style={{
              fontSize: 36,
              fontWeight: 700,
              color: '#ffd86b',
              lineHeight: 1.1,
              fontFamily: 'monospace',
            }}
          >
            {state.force}
          </div>
        </div>
        <div style={{ flex: 1 }}>
          {currentScenario ? (
            <p>
              当前位置: <b style={{ color: '#7aa' }}>剧本「{currentScenario.name}」中</b>
            </p>
          ) : (
            <p>
              当前位置: <b>广场</b> · 准备出发或休整
            </p>
          )}
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            原力 = 跨剧本通用最稀有积分。可用于进入新剧本 / 升级队友 / 升级物品。
            完成剧本任务时按完成度返还原力(越高奖越多)。
          </p>
        </div>
        {currentScenario && (() => {
          const progress = plaza.getScenarioProgress(currentScenario.id);
          const completion = computeCompletion(currentScenario, progress?.completedBeatIds ?? []);
          const reward = computeForceReward(currentScenario, completion);
          const hasSkeleton = !!currentScenario.scenes && currentScenario.scenes.length > 0;
          return (
            <button
              disabled={returningFromPlaza}
              onClick={async () => {
                if (
                  !window.confirm(
                    `从「${currentScenario.name}」返回广场?\n完成度 ${Math.round(completion * 100)}%,预估原力 +${reward}。${
                      hasSkeleton ? '\n\n如果之前有跟 NPC 对话,会自动整理记忆。' : ''
                    }`,
                  )
                )
                  return;
                setReturningFromPlaza(true);
                // B1:遍历所有有对话的 NPC 跑固化
                const consolidation = await consolidateAllChattedNpcs(currentScenario.id);
                plaza.exitScenario(reward);
                refresh();
                onExitScenario();
                setReturningFromPlaza(false);
                window.alert(
                  `返回广场。完成度 ${Math.round(completion * 100)}%,获得原力 +${reward}。\n\n${formatConsolidationSummary(consolidation)}`,
                );
              }}
            >
              {returningFromPlaza ? '整理记忆中…' : '返回广场'}
            </button>
          );
        })()}
      </div>

      {actionError && (
        <div className="card" style={{ borderColor: '#a44', color: '#f88' }}>
          {actionError}
          <button
            onClick={() => setActionError(null)}
            style={{ marginLeft: 8, fontSize: 11 }}
          >
            知道了
          </button>
        </div>
      )}

      {/* ─── 主角档案 ─── */}
      <div className="card">
        <h3 style={{ marginBottom: 8 }}>主角档案</h3>
        <ProfileCard
          profile={state.player}
          editing={editingPlayer}
          onSave={(patch) => {
            plaza.updatePlayerProfile(patch);
            setEditingPlayer(false);
            refresh();
          }}
          onEdit={() => setEditingPlayer(true)}
          onCancel={() => setEditingPlayer(false)}
        />
      </div>

      {/* ─── 队友 ─── */}
      <div className="card">
        <h3 style={{ marginBottom: 8 }}>
          队友 · <span className="muted" style={{ fontSize: 14, fontWeight: 'normal' }}>{state.companions.length} 个</span>
        </h3>
        <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          可收起为卡片(休眠)或放出(激活)。进入新世界时可选是否同行(Phase B)。升级用原力。
        </p>
        {state.companions.length === 0 && <p className="muted">(暂无队友)</p>}
        {state.companions.map((c) => (
          <CompanionCard
            key={c.characterId}
            entry={c}
            editing={editingCompanionId === c.characterId}
            onToggleActive={() => {
              plaza.toggleCompanionActive(c.characterId);
              refresh();
            }}
            onUpgrade={() => {
              const r = plaza.upgradeCompanion(c.characterId);
              if (!r.ok) showError(r.reason);
              else refresh();
            }}
            onRevive={() => {
              const cost = companionReviveCost(c);
              if (!window.confirm(`复活 ${c.profile.origin?.split('·')[0]?.trim() ?? '队友'}?\n将消耗 ${cost} 原力。`)) {
                return;
              }
              const r = plaza.reviveCompanion(c.characterId);
              if (!r.ok) showError(r.reason);
              else refresh();
            }}
            onEdit={() => setEditingCompanionId(c.characterId)}
            onSaveEdit={(patch) => {
              plaza.updateCompanionProfile(c.characterId, patch);
              setEditingCompanionId(null);
              refresh();
            }}
            onCancelEdit={() => setEditingCompanionId(null)}
            onRemove={() => {
              if (!window.confirm(`移除队友?此操作不可撤销(可用调试按钮重置广场恢复)。`)) return;
              plaza.removeCompanion(c.characterId);
              refresh();
            }}
          />
        ))}
      </div>

      {/* ─── 背包 ─── */}
      <div className="card">
        <h3 style={{ marginBottom: 8 }}>
          背包 · <span className="muted" style={{ fontSize: 14, fontWeight: 'normal' }}>{state.inventory.length} 件</span>
        </h3>
        <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          神奇物品(magic)有魔法系统标签。跨剧本时跟剧本 magic 系统无交集 → 在该剧本里削弱。
          普通物品(mundane)全场通用。
        </p>
        {state.inventory.length === 0 && <p className="muted">(背包空)</p>}
        {state.inventory.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            onUpgrade={() => {
              const r = plaza.upgradeItem(item.id);
              if (!r.ok) showError(r.reason);
              else refresh();
            }}
            onRemove={() => {
              if (!window.confirm(`丢弃 ${item.name}?`)) return;
              plaza.removeItem(item.id);
              refresh();
            }}
          />
        ))}
      </div>

      {/* ─── 可进入剧本 ─── */}
      <div className="card">
        <h3 style={{ marginBottom: 8 }}>
          可进入的剧本世界 · <span className="muted" style={{ fontSize: 14, fontWeight: 'normal' }}>{scenarios.length} 个</span>
        </h3>
        {scenarios.map((sc) => {
          const suppressedItems = state.inventory.filter((i) => isItemSuppressed(i, sc.magicTags));
          const settled = plaza.isScenarioSettled(sc.id);
          const effectiveCost = settled ? 0 : sc.entryCost;
          const canAfford = state.force >= effectiveCost;
          const isInThis = state.inScenario === sc.id;
          const blockedByOtherScenario = !!state.inScenario && !isInThis;
          return (
            <div
              key={sc.id}
              className="card"
              style={{ background: '#181a23', marginTop: 12 }}
            >
              <div
                className="row"
                style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}
              >
                <div style={{ flex: 1 }}>
                  <h4 style={{ marginBottom: 4 }}>
                    {sc.name}{' '}
                    <span
                      className="muted"
                      style={{ fontSize: 12, fontWeight: 'normal' }}
                    >
                      ({sc.shortName})
                    </span>
                    {settled && (
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: 10,
                          padding: '2px 8px',
                          borderRadius: 99,
                          background: '#1a3a1a',
                          color: '#8c8',
                          border: '1px solid #2a5a2a',
                          verticalAlign: 'middle',
                        }}
                        title="此剧本已结算 · 再访免 entryCost,但不再有原力收益。可继续探索 / 陪 NPC,战死 / 物品损毁仍正常。"
                      >
                        ✅ 已通关 · 再访免费
                      </span>
                    )}
                  </h4>
                  <p className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
                    {sc.description}
                  </p>
                  <p className="muted" style={{ fontSize: 12 }}>
                    入场:{' '}
                    <b style={{ color: '#ffd86b' }}>
                      {effectiveCost === 0
                        ? settled
                          ? '免费(已通关)'
                          : '免费'
                        : `${effectiveCost} 原力`}
                    </b>
                    {' · '}
                    完成奖励:{' '}
                    <b style={{ color: '#7aa' }}>
                      {settled ? '无(已结算过)' : `${sc.forceReward.min}–${sc.forceReward.max} 原力`}
                    </b>
                  </p>
                  <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Magic 系统:{' '}
                    {sc.magicTags && sc.magicTags.length > 0 ? (
                      sc.magicTags.map((t) => (
                        <span key={t} className="tag">
                          {magicSystemLabel(t)}
                        </span>
                      ))
                    ) : (
                      <span className="muted">不限</span>
                    )}
                  </p>
                  {suppressedItems.length > 0 && (
                    <p style={{ fontSize: 12, marginTop: 4, color: '#fb7' }}>
                      ⚠ {suppressedItems.length} 件神奇物品在此剧本会被削弱:{' '}
                      {suppressedItems.map((i) => i.name).join('、')}
                    </p>
                  )}
                </div>
                <div
                  style={{
                    flex: 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    alignItems: 'flex-end',
                  }}
                >
                  {isInThis ? (
                    <span className="muted" style={{ fontSize: 12 }}>
                      已在此剧本中
                    </span>
                  ) : (
                    <button
                      className="primary"
                      disabled={!canAfford || blockedByOtherScenario}
                      onClick={() => {
                        // I-series:不在这里 plaza.enterScenario,把决定权交给顶层 EntryModal
                        //   1) 顶层弹模态 → 玩家选 soul/body + 填愿望
                        //   2) 模态提交 → 才真正 plaza.enterScenario + setScenarioEntry
                        //   3) 模态取消 → 啥也不动,原力不扣
                        const startScene = sc.startSceneId ?? sc.scenes?.[0]?.id;
                        onEnterScenario(sc.id, startScene);
                      }}
                      title={blockedByOtherScenario ? '先返回广场再进入新剧本' : ''}
                    >
                      {blockedByOtherScenario
                        ? '已在他处'
                        : canAfford
                          ? '进入'
                          : '原力不足'}
                    </button>
                  )}
                  {/* I-series:导出按钮 — DLC + custom 都可下载,方便分享 / 备份 / 改造 */}
                  <button
                    style={{ fontSize: 11 }}
                    onClick={() => downloadScenarioAsJson(sc)}
                    title={`下载 ${sc.name} 为 .json 文件(可分享给别人导入)`}
                  >
                    ⬇ 导出
                  </button>
                  {/* 重置副本:清该剧本下所有 NPC 关系/记忆/对话摘要 + scenarioProgress。
                      只在广场（!isInThis 已保证）暴露;plaza.resetScenario 内还有一道安全检查。 */}
                  {!isInThis && (
                    <button
                      style={{ fontSize: 11 }}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `重置剧本「${sc.name}」?\n\n` +
                              `这会清空你跟该剧本所有 NPC 的:\n` +
                              `· 信任度 / 关系\n` +
                              `· 长期记忆 / 对话摘要\n` +
                              `· 剧情进度 / 已访场景\n\n` +
                              `不可恢复。`,
                          )
                        )
                          return;
                        const npcIds = (sc.npcs ?? []).map((n) => n.character_id);
                        plaza.resetScenario(sc.id, npcIds);
                        refresh();
                        onForceRefresh();
                      }}
                      title="清空你跟该剧本所有 NPC 的关系、记忆和进度"
                    >
                      🔄 重置
                    </button>
                  )}
                  {!isBuiltinScenario(sc.id) && !isInThis && (
                    <button
                      style={{ fontSize: 11 }}
                      onClick={() => {
                        if (!window.confirm(`删除自定义剧本「${sc.name}」?(localStorage 数据不可恢复)`))
                          return;
                        removeCustomScenario(sc.id);
                        refresh();
                      }}
                      title="删除这个自定义剧本"
                    >
                      🗑 删除
                    </button>
                  )}
                  {!isBuiltinScenario(sc.id) && (
                    <span
                      className="muted"
                      style={{ fontSize: 10, marginTop: 2 }}
                      title="本地自定义剧本(localStorage)"
                    >
                      自定义
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ─── 剧本导入 / AI 生成 ─── */}
      <ScenarioImportPanel onSaved={refresh} />

      {/* ─── Ⓑ:立绘偏好 ─── */}
      <PortraitPrefsPanel prefs={state.portraitPrefs} onSaved={refresh} />

      {/* ─── 调试 ─── */}
      <div className="card" style={{ background: '#1a1d29' }}>
        <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          调试 / 重置工具
        </p>
        <button
          onClick={() => {
            if (
              !window.confirm(
                '重置广场状态到默认?所有原力 / 队友 / 物品 / 当前剧本进度都会清空。',
              )
            )
              return;
            plaza.reset();
            refresh();
            onForceRefresh(); // reset 也清 inScenario,通知顶层
          }}
        >
          重置广场
        </button>
        <button
          style={{ marginLeft: 8 }}
          onClick={() => {
            plaza.addForce(100);
            refresh();
          }}
        >
          +100 原力 (调试)
        </button>
      </div>
    </>
  );
}

// ─── 子组件:档案卡 ─────────────────────────────────────────────

/** 文件上限:15 MB。dataUrl base64 膨胀 ~33%,localStorage 5-10MB 配额会被一张大图打爆,
 *  但 PoC 阶段先用宽松上限,真上线再加压缩。 */
const PROFILE_IMAGE_SIZE_LIMIT = 15 * 1024 * 1024;

function ProfileCard({
  profile,
  editing,
  onSave,
  onEdit,
  onCancel,
}: {
  profile: CharacterProfile;
  editing: boolean;
  onSave: (patch: Partial<CharacterProfile>) => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const [origin, setOrigin] = useState(profile.origin);
  const [description, setDescription] = useState(profile.description);
  const [images, setImages] = useState<CharacterImage[]>(profile.images ?? []);
  const [baseImageIndex, setBaseImageIndex] = useState<number>(profile.baseImageIndex ?? 0);
  const [multiImageEnabled, setMultiImageEnabled] = useState<boolean>(profile.multiImageEnabled ?? false);

  useEffect(() => {
    if (!editing) {
      setOrigin(profile.origin);
      setDescription(profile.description);
      setImages(profile.images ?? []);
      setBaseImageIndex(profile.baseImageIndex ?? 0);
      setMultiImageEnabled(profile.multiImageEnabled ?? false);
    }
  }, [profile, editing]);

  // 当前显示的基准图(viewing 也用这个)
  const baseImg = profileBaseImage({
    ...profile,
    images: editing ? images : profile.images ?? [],
    baseImageIndex: editing ? baseImageIndex : profile.baseImageIndex ?? 0,
  });

  function handleFileImport(file: File) {
    if (file.size > PROFILE_IMAGE_SIZE_LIMIT) {
      window.alert(`图片过大 (限 ${Math.round(PROFILE_IMAGE_SIZE_LIMIT / 1024 / 1024)}MB)`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return;
      const newImg: CharacterImage = {
        dataUrl: result,
        source: 'import',
        addedAt: new Date().toISOString(),
      };
      if (multiImageEnabled) {
        // 多图模式:追加到末尾,新导入的图自动设为基准(用户要求)
        const next = [...images, newImg];
        setImages(next);
        setBaseImageIndex(next.length - 1);
      } else {
        // 单图模式:替换基准位
        if (images.length === 0) {
          setImages([newImg]);
          setBaseImageIndex(0);
        } else {
          const next = [...images];
          const idx = baseImageIndex >= 0 && baseImageIndex < next.length ? baseImageIndex : 0;
          next[idx] = newImg;
          setImages(next);
          setBaseImageIndex(idx);
        }
      }
    };
    reader.readAsDataURL(file);
  }

  function removeImageAt(idx: number) {
    const next = images.filter((_, i) => i !== idx);
    setImages(next);
    if (next.length === 0) setBaseImageIndex(0);
    else if (baseImageIndex >= next.length) setBaseImageIndex(next.length - 1);
    else if (idx < baseImageIndex) setBaseImageIndex(baseImageIndex - 1);
  }

  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
      <div
        className="portrait"
        style={{ overflow: 'hidden', padding: 0, flex: 'none' }}
      >
        {baseImg ? (
          <img
            src={baseImg}
            alt="profile"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div
            style={{
              padding: 12,
              fontSize: 11,
              textAlign: 'center',
              lineHeight: 1.4,
            }}
          >
            (未导入图片)
          </div>
        )}
      </div>
      <div style={{ flex: 1 }}>
        {editing ? (
          <>
            <label className="muted" style={{ fontSize: 12 }}>
              来历
            </label>
            <input
              type="text"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              style={{
                width: '100%',
                padding: 6,
                marginBottom: 8,
                background: '#0f1119',
                color: '#ddd',
                border: '1px solid #2a2d3e',
                borderRadius: 4,
              }}
            />
            <label className="muted" style={{ fontSize: 12 }}>
              描述
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{ width: '100%', minHeight: 60 }}
            />

            {/* 多图开关 */}
            <div className="row" style={{ marginTop: 10, alignItems: 'center', gap: 8 }}>
              <label className="muted" style={{ fontSize: 12, userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={multiImageEnabled}
                  onChange={(e) => {
                    const next = e.target.checked;
                    // M3 修复:多图 → 单图,且当前有 ≥2 张,要求确认并裁剪到只剩基准图
                    if (!next && images.length > 1) {
                      const ok = window.confirm(
                        `关闭多图后只保留当前基准图(${baseImageIndex + 1}/${images.length}),其他 ${images.length - 1} 张会删除。继续?`,
                      );
                      if (!ok) return;
                      const base = images[baseImageIndex] ?? images[0];
                      setImages(base ? [base] : []);
                      setBaseImageIndex(0);
                    }
                    setMultiImageEnabled(next);
                  }}
                  style={{ marginRight: 4 }}
                />
                开启多图档案
              </label>
              <span className="muted" style={{ fontSize: 11 }}>
                ({multiImageEnabled ? '多图:导入会追加并设为基准' : '单图:导入会替换基准'};共 {images.length} 张)
              </span>
            </div>

            <div className="row" style={{ marginTop: 8, alignItems: 'center', gap: 8 }}>
              <label className="muted" style={{ fontSize: 12 }}>
                导入图片:{' '}
                <input
                  key={images.length /* 重置 file input 让同名文件可重新选 */}
                  type="file"
                  accept="image/*"
                  style={{ fontSize: 11 }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    handleFileImport(file);
                  }}
                />
              </label>
              <span className="muted" style={{ fontSize: 11 }}>
                上限 {Math.round(PROFILE_IMAGE_SIZE_LIMIT / 1024 / 1024)}MB
              </span>
            </div>

            {/* 多图模式:缩略图 + 设为基准 / 删除 */}
            {multiImageEnabled && images.length > 0 && (
              <div
                className="row"
                style={{ marginTop: 8, gap: 6, flexWrap: 'wrap' }}
              >
                {images.map((img, idx) => (
                  <div
                    key={idx}
                    style={{
                      position: 'relative',
                      width: 56,
                      height: 56,
                      borderRadius: 4,
                      overflow: 'hidden',
                      border:
                        idx === baseImageIndex
                          ? '2px solid #ffd86b'
                          : '1px solid #2a2d3e',
                      cursor: 'pointer',
                    }}
                    onClick={() => setBaseImageIndex(idx)}
                    title={
                      idx === baseImageIndex
                        ? '当前基准图'
                        : `点击设为基准 (${img.source === 'generated' ? '生成' : '导入'})`
                    }
                  >
                    <img
                      src={img.dataUrl}
                      alt={`img-${idx}`}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                    {idx === baseImageIndex && (
                      <span
                        style={{
                          position: 'absolute',
                          top: 1,
                          left: 1,
                          fontSize: 9,
                          background: '#ffd86bcc',
                          color: '#222',
                          padding: '0 3px',
                          borderRadius: 2,
                          fontWeight: 700,
                          pointerEvents: 'none',
                        }}
                      >
                        基准
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeImageAt(idx);
                      }}
                      title="删除这张"
                      style={{
                        position: 'absolute',
                        top: 1,
                        right: 1,
                        padding: '0 4px',
                        fontSize: 10,
                        lineHeight: '14px',
                        background: '#000a',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 2,
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* 单图模式:只露一个"清除"按钮 */}
            {!multiImageEnabled && images.length > 0 && (
              <div className="row" style={{ marginTop: 8 }}>
                <button
                  onClick={() => {
                    setImages([]);
                    setBaseImageIndex(0);
                  }}
                  style={{ fontSize: 11 }}
                >
                  清除图片
                </button>
              </div>
            )}

            <div className="row" style={{ marginTop: 12 }}>
              <button
                className="primary"
                onClick={() =>
                  onSave({
                    origin,
                    description,
                    images,
                    baseImageIndex,
                    multiImageEnabled,
                  })
                }
              >
                保存
              </button>
              <button onClick={onCancel}>取消</button>
            </div>
          </>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 12 }}>
              <b>来历</b>: {profile.origin}
            </p>
            <p style={{ fontSize: 14, marginTop: 6 }}>{profile.description}</p>
            {/* 查看模式下:多图档案露缩略图条 */}
            {profile.multiImageEnabled && profile.images && profile.images.length > 1 && (
              <div className="row" style={{ marginTop: 8, gap: 4, flexWrap: 'wrap' }}>
                {profile.images.map((img, idx) => (
                  <img
                    key={idx}
                    src={img.dataUrl}
                    alt={`thumb-${idx}`}
                    style={{
                      width: 32,
                      height: 32,
                      objectFit: 'cover',
                      borderRadius: 3,
                      border:
                        idx === (profile.baseImageIndex ?? 0)
                          ? '2px solid #ffd86b'
                          : '1px solid #2a2d3e',
                      opacity: idx === (profile.baseImageIndex ?? 0) ? 1 : 0.7,
                    }}
                    title={
                      `${idx === (profile.baseImageIndex ?? 0) ? '基准 · ' : ''}` +
                      (img.source === 'generated' ? '生成' : '导入')
                    }
                  />
                ))}
              </div>
            )}
            <button onClick={onEdit} style={{ fontSize: 12, marginTop: 8 }}>
              编辑档案
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── 子组件:队友卡 ─────────────────────────────────────────────

function CompanionCard({
  entry,
  editing,
  onToggleActive,
  onUpgrade,
  onRevive,
  onEdit,
  onSaveEdit,
  onCancelEdit,
  onRemove,
}: {
  entry: CompanionEntry;
  editing: boolean;
  onToggleActive: () => void;
  onUpgrade: () => void;
  onRevive: () => void;
  onEdit: () => void;
  onSaveEdit: (patch: Partial<CharacterProfile>) => void;
  onCancelEdit: () => void;
  onRemove: () => void;
}) {
  const cost = companionUpgradeCost(entry);
  const isDead = (entry.hp ?? 'alive') === 'dead';
  const reviveCost = companionReviveCost(entry);
  return (
    <div
      className="card"
      style={{
        background: isDead ? '#1a1014' : '#181a23',
        border: isDead ? '1px solid #5a2222' : undefined,
        marginBottom: 8,
        // 死亡时整张卡片半透明,营造灰冷感
        opacity: isDead ? 0.7 : 1,
      }}
    >
      {isDead && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            padding: '6px 10px',
            background: '#3a1010',
            border: '1px solid #5a2020',
            borderRadius: 4,
            fontSize: 12,
            color: '#f99',
          }}
        >
          <span style={{ fontSize: 16 }}>💀</span>
          <span>
            <b>陨落</b>
            {entry.diedInScenarioId && (
              <span className="muted" style={{ marginLeft: 6 }}>
                · 阵亡于 {getScenario(entry.diedInScenarioId)?.name ?? entry.diedInScenarioId}
              </span>
            )}
          </span>
        </div>
      )}
      <ProfileCard
        profile={entry.profile}
        editing={editing}
        onSave={onSaveEdit}
        onEdit={onEdit}
        onCancel={onCancelEdit}
      />
      <div
        className="row"
        style={{
          marginTop: 8,
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span className="muted" style={{ fontSize: 12 }}>
          Lv {entry.level}
        </span>
        {isDead ? (
          <>
            <span style={{ fontSize: 12, color: '#a55' }}>● 已陨落</span>
            <button
              className="primary"
              onClick={onRevive}
              title={`花 ${reviveCost} 原力复活(50 × 等级)`}
            >
              复活 ({reviveCost} 原力)
            </button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 12, color: entry.active ? '#7aa' : '#888' }}>
              {entry.active ? '● 已激活' : '○ 收起为卡片'}
            </span>
            <button onClick={onToggleActive}>{entry.active ? '收起' : '放出'}</button>
            <button onClick={onUpgrade} title={`升级到 Lv ${entry.level + 1}`}>
              升级 ({cost} 原力)
            </button>
          </>
        )}
        <button onClick={onRemove} style={{ fontSize: 11 }}>
          移除
        </button>
      </div>
    </div>
  );
}

// ─── 子组件:物品卡 ─────────────────────────────────────────────

function ItemCard({
  item,
  onUpgrade,
  onRemove,
}: {
  item: PlazaItem;
  onUpgrade: () => void;
  onRemove: () => void;
}) {
  const cost = itemUpgradeCost(item);
  const isLost = !!item.lost;
  return (
    <div
      className="card"
      style={{
        background: isLost ? '#1a1814' : '#181a23',
        border: isLost ? '1px solid #4a3a22' : undefined,
        marginBottom: 8,
        opacity: isLost ? 0.6 : 1,
      }}
    >
      {isLost && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            padding: '6px 10px',
            background: '#2a2010',
            border: '1px solid #4a3a20',
            borderRadius: 4,
            fontSize: 12,
            color: '#fc8',
          }}
        >
          <span style={{ fontSize: 16 }}>⚰️</span>
          <span>
            <b>已永失</b>
            {item.lostInScenarioId && (
              <span className="muted" style={{ marginLeft: 6 }}>
                · 损毁/掉落于 {getScenario(item.lostInScenarioId)?.name ?? item.lostInScenarioId}
              </span>
            )}
            <span className="muted" style={{ marginLeft: 6 }}>
              · 无法带入新剧本,无法修复
            </span>
          </span>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h4 style={{ marginBottom: 2, textDecoration: isLost ? 'line-through' : undefined }}>
            {item.name}{' '}
            <span className="muted" style={{ fontSize: 11, fontWeight: 'normal' }}>
              Lv {item.level}
            </span>
          </h4>
          <p className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            {item.description}
          </p>
          {item.origin && (
            <p className="muted" style={{ fontSize: 11 }}>
              来历: {item.origin}
            </p>
          )}
          <p style={{ fontSize: 12, marginTop: 6 }}>
            {item.type === 'magic' ? (
              <>
                <span style={{ color: '#caa', marginRight: 6 }}>神奇</span>
                {item.magicTags && item.magicTags.length > 0 ? (
                  item.magicTags.map((t) => (
                    <span key={t} className="tag">
                      {magicSystemLabel(t)}
                    </span>
                  ))
                ) : (
                  <span className="muted">(通用)</span>
                )}
              </>
            ) : (
              <span className="muted">普通物品</span>
            )}
          </p>
        </div>
        <div
          style={{
            flex: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            alignItems: 'flex-end',
          }}
        >
          {!isLost && (
            <button onClick={onUpgrade} title={`升级到 Lv ${item.level + 1}`}>
              升级 ({cost} 原力)
            </button>
          )}
          <button onClick={onRemove} style={{ fontSize: 11 }}>
            {isLost ? '清理' : '丢弃'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 剧本导入 / 导出 helpers ─────────────────────────────────────

/**
 * 一键导出:把剧本对象序列化成 .json 文件直接触发浏览器下载。
 * 支持 DLC 和 custom 剧本 — DLC 也能下载下来给别人改 / 研究。
 */
function downloadScenarioAsJson(s: Scenario) {
  const json = JSON.stringify(s, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${s.id}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 下一帧再 revoke,避免某些浏览器(Safari)还没开始下载就被回收
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** URL fetch 限制 */
const URL_FETCH_TIMEOUT_MS = 10_000;
const URL_FETCH_MAX_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * 从 URL fetch JSON 文本。带超时 + size cap。失败抛 Error,调用方 catch。
 * 注意:跨域 fetch 受目标 server CORS 头限制 — github raw / gist / pastebin 一般允许,
 * 私人服务器可能拒绝(玩家会看到 "Fetch 失败: Failed to fetch")。
 */
async function fetchScenarioJsonFromUrl(rawUrl: string): Promise<string> {
  // URL 格式校验
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('URL 格式无效');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`不支持的协议: ${u.protocol}(只允许 http/https)`);
  }

  // 超时控制
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(rawUrl, { signal: controller.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(`请求超时 (>${URL_FETCH_TIMEOUT_MS / 1000}s)`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }

  // Content-Length 预检(撒谎的 server 会跳过,后面 text size 兜底)
  const cl = resp.headers.get('content-length');
  if (cl && Number(cl) > URL_FETCH_MAX_BYTES) {
    throw new Error(`响应过大 (${(Number(cl) / 1024).toFixed(0)}KB > 5MB 上限)`);
  }

  const text = await resp.text();
  if (text.length > URL_FETCH_MAX_BYTES) {
    throw new Error(`响应过大 (${(text.length / 1024).toFixed(0)}KB > 5MB 上限)`);
  }
  return text;
}

// ─── 子组件:剧本导入 / AI 生成 ────────────────────────────────────

function ScenarioImportPanel({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'paste' | 'ai'>('paste');

  // 粘贴 JSON 模式
  const [jsonText, setJsonText] = useState('');
  const [jsonFileName, setJsonFileName] = useState<string | null>(null);
  // URL fetch 模式
  const [urlText, setUrlText] = useState('');
  const [fetchingUrl, setFetchingUrl] = useState(false);
  // 拖拽状态
  const [dragOver, setDragOver] = useState(false);

  // AI 生成模式
  const [sourceText, setSourceText] = useState('');
  const [hint, setHint] = useState('');
  const [generating, setGenerating] = useState(false);

  // 共享:预览
  const [preview, setPreview] = useState<Scenario | null>(null);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);
  const [previewRaw, setPreviewRaw] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<GenerateResult['meta']>();
  const [savedTip, setSavedTip] = useState<string | null>(null);

  function clearPreview() {
    setPreview(null);
    setPreviewErrors([]);
    setPreviewRaw(null);
    setPreviewMeta(undefined);
    setSavedTip(null);
  }

  function resetAll() {
    setJsonText('');
    setJsonFileName(null);
    setSourceText('');
    setHint('');
    setUrlText('');
    clearPreview();
  }

  function previewJson() {
    clearPreview();
    const r = parseScenarioJson(jsonText);
    if (r.ok) setPreview(r.scenario);
    else setPreviewErrors(r.errors);
  }

  /** 从 URL fetch 并自动 parse + 预览(失败时显示错误,文本仍写进 jsonText 供检查)。 */
  async function previewFromUrl() {
    if (!urlText.trim()) {
      setPreviewErrors(['请输入 URL']);
      return;
    }
    clearPreview();
    setFetchingUrl(true);
    try {
      const text = await fetchScenarioJsonFromUrl(urlText.trim());
      setJsonText(text);
      setJsonFileName(urlText.trim());
      const r = parseScenarioJson(text);
      if (r.ok) setPreview(r.scenario);
      else setPreviewErrors(r.errors);
    } catch (e) {
      setPreviewErrors([`URL fetch 失败: ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setFetchingUrl(false);
    }
  }

  /** 抽出文件读取逻辑供 input + dropzone 共用。 */
  function loadJsonFile(file: File) {
    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      setPreviewErrors([`不是 JSON 文件 (${file.type || '类型未知'})`]);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setPreviewErrors([`文件过大 (限 5MB,实际 ${(file.size / 1024).toFixed(0)}KB)`]);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        clearPreview();
        setMode('paste'); // 拖拽过来自动切到 paste 模式
        setJsonText(reader.result);
        setJsonFileName(file.name);
        const r = parseScenarioJson(reader.result);
        if (r.ok) setPreview(r.scenario);
        else setPreviewErrors(r.errors);
      }
    };
    reader.readAsText(file);
  }

  async function previewAI() {
    if (!sourceText.trim()) {
      setPreviewErrors(['请输入源材料文本']);
      return;
    }
    clearPreview();
    setGenerating(true);
    try {
      const r = await generateScenarioFromText(sourceText, { hint: hint || undefined });
      setPreviewMeta(r.meta);
      if (r.ok && r.scenario) setPreview(r.scenario);
      else {
        setPreviewErrors(r.errors ?? ['未知错误']);
        if (r.rawText) setPreviewRaw(r.rawText);
      }
    } finally {
      setGenerating(false);
    }
  }

  function save(overwrite: boolean) {
    if (!preview) return;
    const r = addCustomScenario(preview, { overwrite });
    if (!r.ok) {
      setPreviewErrors(r.errors);
      return;
    }
    setSavedTip(`✓ 已保存剧本「${r.scenario.name}」`);
    onSaved();
    // 不立刻关面板,让用户看到提示;3 秒后自动收起
    window.setTimeout(() => {
      resetAll();
      setOpen(false);
    }, 1800);
  }

  if (!open) {
    return (
      <div
        className="card row"
        style={{ alignItems: 'center', background: '#1a1d29', gap: 12 }}
      >
        <button onClick={() => setOpen(true)}>📂 添加剧本</button>
        <span className="muted" style={{ fontSize: 12 }}>
          导入 JSON 或让 AI 从小说 / 影视剧 / 历史故事 生成新剧本
        </span>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>📂 添加剧本</h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            className={mode === 'paste' ? 'primary' : ''}
            style={{ fontSize: 12 }}
            onClick={() => {
              setMode('paste');
              clearPreview();
            }}
          >
            粘贴 / 上传 JSON
          </button>
          <button
            className={mode === 'ai' ? 'primary' : ''}
            style={{ fontSize: 12 }}
            onClick={() => {
              setMode('ai');
              clearPreview();
            }}
          >
            ✨ AI 从素材生成
          </button>
          <button
            style={{ fontSize: 12 }}
            onClick={() => {
              resetAll();
              setOpen(false);
            }}
          >
            收起
          </button>
        </div>
      </div>

      {/* ── 粘贴 / 上传 JSON / URL fetch / 拖拽 ── */}
      {mode === 'paste' && (
        <>
          <p className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            3 种导入方式:① 粘贴 JSON 文本 ② 上传 .json 文件(或直接拖到下方框) ③ 贴 URL 自动 fetch。
            <br />
            所有数据都走 Scenario schema 校验 + 兜底补全。
          </p>

          {/* URL 行 */}
          <div
            className="row"
            style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}
          >
            <input
              type="url"
              placeholder="或贴 raw JSON URL (https://raw.githubusercontent.com/...)"
              value={urlText}
              onChange={(e) => setUrlText(e.target.value)}
              style={{ flex: 1, fontSize: 12 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !fetchingUrl) {
                  e.preventDefault();
                  void previewFromUrl();
                }
              }}
            />
            <button
              onClick={() => void previewFromUrl()}
              disabled={!urlText.trim() || fetchingUrl}
              style={{ fontSize: 12 }}
              title="GET 这个 URL,响应内容直接当 JSON 解析(超时 10s / 大小 ≤ 5MB)"
            >
              {fetchingUrl ? '拉取中...' : '🌐 从 URL 拉取'}
            </button>
          </div>

          {/* Textarea + dropzone */}
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder='{ "id": "...", "name": "...", "npcs": [...] ... }（也可以把 .json 文件拖到这里）'
            style={{
              width: '100%',
              minHeight: 140,
              fontFamily: 'monospace',
              fontSize: 12,
              border: dragOver ? '2px dashed #ffd86b' : undefined,
              background: dragOver ? '#1c1a14' : undefined,
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const file = e.dataTransfer?.files?.[0];
              if (file) loadJsonFile(file);
            }}
          />
          <div className="row" style={{ alignItems: 'center', marginTop: 6, gap: 8 }}>
            <label className="muted" style={{ fontSize: 12 }}>
              或选 .json 文件:{' '}
              <input
                key={jsonFileName ?? 'empty'}
                type="file"
                accept="application/json,.json"
                style={{ fontSize: 11 }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) loadJsonFile(file);
                }}
              />
            </label>
            {jsonFileName && (
              <span className="muted" style={{ fontSize: 11 }}>
                已读取: {jsonFileName.length > 40 ? jsonFileName.slice(0, 37) + '…' : jsonFileName}
              </span>
            )}
            <button
              style={{ marginLeft: 'auto' }}
              onClick={previewJson}
              disabled={!jsonText.trim()}
            >
              解析 + 预览
            </button>
          </div>
        </>
      )}

      {/* ── AI 生成 ── */}
      {mode === 'ai' && (
        <>
          <p className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            贴一段小说 / 影视剧 / 历史 / 民间故事素材(1-3 千字最佳),让 AI 分析关键人物 + 冲突,
            生成可玩剧本骨架。走 <code>utility.structured</code> lane → 当前路由(默认 codex_spark)。
          </p>
          <textarea
            value={sourceText}
            onChange={(e) => setSourceText(e.target.value)}
            placeholder="例如:《三体》前半段红岸基地、《活着》前 30 页、《了不起的盖茨比》开篇、聊斋《聂小倩》全篇..."
            style={{ width: '100%', minHeight: 140, fontSize: 13 }}
          />
          <label className="muted" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
            (可选)偏好提示:
          </label>
          <input
            type="text"
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="例如:着重压抑感、选叶文洁/老白/史强三人、玩家扮演新警员"
            style={{
              width: '100%',
              padding: 6,
              background: '#0f1119',
              color: '#ddd',
              border: '1px solid #2a2d3e',
              borderRadius: 4,
              fontSize: 13,
            }}
          />
          <div className="row" style={{ marginTop: 8, alignItems: 'center', gap: 8 }}>
            <span className="muted" style={{ fontSize: 11 }}>
              {sourceText.trim().length} 字
            </span>
            <button
              style={{ marginLeft: 'auto' }}
              className="primary"
              disabled={generating || !sourceText.trim()}
              onClick={previewAI}
            >
              {generating ? '生成中…(可能 30-90 秒)' : '✨ AI 分析并生成'}
            </button>
          </div>
          {previewMeta && (
            <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              lane: {previewMeta.laneUsed ?? '?'}
              {previewMeta.fallbackPath && previewMeta.fallbackPath.length > 1
                ? ` (fallback: ${previewMeta.fallbackPath.join(' → ')})`
                : ''}
              {previewMeta.durationSec != null ? ` · ${previewMeta.durationSec.toFixed(1)}s` : ''}
            </p>
          )}
        </>
      )}

      {/* ── 错误展示 ── */}
      {previewErrors.length > 0 && (
        <div
          className="card"
          style={{
            background: '#2a1414',
            borderColor: '#a44',
            marginTop: 12,
          }}
        >
          <p style={{ color: '#f88', fontSize: 13, marginBottom: 6 }}>解析失败:</p>
          <ul style={{ fontSize: 12, paddingLeft: 18, margin: 0 }}>
            {previewErrors.map((e, i) => (
              <li key={i} style={{ color: '#fbb' }}>
                {e}
              </li>
            ))}
          </ul>
          {previewRaw && (
            <details style={{ marginTop: 8 }}>
              <summary className="muted" style={{ fontSize: 11, cursor: 'pointer' }}>
                查看原始 LLM 响应(可复制后手动修改再粘贴导入)
              </summary>
              <pre
                style={{
                  marginTop: 6,
                  padding: 8,
                  background: '#0f1119',
                  fontSize: 11,
                  maxHeight: 240,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {previewRaw}
              </pre>
              <button
                style={{ fontSize: 11, marginTop: 4 }}
                onClick={() => {
                  setMode('paste');
                  setJsonText(previewRaw);
                  clearPreview();
                }}
              >
                ← 切到"粘贴 JSON"模式手动修
              </button>
            </details>
          )}
        </div>
      )}

      {/* ── 预览 + 保存 ── */}
      {preview && (
        <div
          className="card"
          style={{ background: '#16223a', borderColor: '#2a5', marginTop: 12 }}
        >
          <h4 style={{ marginBottom: 6, color: '#9cf' }}>预览:可保存</h4>
          <p style={{ fontSize: 15 }}>
            <b>{preview.name}</b>{' '}
            <span className="muted" style={{ fontSize: 12 }}>
              ({preview.shortName})
            </span>{' '}
            <code className="muted" style={{ fontSize: 11 }}>
              id={preview.id}
            </code>
          </p>
          <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            {preview.description}
          </p>
          <p className="muted" style={{ fontSize: 12, marginTop: 4, fontStyle: 'italic' }}>
            🛰 {preview.openingNarration}
          </p>
          <p style={{ fontSize: 12, marginTop: 6 }}>
            入场:{' '}
            <b style={{ color: '#ffd86b' }}>
              {preview.entryCost === 0 ? '免费' : `${preview.entryCost} 原力`}
            </b>
            {' · '}
            奖励:{' '}
            <b style={{ color: '#7aa' }}>
              {preview.forceReward.min}–{preview.forceReward.max}
            </b>
            {preview.magicTags && preview.magicTags.length > 0 && (
              <>
                {' · '}
                magic:{' '}
                {preview.magicTags.map((t) => (
                  <span key={t} className="tag">
                    {magicSystemLabel(t)}
                  </span>
                ))}
              </>
            )}
          </p>
          <p style={{ fontSize: 12, marginTop: 6 }}>
            <b>NPC ({preview.npcs.length})</b>:
          </p>
          <ul style={{ fontSize: 12, paddingLeft: 18, margin: 0 }}>
            {preview.npcs.map((n) => (
              <li key={n.character_id} style={{ marginBottom: 3 }}>
                <b>{n.identity.name}</b>
                {n.character_id === preview.defaultNpcId && (
                  <span className="tag" style={{ marginLeft: 6 }}>
                    默认对话
                  </span>
                )}
                {n.core_persona.traits.length > 0 && (
                  <span className="muted">
                    {' · '}
                    {n.core_persona.traits.slice(0, 4).join(' / ')}
                  </span>
                )}
                <div className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
                  {n.core_persona.summary.slice(0, 80)}
                  {n.core_persona.summary.length > 80 ? '…' : ''}
                </div>
              </li>
            ))}
          </ul>

          {savedTip ? (
            <p style={{ color: '#7cf', marginTop: 10 }}>{savedTip}</p>
          ) : (
            <div className="row" style={{ marginTop: 12, gap: 8 }}>
              <button className="primary" onClick={() => save(false)}>
                保存到我的剧本库
              </button>
              <button onClick={() => save(true)} style={{ fontSize: 12 }}>
                保存(覆盖同 id)
              </button>
              <button onClick={clearPreview} style={{ fontSize: 12, marginLeft: 'auto' }}>
                清除预览
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── B4:剧情进度横幅 + 展开式 drawer ─────────────────────────────

function SceneProgressBanner({
  scenarioId,
  revision,
  messageCount,
  returningToPlaza,
  setReturningToPlaza,
  onReturnToPlaza,
}: {
  scenarioId: string;
  revision: number;
  messageCount: number;
  returningToPlaza: boolean;
  setReturningToPlaza: (v: boolean) => void;
  onReturnToPlaza: () => void;
}) {
  const [showDrawer, setShowDrawer] = useState(false);
  const [, forceTick] = useState(0);
  // 父组件 revision / messageCount 变化时重新读 plaza progress(advance / send 后会变)
  useEffect(() => {
    forceTick((t) => t + 1);
  }, [revision, messageCount]);

  const sc = getScenario(scenarioId);
  const progress = plaza.getScenarioProgress(scenarioId);
  const hasSkeleton = !!sc?.scenes && sc.scenes.length > 0;
  // 动态剧本:有 locations 列表 + scenes 空
  const isDynamic = !hasSkeleton && !!sc?.locations && sc.locations.length > 0;
  const allCheckpoints = sc ? listAllCheckpoints(sc) : [];
  const completedSet = new Set(progress?.completedBeatIds ?? []);
  const completedCount = allCheckpoints.filter((b) => completedSet.has(b.id)).length;
  const currentScene = hasSkeleton && progress?.currentSceneId && sc
    ? sc.scenes!.find((s) => s.id === progress.currentSceneId)
    : undefined;
  // 动态剧本:当前 location
  const currentLocId = plaza.get().currentLocation;
  // DYN-T13:动态 location 优先查 spawned(预设 getLocation 查不到 spawn id)
  const currentLoc =
    isDynamic && sc && currentLocId
      ? plaza.getSpawnedLocation(scenarioId, currentLocId) ?? getLocation(sc, currentLocId)
      : undefined;
  // 动态剧本:milestone 进度(complete beat ids 数 / targetMilestones)
  const milestonesDone = progress?.completedBeatIds.length ?? 0;
  const milestonesTarget = sc?.targetMilestones ?? 0;
  const completion = sc ? computeCompletion(sc, progress?.completedBeatIds ?? []) : 0;
  const completionPct = Math.round(completion * 100);
  // 详情按钮:scenes 模式 / 动态模式都可展开;无骨架剧本无须按钮
  const canExpandDetails = hasSkeleton || isDynamic;

  return (
    <div
      className="card"
      style={{
        background: '#1c1a14',
        borderColor: '#5a4a1c',
        padding: 12,
      }}
    >
      <div className="row" style={{ alignItems: 'center' }}>
        <div style={{ flex: 1, fontSize: 13 }}>
          🛰 剧本「<b>{sc?.name ?? scenarioId}</b>」
          {currentScene && (
            <>
              {' · '}
              <span style={{ color: '#9cf' }}>Scene: {currentScene.name}</span>
            </>
          )}
          {currentLoc && (
            <>
              {' · '}
              <span style={{ color: '#9cf' }}>📍 {currentLoc.name}</span>
            </>
          )}
          {hasSkeleton && (
            <>
              {' · '}
              <span style={{ color: '#7aa', fontFamily: 'monospace' }}>
                {completedCount}/{allCheckpoints.length} ✓
              </span>
            </>
          )}
          {isDynamic && milestonesTarget > 0 && (
            <>
              {' · '}
              <span style={{ color: '#7aa', fontFamily: 'monospace' }}>
                {milestonesDone}/{milestonesTarget} 里程碑
              </span>
            </>
          )}
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            {hasSkeleton
              ? `完成度 ${completionPct}%,返广场按比例发原力`
              : isDynamic && milestonesTarget > 0
                ? `完成度 ${completionPct}% (达成 ${milestonesDone} 个里程碑),返广场按比例发原力`
                : '返广场按完成度估算奖励'}
          </div>
        </div>
        {canExpandDetails && (
          <button
            style={{ fontSize: 11, marginRight: 8 }}
            onClick={() => setShowDrawer((v) => !v)}
            title="展开/收起剧情进度详情"
          >
            {showDrawer ? '收起进度 ▲' : '进度详情 ▼'}
          </button>
        )}
        <button
          disabled={returningToPlaza}
          onClick={async () => {
            if (!sc) {
              plaza.exitScenario(0);
              onReturnToPlaza();
              return;
            }
            if (
              !window.confirm(
                `从「${sc.name}」返回广场?当前完成度 ${completionPct}%。\n(返回时会自动整理所有 NPC 的关键瞬间到 NPC 记忆库)`,
              )
            )
              return;
            setReturningToPlaza(true);
            const reward = computeForceReward(sc, completion);
            const consolidation = await consolidateAllChattedNpcs(scenarioId);
            const exitResult = plaza.exitScenario(reward);
            setReturningToPlaza(false);
            // 用 exitResult.rewardGranted 显示实际发放 — 已 settled 的剧本 reward 强制 0
            const rewardLine = exitResult.settledThisExit
              ? `✅ 首次结算!获得原力 +${exitResult.rewardGranted}(此剧本以后再访免费,但不再有原力收益)`
              : exitResult.rewardGranted > 0
                ? `获得原力 +${exitResult.rewardGranted}`
                : reward > 0
                  ? `已结算过此剧本 · 本次无原力收益(可继续陪 NPC / 探索)`
                  : `中途返回 · 本次无原力收益`;
            window.alert(
              `返回广场。完成度 ${completionPct}%。\n${rewardLine}\n\n${formatConsolidationSummary(consolidation)}`,
            );
            onReturnToPlaza();
          }}
        >
          {returningToPlaza ? '整理记忆…' : '← 返回广场'}
        </button>
      </div>

      {/* 进度条:横向条(scenes 模式 + 动态模式都显示) */}
      {(hasSkeleton || (isDynamic && milestonesTarget > 0)) && (
        <div
          style={{
            marginTop: 10,
            height: 6,
            borderRadius: 3,
            background: '#0a0a14',
            overflow: 'hidden',
          }}
          title={
            hasSkeleton
              ? `${completedCount}/${allCheckpoints.length} checkpoints`
              : `${milestonesDone}/${milestonesTarget} milestones`
          }
        >
          <div
            style={{
              width: `${completionPct}%`,
              height: '100%',
              background: 'linear-gradient(90deg, #ffd86b, #7aa)',
              transition: 'width 300ms',
            }}
          />
        </div>
      )}

      {/* 详情 drawer:scene 列表 + 每个 beat */}
      {hasSkeleton && showDrawer && sc?.scenes && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            background: '#0f1119',
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          {sc.scenes.map((s, sIdx) => {
            const isCurrent = s.id === progress?.currentSceneId;
            const isVisited = progress?.visitedSceneIds.includes(s.id);
            const sceneCheckpoints = s.beats.filter((b) => b.type === 'checkpoint');
            const sceneDone = sceneCheckpoints.filter((b) => completedSet.has(b.id)).length;
            const sceneStatus = isCurrent
              ? '▶ 当前'
              : sceneDone === sceneCheckpoints.length && sceneCheckpoints.length > 0
                ? '✓ 完成'
                : isVisited
                  ? '· 已访问'
                  : '· 未到';
            return (
              <div
                key={s.id}
                style={{
                  marginBottom: 12,
                  paddingLeft: 8,
                  borderLeft: isCurrent ? '3px solid #ffd86b' : '3px solid #2a2d3e',
                }}
              >
                <div style={{ fontWeight: 700, color: isCurrent ? '#ffd86b' : '#bbb' }}>
                  {sIdx + 1}. {s.name}
                  <span className="muted" style={{ marginLeft: 8, fontSize: 11, fontWeight: 'normal' }}>
                    {sceneStatus} · {sceneDone}/{sceneCheckpoints.length} ✓
                  </span>
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, marginTop: 4 }}>
                  {s.beats.map((b) => {
                    const done = completedSet.has(b.id);
                    const isCheckpoint = b.type === 'checkpoint';
                    return (
                      <li
                        key={b.id}
                        style={{
                          marginBottom: 2,
                          color: done ? '#7cf' : isCurrent ? '#ccc' : '#777',
                          textDecoration: done ? 'line-through' : 'none',
                          opacity: !isCurrent && !done ? 0.6 : 1,
                        }}
                      >
                        {done ? '✓ ' : isCheckpoint ? '○ ' : '· '}
                        <span style={{ fontStyle: isCheckpoint ? 'normal' : 'italic' }}>
                          {b.summary}
                        </span>
                        {!isCheckpoint && (
                          <span className="muted" style={{ marginLeft: 4, fontSize: 10 }}>
                            (支线)
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          <div className="muted" style={{ fontSize: 10, marginTop: 6, fontStyle: 'italic' }}>
            💡 想推进?跟 NPC 聊符合触发条件的话 → 点上方"Director 推进"按钮(advance)
          </div>
        </div>
      )}

      {/* 动态剧本详情 drawer:地点列表 + 已达成里程碑 */}
      {isDynamic && showDrawer && sc?.locations && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            background: '#0f1119',
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 700, color: '#ffd86b', marginBottom: 8 }}>📍 世界地图</div>
          <ul style={{ margin: 0, paddingLeft: 18, marginBottom: 12 }}>
            {(() => {
              // 合并:预设 locations + 运行时 spawn 的 dynamic locations
              // (DYN-T12:之前只渲染 sc.locations,spawn 物化后玩家在面板里看不到新地点)
              const spawned = plaza.listSpawnedLocations(scenarioId);
              const allLocations = [
                ...sc.locations!.map((l) => ({
                  id: l.id,
                  name: l.name,
                  description: l.description,
                  isDynamic: false,
                })),
                ...spawned.map((d) => ({
                  id: d.id,
                  name: d.name,
                  description: d.description,
                  isDynamic: true,
                })),
              ];
              return allLocations.map((l) => {
                const isHere = l.id === currentLocId;
                return (
                  <li
                    key={l.id}
                    style={{
                      marginBottom: 4,
                      color: isHere ? '#ffd86b' : l.isDynamic ? '#9cf' : '#aaa',
                      fontWeight: isHere ? 700 : 400,
                    }}
                  >
                    {isHere ? '▶ ' : l.isDynamic ? '✦ ' : '· '}
                    {l.name}
                    {l.isDynamic && (
                      <span className="muted" style={{ marginLeft: 4, fontSize: 10 }}>
                        (对话生成)
                      </span>
                    )}
                    {l.description && (
                      <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
                        — {l.description.slice(0, 50)}
                        {l.description.length > 50 ? '…' : ''}
                      </span>
                    )}
                  </li>
                );
              });
            })()}
          </ul>

          <div style={{ fontWeight: 700, color: '#7cf', marginBottom: 6 }}>
            🏆 已达成里程碑({milestonesDone}
            {milestonesTarget > 0 ? `/${milestonesTarget}` : ''})
          </div>
          {progress?.completedBeatIds && progress.completedBeatIds.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {progress.completedBeatIds.map((mid) => (
                <li key={mid} style={{ marginBottom: 2, color: '#7cf', fontFamily: 'monospace' }}>
                  ✓ {mid}
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted" style={{ fontStyle: 'italic' }}>
              (还没达成任何里程碑。跟 NPC 互动、推进剧情让 Director 标记重大事件)
            </div>
          )}

          <div className="muted" style={{ fontSize: 10, marginTop: 8, fontStyle: 'italic' }}>
            💡 这是个开放世界剧本。地点切换由 Director 在叙事中决定;你可以随时点"← 返回广场"结算当前进度。
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Ⓑ:立绘偏好面板
 * - 多情绪立绘 3 档(全开 / 询问 / 全关)
 * - 场景插画总开关
 * - 已被 per-character override 的角色列表 + 重置按钮
 *
 * 改动会通过 plaza.setPortraitPrefs 立刻写入 localStorage,
 * 调用方传入的 onSaved 触发 PlazaTab 重读。
 */
function PortraitPrefsPanel({
  prefs,
  onSaved,
}: {
  prefs: PortraitPrefs;
  onSaved: () => void;
}) {
  const overrides = Object.entries(prefs.perCharacter);
  return (
    <div className="card" style={{ background: '#1a1c1c' }}>
      <h3 style={{ marginBottom: 8 }}>🎭 立绘偏好</h3>
      <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        多情绪立绘 = 对话时按 NPC 情绪自动切换的多张表情立绘(开心 / 严肃 / 难过 等)。
        本机 SDXL 生图,每个角色首次启用要排队生 4 张额外图(约 30 秒)。
      </p>

      {/* 全局模式 */}
      <div style={{ marginBottom: 16 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          默认模式(对所有新角色):
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['on', 'ask', 'off'] as const).map((m) => {
            const label =
              m === 'on'
                ? '✅ 全部开启'
                : m === 'ask'
                  ? '❓ 每个角色单独询问'
                  : '⛔ 全部关闭';
            const desc =
              m === 'on'
                ? '切到任何 NPC 都自动生 5 张情绪图;对话时按情绪切换'
                : m === 'ask'
                  ? '默认只生 1 张 neutral;每个 NPC 第一次出现时弹按钮让你决定'
                  : '只保留单张立绘,不做情绪检测';
            return (
              <button
                key={m}
                className={prefs.emotionMode === m ? 'primary' : ''}
                onClick={() => {
                  plaza.setPortraitPrefs({ emotionMode: m });
                  onSaved();
                }}
                title={desc}
                style={{ fontSize: 12 }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 场景插画 */}
      <div style={{ marginBottom: 16 }}>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
        >
          <input
            type="checkbox"
            checked={prefs.sceneImagesEnabled}
            onChange={(e) => {
              plaza.setPortraitPrefs({ sceneImagesEnabled: e.target.checked });
              onSaved();
            }}
          />
          🎬 场景插画 banner(每个 scene 进入时按 imagePrompt 生一张氛围底图)
        </label>
      </div>

      {/* per-character overrides */}
      {overrides.length > 0 && (
        <div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            单独覆盖({overrides.length} 个角色):
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {overrides.map(([charId, policy]) => (
              <div
                key={charId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 8px',
                  background: '#0f1119',
                  borderRadius: 4,
                  fontSize: 12,
                }}
              >
                <span style={{ fontFamily: 'monospace', flex: 1 }}>{charId}</span>
                <span
                  style={{
                    fontSize: 11,
                    color: policy === 'on' ? '#7cf' : '#fb7',
                  }}
                >
                  {policy === 'on' ? '✅ 开启' : '⛔ 关闭'}
                </span>
                <button
                  style={{ fontSize: 10, padding: '2px 6px' }}
                  onClick={() => {
                    plaza.setCharacterEmotionPolicy(charId, 'reset');
                    onSaved();
                  }}
                  title="重置为默认模式"
                >
                  重置
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── I-series:M4 LLM 生成"身体进入"的穿越背景 ────────────────────

/**
 * 身体进入模式专用 — 调一次 utility.summary 让 LLM 写一段 2-3 句的"穿越背景"。
 * 内容应该包括:出现方式、身上的异界残余、对本世界的第一印象。
 * 失败返 null(调用方静默跳过,不阻塞进副本)。
 */
async function generateBodyEntryContext(
  scenario: Scenario,
  userProfile: UserProfile,
  wishes: string[],
): Promise<string | null> {
  const genderStr =
    userProfile.gender === 'male'
      ? '男'
      : userProfile.gender === 'female'
        ? '女'
        : userProfile.gender === 'other'
          ? '不限性别'
          : '性别未明';
  const ageStr = userProfile.age > 0 ? `约 ${userProfile.age} 岁` : '年龄未明';
  const nickStr = userProfile.nickname?.trim() || '旅人';
  const wishesStr =
    wishes.length > 0
      ? `\n他/她隐隐怀着的牵挂(可以让背景在细微处映射):\n${wishes.map((w) => `- ${w}`).join('\n')}`
      : '';

  const systemPrompt = `你是世界的旁白。一个来自异世界的访客刚到本剧本 — 写一段 2-3 句的"穿越背景"。

# 访客
${nickStr}(${genderStr},${ageStr})

# 他/她正在闯入的世界
${scenario.name} — ${scenario.description}
${wishesStr}

# 你要写的"穿越背景"
2-3 句中文,内容必须包括:
1. 他/她出现在本世界的具体方式(从哪个空间裂缝 / 一场怪梦 / 某个废墟 醒来,要符合本世界的世界观风格)
2. 身上带着的"非本世界"残余(一件物品 / 一段记忆 / 一种本世界不存在的习惯)
3. 对本世界的第一印象(空气 / 光线 / 声音 / 别人的口音 哪里让他/她觉得"不太对")

# 约束
- 不要写"穿越者"、"异世界"、"愿望"等元词
- 不要解释,不要列表,写成自然的散文段落
- 中文,克制,不超过 100 字`;

  try {
    const resp = await callLLM({
      systemPrompt,
      messages: [{ role: 'user', content: '请生成。' }],
      task: 'utility.summary',
      maxTokens: 400,
    });
    const text = resp.text.trim();
    return text || null;
  } catch (e) {
    console.warn('[bodyEntryContext] LLM 生成失败:', e);
    return null;
  }
}

// ─── I-series:首次进入应用的 Onboarding 模态 ─────────────────────

/**
 * 强制弹的"建档"模态 — userProfile.filled=false 时显示。
 * 提交后通过 plaza.setUserProfile 持久化,filled 自动设为 true,模态消失。
 */
function OnboardingModal({
  onSubmit,
}: {
  onSubmit: (patch: { gender: Gender; age: number; nickname?: string }) => void;
}) {
  const [gender, setGender] = useState<Gender>('unspecified');
  const [age, setAge] = useState<number>(25);
  const [nickname, setNickname] = useState('');
  const valid = gender !== 'unspecified' && age >= 1 && age <= 199;

  return (
    <div style={MODAL_OVERLAY_STYLE} role="dialog" aria-modal="true">
      <div style={MODAL_CARD_STYLE}>
        <h2 style={{ marginTop: 0, marginBottom: 8 }}>欢迎来到 World Crossing</h2>
        <p className="muted" style={{ marginTop: 0, marginBottom: 20, fontSize: 13 }}>
          进入剧本前,跟世界报个备 — 你是谁。
          <br />
          这些信息会跟你一起穿越各个剧本(可以随时在设置改)。
        </p>

        {/* 性别 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 6, fontSize: 13 }}>性别</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(
              [
                ['male', '♂ 男'],
                ['female', '♀ 女'],
                ['other', '其他 / 不愿透露'],
              ] as [Gender, string][]
            ).map(([g, label]) => (
              <button
                key={g}
                className={gender === g ? 'primary' : ''}
                onClick={() => setGender(g)}
                style={{ fontSize: 13 }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 年龄 */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>
            年龄
          </label>
          <input
            type="number"
            min={1}
            max={199}
            value={age}
            onChange={(e) => {
              const n = Number(e.target.value);
              setAge(Number.isFinite(n) ? n : 0);
            }}
            style={{ width: 120 }}
          />
          <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
            岁
          </span>
        </div>

        {/* 昵称(选填) */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', marginBottom: 6, fontSize: 13 }}>
            昵称 <span className="muted">(选填 — 留空时 NPC 会叫你"旅人")</span>
          </label>
          <input
            type="text"
            maxLength={30}
            placeholder="想让 NPC 怎么称呼你?"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="primary"
            disabled={!valid}
            onClick={() => {
              onSubmit({
                gender,
                age: Math.max(1, Math.min(199, Math.floor(age))),
                nickname: nickname.trim() || undefined,
              });
            }}
          >
            开始旅程 →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── I-series:进副本的 EntryModal(soul/body + 愿望)──────────────

const DIFFICULTY_LABEL: Record<ScenarioDifficulty, string> = {
  easy: '轻松',
  normal: '常规',
  hard: '硬核',
};
const DIFFICULTY_COLOR: Record<ScenarioDifficulty, string> = {
  easy: '#7cf',
  normal: '#fc7',
  hard: '#f77',
};

/**
 * 进副本前的"入境模态":
 *   1. 选 'soul' 灵魂化身 / 'body' 异世界访客
 *   2. 填 0-3 个愿望(自由文本)
 *   3. 提交时摇骰子(每个愿望按 difficulty 决定是否被命运批准)
 *   4. 显示 2 秒"命运批准了 N / M 个愿望"反馈 → 调 onSubmit(顶层接管 enterScenario + M4 LLM 调用)
 */
function EntryModal({
  scenarioId,
  startSceneId,
  userProfile,
  onSubmit,
  onCancel,
}: {
  scenarioId: string;
  startSceneId?: string;
  userProfile: UserProfile;
  onSubmit: (entry: {
    entryMode: EntryMode;
    wishes: string[];
    wishesGranted: number[];
    loadout: { companionIds: string[]; itemIds: string[] };
  }) => void | Promise<void>;
  onCancel: () => void;
}) {
  // 标记一下避免 eslint unused-vars(startSceneId 由顶层用,这里只占位透传给提交器即可)
  void startSceneId;

  const scenario = useMemo(() => getScenario(scenarioId), [scenarioId]);
  const soulAvailable = !!scenario?.playerSoulIdentity;
  const difficulty: ScenarioDifficulty = scenario?.difficulty ?? 'normal';
  const grantRate = wishGrantRate(difficulty);

  // 默认 soul 模式(若 scenario 有预设),否则 body
  const [mode, setMode] = useState<EntryMode>(soulAvailable ? 'soul' : 'body');
  // 3 个愿望槽,空字符串视为未填
  const [wishesArr, setWishesArr] = useState<[string, string, string]>(['', '', '']);
  // 摇骰子后过渡:'form' → 'rolling' → 'result' → 调 onSubmit
  const [step, setStep] = useState<'form' | 'rolling' | 'result'>('form');
  const [grantedCount, setGrantedCount] = useState<number>(0);
  const [totalWishes, setTotalWishes] = useState<number>(0);

  // ─── Loadout(携带队友 / 物品)──────────────────────────────────
  // Modal 打开时取一次 snapshot:只列「活着的队友」「未丢失的物品」
  const availableCompanions = useMemo(
    () => plaza.get().companions.filter((c) => (c.hp ?? 'alive') === 'alive'),
    [],
  );
  const availableItems = useMemo(
    () => plaza.get().inventory.filter((i) => !i.lost),
    [],
  );
  // UX-1:队友默认 *不* 带 —— 让玩家主动决定(避免老玩家进新剧本时被旧角色挂在身上)。
  // 物品保持默认全选(物品没"插嘴感",带着不打扰)。
  const [carriedCompanionIds, setCarriedCompanionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [carriedItemIds, setCarriedItemIds] = useState<Set<string>>(
    () => new Set(availableItems.map((i) => i.id)),
  );
  // UX-1:有可携带队友时默认展开队友面板(让玩家看到这个选项存在 + 一眼知道默认 0 个)。
  const [showCompanionPanel, setShowCompanionPanel] = useState(availableCompanions.length > 0);
  const [showItemPanel, setShowItemPanel] = useState(false);

  function toggleCompanion(id: string) {
    const next = new Set(carriedCompanionIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCarriedCompanionIds(next);
  }
  function toggleItem(id: string) {
    const next = new Set(carriedItemIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCarriedItemIds(next);
  }
  function selectAllCompanions() {
    setCarriedCompanionIds(new Set(availableCompanions.map((c) => c.characterId)));
  }
  function clearAllCompanions() {
    setCarriedCompanionIds(new Set());
  }
  function selectAllItems() {
    setCarriedItemIds(new Set(availableItems.map((i) => i.id)));
  }
  function clearAllItems() {
    setCarriedItemIds(new Set());
  }

  const filledWishes = wishesArr.map((w) => w.trim()).filter(Boolean);

  function handleSubmit() {
    if (step !== 'form') return;
    const wishes = filledWishes.slice(0, 3);
    const wishesGranted = rollWishes(wishes, difficulty);
    setTotalWishes(wishes.length);
    setGrantedCount(wishesGranted.length);
    setStep('rolling');
    // 0.6s 摇骰子动画 → 1.6s 结果展示 → 调 onSubmit
    window.setTimeout(() => setStep('result'), 600);
    window.setTimeout(() => {
      void onSubmit({
        entryMode: mode,
        wishes,
        wishesGranted,
        loadout: {
          companionIds: Array.from(carriedCompanionIds),
          itemIds: Array.from(carriedItemIds),
        },
      });
    }, 600 + 1600);
  }

  // 已结算状态:控制按钮文案 + cost 提示
  const isSettled = plaza.isScenarioSettled(scenarioId);

  return (
    <div style={MODAL_OVERLAY_STYLE} role="dialog" aria-modal="true">
      <div style={{ ...MODAL_CARD_STYLE, maxWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>{scenario?.name ?? scenarioId}</h2>
          <span
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 99,
              background: DIFFICULTY_COLOR[difficulty] + '22',
              color: DIFFICULTY_COLOR[difficulty],
              border: `1px solid ${DIFFICULTY_COLOR[difficulty]}66`,
            }}
          >
            {DIFFICULTY_LABEL[difficulty]} · 愿望约 {Math.round(grantRate * 100)}% 成真
          </span>
          {isSettled && (
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 99,
                background: '#1a3a1a',
                color: '#8c8',
                border: '1px solid #2a5a2a',
              }}
              title="已通关 · 再访不扣 entryCost,但不再有原力奖励;战死 / 物品损毁仍正常"
            >
              ✅ 已通关
            </span>
          )}
        </div>
        <p className="muted" style={{ marginTop: 8, marginBottom: 16, fontSize: 13 }}>
          {scenario?.description}
        </p>
        {isSettled && (
          <div
            style={{
              padding: '8px 10px',
              marginBottom: 12,
              background: '#0f1a14',
              border: '1px solid #1f4030',
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.6,
              color: '#9c9',
            }}
          >
            ✅ 你已结算过此剧本。本次再访 <b>免 entryCost</b>,但 <b>不再有原力奖励</b>。
            <br />
            <span className="muted">
              战死 / 物品损毁 / 队友陨落仍是不可逆事件;复活与升级仍正常消耗原力。
            </span>
          </div>
        )}

        {step === 'form' && (
          <>
            {/* 模式选择 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 6, fontSize: 13 }}>进入方式</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className={mode === 'soul' ? 'primary' : ''}
                  disabled={!soulAvailable}
                  onClick={() => setMode('soul')}
                  style={{ flex: 1, padding: 10, fontSize: 13, textAlign: 'left' }}
                  title={soulAvailable ? '' : '此剧本未配置灵魂化身角色'}
                >
                  <div style={{ fontWeight: 600 }}>🔮 灵魂进入</div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                    {soulAvailable
                      ? `化身为「${scenario?.playerSoulIdentity?.name}」`
                      : '(此剧本未配置)'}
                  </div>
                </button>
                <button
                  className={mode === 'body' ? 'primary' : ''}
                  onClick={() => setMode('body')}
                  style={{ flex: 1, padding: 10, fontSize: 13, textAlign: 'left' }}
                >
                  <div style={{ fontWeight: 600 }}>👤 身体进入</div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                    保留你的身份,作异世界访客闯入
                  </div>
                </button>
              </div>
            </div>

            {/* 当前模式的身份预览 */}
            <div
              style={{
                marginBottom: 16,
                padding: 10,
                background: '#0f1119',
                borderRadius: 6,
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              {mode === 'soul' && scenario?.playerSoulIdentity && (
                <>
                  <div style={{ color: '#7cf', marginBottom: 4 }}>
                    🔮 你会成为本世界的 <b>{scenario.playerSoulIdentity.name}</b>
                  </div>
                  <div className="muted">{scenario.playerSoulIdentity.background}</div>
                </>
              )}
              {mode === 'body' && (
                <>
                  <div style={{ color: '#fc7', marginBottom: 4 }}>
                    👤 你保留自己的身份闯入此世界
                  </div>
                  <div className="muted">
                    称呼:{userProfile.nickname?.trim() || '旅人'} ·{' '}
                    {userProfile.gender === 'male'
                      ? '男'
                      : userProfile.gender === 'female'
                        ? '女'
                        : '不限性别'}{' '}
                    · {userProfile.age > 0 ? `${userProfile.age} 岁` : '年龄未明'}
                  </div>
                  <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>
                    进入时会生成一段"穿越背景"(怎么来的 / 身上的残余 / 第一印象)
                  </div>
                </>
              )}
            </div>

            {/* 愿望表单 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 6, fontSize: 13 }}>
                你的祈愿{' '}
                <span className="muted">
                  (最多 3 条,留空即可不许愿。命运会随机批准其中一些)
                </span>
              </div>
              {wishesArr.map((w, i) => (
                <input
                  key={i}
                  type="text"
                  maxLength={80}
                  placeholder={`愿望 ${i + 1}(可留空)`}
                  value={w}
                  onChange={(e) => {
                    const next: [string, string, string] = [...wishesArr] as [
                      string,
                      string,
                      string,
                    ];
                    next[i] = e.target.value;
                    setWishesArr(next);
                  }}
                  style={{ width: '100%', marginBottom: 6 }}
                />
              ))}
            </div>

            {/* ─── 携带队友 折叠面板 ──────────────────────────── */}
            {availableCompanions.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <button
                  onClick={() => setShowCompanionPanel((v) => !v)}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    background: '#0f1119',
                    border: '1px solid #2a2d3e',
                    borderRadius: 6,
                    textAlign: 'left',
                    fontSize: 13,
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                  title="队友死在剧本里只能花原力(50×等级)复活,不带的安全留在广场"
                >
                  <span>
                    👥 携带队友{' '}
                    <span className="muted" style={{ fontSize: 11 }}>
                      ({carriedCompanionIds.size} / {availableCompanions.length})
                    </span>
                  </span>
                  <span className="muted">{showCompanionPanel ? '▼' : '▶'}</span>
                </button>
                {showCompanionPanel && (
                  <div
                    style={{
                      marginTop: 6,
                      padding: 10,
                      background: '#0a0c14',
                      border: '1px solid #2a2d3e',
                      borderRadius: 6,
                    }}
                  >
                    <div style={{ display: 'flex', gap: 6, marginBottom: 8, fontSize: 11 }}>
                      <button onClick={selectAllCompanions} style={{ padding: '2px 8px' }}>
                        全选
                      </button>
                      <button onClick={clearAllCompanions} style={{ padding: '2px 8px' }}>
                        全不选
                      </button>
                      <span
                        className="muted"
                        style={{ marginLeft: 'auto', alignSelf: 'center' }}
                      >
                        死在剧本里 = 需 50 × 等级 原力复活
                      </span>
                    </div>
                    {availableCompanions.map((c) => {
                      const carried = carriedCompanionIds.has(c.characterId);
                      return (
                        <label
                          key={c.characterId}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '4px 6px',
                            borderRadius: 4,
                            cursor: 'pointer',
                            opacity: carried ? 1 : 0.55,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={carried}
                            onChange={() => toggleCompanion(c.characterId)}
                          />
                          <span style={{ flex: 1, fontSize: 12 }}>
                            {c.profile.origin?.split('·')[0]?.trim() || '队友'} ·{' '}
                            <b>{c.profile.characterId.replace(/^companion-/, '')}</b>
                          </span>
                          <span
                            className="muted"
                            style={{ fontSize: 11, whiteSpace: 'nowrap' }}
                          >
                            Lv.{c.level} · 复活 {companionReviveCost(c)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ─── 携带物品 折叠面板 ──────────────────────────── */}
            {availableItems.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <button
                  onClick={() => setShowItemPanel((v) => !v)}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    background: '#0f1119',
                    border: '1px solid #2a2d3e',
                    borderRadius: 6,
                    textAlign: 'left',
                    fontSize: 13,
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                  title="物品在剧本里损毁/掉落 = 永久消失,不带的安全留在广场"
                >
                  <span>
                    🎒 携带物品{' '}
                    <span className="muted" style={{ fontSize: 11 }}>
                      ({carriedItemIds.size} / {availableItems.length})
                    </span>
                  </span>
                  <span className="muted">{showItemPanel ? '▼' : '▶'}</span>
                </button>
                {showItemPanel && (
                  <div
                    style={{
                      marginTop: 6,
                      padding: 10,
                      background: '#0a0c14',
                      border: '1px solid #2a2d3e',
                      borderRadius: 6,
                    }}
                  >
                    <div style={{ display: 'flex', gap: 6, marginBottom: 8, fontSize: 11 }}>
                      <button onClick={selectAllItems} style={{ padding: '2px 8px' }}>
                        全选
                      </button>
                      <button onClick={clearAllItems} style={{ padding: '2px 8px' }}>
                        全不选
                      </button>
                      <span
                        className="muted"
                        style={{ marginLeft: 'auto', alignSelf: 'center' }}
                      >
                        损毁 / 掉落 = 永久消失
                      </span>
                    </div>
                    {availableItems.map((it) => {
                      const carried = carriedItemIds.has(it.id);
                      const suppressed = isItemSuppressed(it, scenario?.magicTags);
                      return (
                        <label
                          key={it.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '4px 6px',
                            borderRadius: 4,
                            cursor: 'pointer',
                            opacity: carried ? 1 : 0.55,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={carried}
                            onChange={() => toggleItem(it.id)}
                          />
                          <span style={{ flex: 1, fontSize: 12 }}>
                            <b>{it.name}</b>{' '}
                            <span className="muted" style={{ fontSize: 11 }}>
                              Lv.{it.level} · {it.type === 'magic' ? '神奇' : '凡物'}
                            </span>
                          </span>
                          {suppressed && (
                            <span
                              style={{
                                fontSize: 10,
                                color: '#f77',
                                padding: '1px 6px',
                                background: '#3a0e0e',
                                borderRadius: 99,
                                whiteSpace: 'nowrap',
                              }}
                              title="本剧本的法则与该物品神奇属性不兼容,效果会被削弱"
                            >
                              削弱
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button onClick={onCancel}>取消</button>
              <button className="primary" onClick={handleSubmit}>
                {filledWishes.length > 0 ? '发愿,启程 →' : '启程 →'}
              </button>
            </div>
          </>
        )}

        {step === 'rolling' && (
          <div
            style={{
              textAlign: 'center',
              padding: '40px 0',
              fontSize: 18,
              color: '#7cf',
            }}
          >
            ✨ 命运在掷骰子...
          </div>
        )}

        {step === 'result' && (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            {totalWishes === 0 ? (
              <>
                <div style={{ fontSize: 24, marginBottom: 8 }}>🚪</div>
                <div style={{ fontSize: 14 }}>无愿启程 — 走入命运。</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 24, marginBottom: 12 }}>
                  {grantedCount === 0
                    ? '🌑'
                    : grantedCount === totalWishes
                      ? '✨'
                      : '🌒'}
                </div>
                <div style={{ fontSize: 15, marginBottom: 4 }}>
                  命运批准了 <b style={{ color: '#7cf' }}>{grantedCount}</b> / {totalWishes} 个愿望。
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  (具体是哪几个,要靠你自己在剧情里发现)
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// 模态样式常量(避免在两个组件里重复定义)
const MODAL_OVERLAY_STYLE: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.7)',
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};

const MODAL_CARD_STYLE: React.CSSProperties = {
  background: '#1a1d2e',
  border: '1px solid #2a2d3e',
  borderRadius: 8,
  padding: 24,
  maxWidth: 480,
  width: '100%',
  maxHeight: '90vh',
  overflowY: 'auto',
};

// ─── DLC 加载启动屏障(loadAllDlc 进行中渲染这个,完成后才渲染主 UI)─────

/**
 * 启动期间的全屏占位。
 *   - result === null:还在 fetch / SSR 渲染 → 显示 "加载剧本..."
 *   - result.fatalError:manifest 拉不到 → 显示错误 + 重试按钮
 *   - result.failed.length > 0 但 loaded.length > 0:部分成功 → 仍解除屏障(主 UI 路径不会进这里),所以这里不会被命中
 *   - 失败但有缓存可用 → loadAllDlc 也会调 _markDlcReady,这里同样不命中
 */
function DlcLoadingScreen({ result }: { result: DlcLoadResult | null }) {
  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: 16,
        padding: 32,
      }}
    >
      <h1 style={{ margin: 0 }}>World Crossing</h1>
      {!result && (
        <>
          <div className="muted" style={{ fontSize: 14 }}>
            正在从 DLC 目录加载剧本数据...
          </div>
          <div style={{ fontSize: 12, opacity: 0.5 }}>(首次加载约 200ms,刷新走 sessionStorage 缓存)</div>
        </>
      )}
      {result?.fatalError && (
        <div style={{ color: '#f77', fontSize: 13, textAlign: 'center', maxWidth: 480 }}>
          <div style={{ marginBottom: 8 }}>⚠️ DLC 加载失败</div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
            {result.fatalError}
          </div>
          <button onClick={() => window.location.reload()}>重新加载</button>
        </div>
      )}
    </div>
  );
}

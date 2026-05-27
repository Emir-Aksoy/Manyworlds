/**
 * P4 World Tick — 纯函数 evaluator
 * ================================
 *
 * 无依赖、无 side-effect、不读 plaza、不读 window。
 * Plaza/UI 调用这里的函数,把结果存进 plaza state 或直接渲染。
 *
 * 时间模型:
 *   - WorldClock = { day, hour },day ≥ 0,hour ∈ [0, 24)
 *   - 一天 24 小时;月/年/纪元等更高单位只在渲染时通过 EraTemplate 拼出来,
 *     不参与 clock 算术(MVP 不做真实日历推算,P4-B 再上)。
 *
 * 跨日 schedule:
 *   - hours [22, 4] 表示 22:00 到次日 04:00。判定 (hour >= 22 || hour < 4)。
 *   - hours [9, 12] 表示 09:00 到 12:00(不含)。判定 9 <= hour < 12。
 *
 * 这里只 pure 计算;plaza.advanceClock 是 stateful wrapper(读旧 clock + 推进
 * + 触发 events + 写新 clock),见 lib/plaza.ts。
 */

import type { CharacterSpec, ScheduleEntry } from './character-spec';
import type { EraTemplate, Scenario, WorldEvent } from './scenarios';

// ─── 类型 ────────────────────────────────────────────────────────

export interface WorldClock {
  /** 入境后累计天数,从 0 起 */
  day: number;
  /** 24 小时制,范围 [0, 24) */
  hour: number;
}

export interface WorldLogEntry {
  /** event 触发时的 clock 快照 */
  ts: WorldClock;
  /** 触发的 WorldEvent.id */
  eventId: string;
  /** WorldEvent.short_summary,缓存在 log 里;就算作者后来改了 scenario 文件,log 也不会失同步 */
  summary: string;
}

export interface NpcRuntime {
  /**
   * 当前所在 locationId。
   * 优先级:schedule 命中 → npc.locations[0] → scenario.initialLocation → null
   */
  locationId: string | null;
  /** 当前正在做的事(给 LLM prompt 用);schedule 命中时取 entry.action,fallback = '' */
  action: string;
  /** 取自哪条 schedule 条目(便于 debug + UI 显示);null = 用了 fallback */
  scheduleHit: ScheduleEntry | null;
}

// ─── 初始 clock ──────────────────────────────────────────────────

const DEFAULT_INITIAL_CLOCK: WorldClock = { day: 0, hour: 8 };

/**
 * 读剧本的初始时间。缺省 → 早上 8 点,day 0(合理的"故事开场"时间)。
 */
export function getInitialClock(scenario: Scenario): WorldClock {
  const init = scenario.eraTemplate?.initial;
  if (!init) return { ...DEFAULT_INITIAL_CLOCK };
  return {
    day: Math.max(0, Math.floor(init.day ?? 0)),
    hour: clampHour(init.hour ?? 8),
  };
}

function clampHour(h: number): number {
  const n = Math.floor(h);
  if (!Number.isFinite(n)) return 0;
  return ((n % 24) + 24) % 24;
}

// ─── Schedule ────────────────────────────────────────────────────

/**
 * (day, hour) 是否落入这条 schedule entry 的 hours 区间(且 days 命中)。
 *
 * 规则:
 *   - entry.days 缺省 / 空 → 每天命中
 *   - entry.hours [s, e]:s < e → 普通区间 s <= h < e
 *   - entry.hours [s, e]:s > e → 跨日 h >= s || h < e
 *   - entry.hours [s, e]:s == e → 空区间(永不命中)
 */
export function isScheduleHit(entry: ScheduleEntry, day: number, hour: number): boolean {
  if (entry.days && entry.days.length > 0 && !entry.days.includes(day)) return false;
  const [start, end] = entry.hours;
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/**
 * 找出 NPC 在 (day, hour) 命中的第一条 schedule entry。
 * 多 entry 命中 → 取数组第一条(作者负责排序);无 schedule / 无命中 → null。
 */
export function findScheduleEntry(
  npc: CharacterSpec,
  day: number,
  hour: number,
): ScheduleEntry | null {
  if (!npc.schedule || npc.schedule.length === 0) return null;
  for (const entry of npc.schedule) {
    if (isScheduleHit(entry, day, hour)) return entry;
  }
  return null;
}

/**
 * 推导 NPC 在指定 clock 下的运行时位置 + 动作。
 *
 * fallback 链:
 *   1. schedule 命中 → entry.locationId / entry.action
 *   2. NPC 没 schedule(或没命中)→ npc.locations[0] + ''
 *   3. NPC 没标 locations → scenario.initialLocation + ''
 *   4. 都没 → { locationId: null, action: '' }
 */
export function getNpcRuntime(
  npc: CharacterSpec,
  scenario: Scenario,
  clock: WorldClock,
): NpcRuntime {
  const hit = findScheduleEntry(npc, clock.day, clock.hour);
  if (hit) {
    return { locationId: hit.locationId, action: hit.action, scheduleHit: hit };
  }
  const npcLoc = npc.locations?.[0];
  if (npcLoc) {
    return { locationId: npcLoc, action: '', scheduleHit: null };
  }
  const initLoc = scenario.initialLocation ?? null;
  return { locationId: initLoc, action: '', scheduleHit: null };
}

// ─── WorldEvent ──────────────────────────────────────────────────

/**
 * 给定单个 (day, hour) tick + 已完成 milestone + 已触发 event 列表,
 * 返回此刻应当 fire 的 WorldEvent 列表。
 *
 * 触发条件(AND):
 *   1. event.id ∉ alreadyFired(每个 event 一辈子只 fire 一次)
 *   2. clock 落在 when 窗口
 *   3. requires_milestones 全部在 milestonesDone 中(缺省 = 无前置)
 */
export function findFiringWorldEvents(
  scenario: Scenario,
  clock: WorldClock,
  milestonesDone: string[],
  alreadyFired: string[],
): WorldEvent[] {
  if (!scenario.worldEvents || scenario.worldEvents.length === 0) return [];
  const milestoneSet = new Set(milestonesDone);
  const firedSet = new Set(alreadyFired);
  const out: WorldEvent[] = [];
  for (const ev of scenario.worldEvents) {
    if (firedSet.has(ev.id)) continue;
    if (!isInWhenWindow(ev.when, clock)) continue;
    if (ev.requires_milestones && ev.requires_milestones.length > 0) {
      const allMet = ev.requires_milestones.every((m) => milestoneSet.has(m));
      if (!allMet) continue;
    }
    out.push(ev);
  }
  return out;
}

function isInWhenWindow(
  when: { day_from: number; day_to: number; hour_from?: number; hour_to?: number },
  clock: WorldClock,
): boolean {
  if (clock.day < when.day_from || clock.day > when.day_to) return false;
  // hour 缺省 → 当天全天命中
  const hf = when.hour_from;
  const ht = when.hour_to;
  if (hf === undefined && ht === undefined) return true;
  const lo = hf ?? 0;
  const hi = ht ?? 24;
  return clock.hour >= lo && clock.hour < hi;
}

/**
 * NPC 是否能"感知"到此 worldEvent(由 visibility 决定)。
 *
 *   - 'public'        → 所有 NPC 都可能听说
 *   - 'faction:<id>'  → 仅 npc.identity.species/origin/... 不够精细,改读 npc.identity.aliases 或自定义字段?
 *                       PoC 阶段:从 npc.meta?.compatible_with 或 character-specific 标签查;
 *                       MVP 暂用 简单匹配 — npc 任何字符串字段包含 faction id 即视为属于。
 *                       (P4-B 引入 npc.factions 字段)
 *   - 'location:<id>' → 仅当该 NPC 当前(由 schedule 推导)在该 location
 *
 * 注:本函数不读 plaza,只用传入的 npcRuntime。caller 自己算 npcRuntime。
 */
export function isEventVisibleToNpc(
  event: WorldEvent,
  npc: CharacterSpec,
  npcRuntime: NpcRuntime,
): boolean {
  const v = event.visibility;
  if (v === 'public') return true;
  if (v.startsWith('location:')) {
    const locId = v.slice('location:'.length);
    return npcRuntime.locationId === locId;
  }
  if (v.startsWith('faction:')) {
    const factionId = v.slice('faction:'.length);
    // MVP:从 npc 的 traits / aliases / origin_world 等字段做包含匹配。
    // 严谨方案 P4-B 引入显式 npc.factions[]。
    const haystack = [
      ...(npc.core_persona.traits ?? []),
      ...(npc.identity.aliases ?? []),
      npc.identity.species ?? '',
      npc.identity.origin_world ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(factionId.toLowerCase());
  }
  return false;
}

// ─── Render ──────────────────────────────────────────────────────

/**
 * 把 clock 渲染成玩家可见的字符串。
 *
 * EraTemplate.template 占位符约定:
 *   - {era}    → initial.era(原样,clock 推进不变)
 *   - {year}   → initial.year(MVP 不做年增量;真实日历 P4-B)
 *   - {month}  → initial.month(同上)
 *   - {day}    → initial.day + clock.day
 *   - {hour}   → clock.hour
 *   - 自定义占位符 → 查 dictionaries[key][String(clock.hour)](MVP 只支持 hour-indexed)
 *
 * 缺省 EraTemplate → fallback "第 N 天 第 H 时"。
 * 未识别的占位符保留原样(如 "{foo}"),便于发现配置错误。
 */
export function renderClock(eraTemplate: EraTemplate | undefined, clock: WorldClock): string {
  if (!eraTemplate) {
    return `第 ${clock.day} 天 第 ${clock.hour} 时`;
  }
  const { template, initial, dictionaries } = eraTemplate;
  const totalDay = initial.day + clock.day;
  const ctx: Record<string, string | number> = {
    era: initial.era,
    year: initial.year,
    month: initial.month,
    day: totalDay,
    hour: clock.hour,
  };
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (key in ctx) return String(ctx[key]);
    const dict = dictionaries?.[key];
    if (dict) {
      const v = dict[String(clock.hour)];
      if (v !== undefined) return v;
    }
    return `{${key}}`;
  });
}

// ─── Clock 推进 ─────────────────────────────────────────────────

/**
 * 推进 clock。pure。
 *   - deltaHours < 0:静默裁到 0(不允许倒流;若有需要 P4-B 单独 API)
 *   - deltaHours 非整数:floor
 */
export function advanceClockPure(clock: WorldClock, deltaHours: number): WorldClock {
  const delta = Math.max(0, Math.floor(deltaHours));
  if (delta === 0) return { ...clock };
  const totalHours = clock.day * 24 + clock.hour + delta;
  return {
    day: Math.floor(totalHours / 24),
    hour: totalHours % 24,
  };
}

/**
 * 推进 clock 并收集这段时间内所有 fire 的 WorldEvents。
 *
 * 按 hour 逐 tick 扫:每个 tick 查 findFiringWorldEvents,把新 fire 的累积 + 立即加入 firedSet
 * 防止同一 event 在窗口内重复返回。
 *
 * 返回:
 *   - clock:最终 clock
 *   - events:这段时间(包含起始 tick 之后到最终 tick)新 fire 的 events,按 tick 顺序
 *
 * 起始 clock 本身的 tick 不算"刚 fire"——caller 进剧本时若想触发 day0 hour 0 的 event,
 * 应当独立调一次 findFiringWorldEvents(clock=initial, ...) 处理。advanceTick 是"推进过程"。
 */
export function advanceClockWithEvents(
  scenario: Scenario,
  fromClock: WorldClock,
  deltaHours: number,
  milestonesDone: string[],
  alreadyFired: string[],
): { clock: WorldClock; events: WorldEvent[] } {
  const delta = Math.max(0, Math.floor(deltaHours));
  if (delta === 0) return { clock: { ...fromClock }, events: [] };
  const fired = new Set(alreadyFired);
  const out: WorldEvent[] = [];
  let cur = { ...fromClock };
  for (let i = 0; i < delta; i++) {
    cur = advanceClockPure(cur, 1);
    const newEvents = findFiringWorldEvents(scenario, cur, milestonesDone, Array.from(fired));
    for (const ev of newEvents) {
      out.push(ev);
      fired.add(ev.id);
    }
  }
  return { clock: cur, events: out };
}

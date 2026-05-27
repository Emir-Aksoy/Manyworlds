#!/usr/bin/env tsx
/**
 * Validate P4 World Tick scenario fields.
 *
 * 用法:
 *   npx tsx scripts/validate-scenario-p4.mts <path-to-scenario.json>
 *
 * 退出码:
 *   0 = 无 error(可能有 warning)
 *   1 = 至少一个 error
 *   2 = 用法错误 / 文件读不到 / JSON 解析失败
 *
 * 校验范围(P4-MVP 专项):
 *   - eraTemplate(若 present):template 非空,initial 字段全齐
 *   - worldEvents(若 present):id 唯一/kebab-case;when 区间合法;
 *     visibility 引用的 location 必须在 scenario.locations 白名单内;
 *     short_summary / description 非空
 *   - NPC.schedule(若 present):hours 是 [0-23/24] 整数;
 *     locationId 在 scenario.locations[] 白名单;action 非空
 *
 * **不**校验通用 scenario schema(id / name / npcs / locations / beats / etc)—
 * 那部分跟现有 validateScenario 走,P4 validator 独立于 plaza/window,
 * 让任何外部 agent 不用启 next 也能跑。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface ValidationOutput {
  errors: string[];
  warnings: string[];
}

function pushErr(out: ValidationOutput, msg: string) {
  out.errors.push(msg);
}
function pushWarn(out: ValidationOutput, msg: string) {
  out.warnings.push(msg);
}

// ─── eraTemplate ─────────────────────────────────────────────────

function validateEraTemplate(t: unknown, out: ValidationOutput) {
  if (!t || typeof t !== 'object') {
    pushErr(out, 'eraTemplate 不是对象');
    return;
  }
  const tpl = t as Record<string, unknown>;
  if (typeof tpl.template !== 'string' || !(tpl.template as string).trim()) {
    pushErr(out, 'eraTemplate.template 必须是非空字符串');
  }
  if (!tpl.initial || typeof tpl.initial !== 'object') {
    pushErr(out, 'eraTemplate.initial 必须是对象');
    return;
  }
  const init = tpl.initial as Record<string, unknown>;
  for (const k of ['era', 'year', 'month', 'day', 'hour']) {
    if (!(k in init)) pushErr(out, `eraTemplate.initial.${k} 缺失`);
  }
  if (typeof init.era !== 'string') {
    pushErr(out, 'eraTemplate.initial.era 必须是字符串(可以是空字符串)');
  }
  for (const k of ['year', 'month', 'day', 'hour'] as const) {
    if (typeof init[k] !== 'number' || !Number.isInteger(init[k] as number)) {
      pushErr(out, `eraTemplate.initial.${k} 必须是整数`);
    }
  }
  if (typeof init.hour === 'number' && (init.hour < 0 || init.hour > 23)) {
    pushErr(out, `eraTemplate.initial.hour 必须 ∈ [0, 23]`);
  }
  if (tpl.dictionaries !== undefined && typeof tpl.dictionaries !== 'object') {
    pushErr(out, 'eraTemplate.dictionaries 必须是对象');
  }
}

// ─── worldEvent ─────────────────────────────────────────────────

function validateWorldEvent(
  ev: unknown,
  idx: number,
  scenarioLocationIds: Set<string>,
  scenarioFactionIds: Set<string>,
  existingIds: Set<string>,
  out: ValidationOutput,
) {
  const prefix = `worldEvents[${idx}]`;
  if (!ev || typeof ev !== 'object') {
    pushErr(out, `${prefix} 不是对象`);
    return;
  }
  const e = ev as Record<string, unknown>;

  // id
  if (typeof e.id !== 'string' || !KEBAB.test(e.id as string)) {
    pushErr(out, `${prefix}.id 不是合法 kebab-case`);
  } else if (existingIds.has(e.id as string)) {
    pushErr(out, `${prefix}.id "${e.id as string}" 重复(剧本内必须唯一)`);
  } else {
    existingIds.add(e.id as string);
  }

  // when
  if (!e.when || typeof e.when !== 'object') {
    pushErr(out, `${prefix}.when 必须是对象`);
  } else {
    const w = e.when as Record<string, unknown>;
    if (typeof w.day_from !== 'number' || !Number.isInteger(w.day_from) || w.day_from < 0) {
      pushErr(out, `${prefix}.when.day_from 必须是非负整数`);
    }
    if (typeof w.day_to !== 'number' || !Number.isInteger(w.day_to)) {
      pushErr(out, `${prefix}.when.day_to 必须是整数`);
    } else if (typeof w.day_from === 'number' && w.day_to < w.day_from) {
      pushErr(out, `${prefix}.when.day_to 必须 ≥ day_from`);
    }
    if (w.hour_from !== undefined) {
      if (!Number.isInteger(w.hour_from) || (w.hour_from as number) < 0 || (w.hour_from as number) > 23) {
        pushErr(out, `${prefix}.when.hour_from 必须 ∈ [0, 23]`);
      }
    }
    if (w.hour_to !== undefined) {
      if (!Number.isInteger(w.hour_to) || (w.hour_to as number) < 0 || (w.hour_to as number) > 24) {
        pushErr(out, `${prefix}.when.hour_to 必须 ∈ [0, 24]`);
      }
      if (typeof w.hour_from === 'number' && typeof w.hour_to === 'number' && w.hour_to <= w.hour_from) {
        pushErr(out, `${prefix}.when.hour_to 必须 > hour_from`);
      }
    }
  }

  // short_summary
  if (typeof e.short_summary !== 'string' || !(e.short_summary as string).trim()) {
    pushErr(out, `${prefix}.short_summary 必须是非空字符串`);
  } else if ((e.short_summary as string).length > 80) {
    pushWarn(
      out,
      `${prefix}.short_summary "${(e.short_summary as string).slice(0, 40)}..." 超 80 字符(建议 15-30 字)`,
    );
  }

  // description
  if (typeof e.description !== 'string' || !(e.description as string).trim()) {
    pushErr(out, `${prefix}.description 必须是非空字符串`);
  } else if ((e.description as string).length < 30) {
    pushWarn(out, `${prefix}.description 较短(${(e.description as string).length} 字符),建议 50-150 字`);
  }

  // visibility
  if (typeof e.visibility !== 'string') {
    pushErr(out, `${prefix}.visibility 必须是字符串`);
  } else if (e.visibility === 'public') {
    // OK
  } else if ((e.visibility as string).startsWith('faction:')) {
    const factionId = (e.visibility as string).slice('faction:'.length);
    if (scenarioFactionIds.size > 0 && !scenarioFactionIds.has(factionId)) {
      pushWarn(
        out,
        `${prefix}.visibility 引用 faction "${factionId}",但剧本 factions 里未定义(non-fatal,建议加)`,
      );
    }
  } else if ((e.visibility as string).startsWith('location:')) {
    const locationId = (e.visibility as string).slice('location:'.length);
    if (!scenarioLocationIds.has(locationId)) {
      pushErr(out, `${prefix}.visibility 引用 location "${locationId}",不在 scenario.locations 白名单`);
    }
  } else {
    pushErr(
      out,
      `${prefix}.visibility "${e.visibility as string}" 格式无效(必须是 'public' | 'faction:xxx' | 'location:xxx')`,
    );
  }

  // requires_milestones
  if (e.requires_milestones !== undefined) {
    if (!Array.isArray(e.requires_milestones)) {
      pushErr(out, `${prefix}.requires_milestones 必须是数组`);
    } else {
      for (const m of e.requires_milestones) {
        if (typeof m !== 'string') {
          pushErr(out, `${prefix}.requires_milestones 元素必须是字符串`);
          break;
        }
      }
    }
  }

  // affects
  if (e.affects !== undefined) {
    if (typeof e.affects !== 'object' || e.affects === null) {
      pushErr(out, `${prefix}.affects 必须是对象`);
    } else {
      const a = e.affects as Record<string, unknown>;
      if (a.worldFlags !== undefined && typeof a.worldFlags !== 'object') {
        pushErr(out, `${prefix}.affects.worldFlags 必须是 KV 对象`);
      }
    }
  }

  // narrate
  if (e.narrate !== undefined && typeof e.narrate !== 'boolean') {
    pushErr(out, `${prefix}.narrate 必须是 boolean`);
  }
}

// ─── schedule ─────────────────────────────────────────────────

function validateScheduleEntry(
  entry: unknown,
  npcId: string,
  idx: number,
  scenarioLocationIds: Set<string>,
  out: ValidationOutput,
) {
  const prefix = `npc[${npcId}].schedule[${idx}]`;
  if (!entry || typeof entry !== 'object') {
    pushErr(out, `${prefix} 不是对象`);
    return;
  }
  const s = entry as Record<string, unknown>;

  if (s.days !== undefined) {
    if (!Array.isArray(s.days)) {
      pushErr(out, `${prefix}.days 必须是数组`);
    } else {
      for (const d of s.days) {
        if (typeof d !== 'number' || !Number.isInteger(d) || d < 0) {
          pushErr(out, `${prefix}.days 元素必须是非负整数`);
          break;
        }
      }
    }
  }

  if (!Array.isArray(s.hours) || s.hours.length !== 2) {
    pushErr(out, `${prefix}.hours 必须是 [start, end] 数组`);
  } else {
    const [start, end] = s.hours as number[];
    if (!Number.isInteger(start) || start < 0 || start > 23) {
      pushErr(out, `${prefix}.hours[0] 必须 ∈ [0, 23] 整数`);
    }
    if (!Number.isInteger(end) || end < 0 || end > 24) {
      pushErr(out, `${prefix}.hours[1] 必须 ∈ [0, 24] 整数`);
    }
    // start === end 是无效(0 时长 entry);start > end 合法(跨日,如 [22, 4])
    if (start === end) {
      pushErr(out, `${prefix}.hours[0] 不能等于 hours[1](0 时长 entry 无意义)`);
    }
  }

  if (typeof s.locationId !== 'string' || !(s.locationId as string).trim()) {
    pushErr(out, `${prefix}.locationId 必须是非空字符串`);
  } else if (!scenarioLocationIds.has(s.locationId as string)) {
    pushErr(out, `${prefix}.locationId "${s.locationId as string}" 不在 scenario.locations 白名单`);
  }

  if (typeof s.action !== 'string' || !(s.action as string).trim()) {
    pushErr(out, `${prefix}.action 必须是非空字符串`);
  }
}

// ─── main ─────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: tsx scripts/validate-scenario-p4.mts <path-to-scenario.json>');
    process.exit(2);
  }
  const filePath = resolve(args[0]);
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(2);
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const out: ValidationOutput = { errors: [], warnings: [] };

  console.log(`[validate-p4] 检验: ${filePath}`);
  console.log(`[validate-p4] Scenario id: ${(raw.id as string) ?? '<无 id>'}`);

  // 收集白名单
  const locationIds = new Set<string>();
  if (Array.isArray(raw.locations)) {
    for (const loc of raw.locations) {
      if (loc && typeof loc === 'object' && typeof (loc as Record<string, unknown>).id === 'string') {
        locationIds.add((loc as Record<string, unknown>).id as string);
      }
    }
  }

  const factionIds = new Set<string>();
  if (Array.isArray(raw.factions)) {
    for (const f of raw.factions) {
      if (f && typeof f === 'object' && typeof (f as Record<string, unknown>).id === 'string') {
        factionIds.add((f as Record<string, unknown>).id as string);
      }
    }
  }

  console.log(`[validate-p4] Location count: ${locationIds.size}`);
  console.log(`[validate-p4] Faction count: ${factionIds.size}`);

  // ─── eraTemplate ─────────────────────────────────────
  if (raw.eraTemplate !== undefined) {
    validateEraTemplate(raw.eraTemplate, out);
  } else {
    pushWarn(out, 'eraTemplate 未声明,渲染会走 framework 默认 `第 {day} 天 第 {hour} 时`');
  }

  // ─── worldEvents ─────────────────────────────────────
  const seenEventIds = new Set<string>();
  if (raw.worldEvents !== undefined) {
    if (!Array.isArray(raw.worldEvents)) {
      pushErr(out, 'worldEvents 必须是数组');
    } else {
      console.log(`[validate-p4] worldEvents count: ${raw.worldEvents.length}`);
      raw.worldEvents.forEach((ev: unknown, i: number) =>
        validateWorldEvent(ev, i, locationIds, factionIds, seenEventIds, out),
      );
    }
  } else {
    pushWarn(out, 'worldEvents 未声明,剧本完全靠 beats 玩家驱动(无时间事件)');
  }

  // ─── NPC.schedule ─────────────────────────────────────
  let npcWithSchedule = 0;
  let npcWithoutSchedule = 0;
  if (Array.isArray(raw.npcs)) {
    console.log(`[validate-p4] NPC count: ${raw.npcs.length}`);
    for (const npc of raw.npcs) {
      if (!npc || typeof npc !== 'object') continue;
      const n = npc as Record<string, unknown>;
      const npcId = (n.character_id as string) || (n.id as string) || '<no-id>';
      if (n.schedule !== undefined) {
        if (!Array.isArray(n.schedule)) {
          pushErr(out, `npc[${npcId}].schedule 必须是数组`);
        } else {
          n.schedule.forEach((entry: unknown, i: number) =>
            validateScheduleEntry(entry, npcId, i, locationIds, out),
          );
          npcWithSchedule++;
        }
      } else {
        npcWithoutSchedule++;
      }
    }
    console.log(`[validate-p4] NPC with schedule: ${npcWithSchedule} / without: ${npcWithoutSchedule}`);
  }

  // ─── 汇报 ─────────────────────────────────────────
  console.log('');
  if (out.warnings.length > 0) {
    console.log(`⚠ ${out.warnings.length} warning(s):`);
    for (const w of out.warnings) console.log(`  - ${w}`);
    console.log('');
  }
  if (out.errors.length > 0) {
    console.log(`✗ ${out.errors.length} error(s):`);
    for (const e of out.errors) console.log(`  - ${e}`);
    console.log('');
    console.log('[validate-p4] FAIL');
    process.exit(1);
  }
  console.log('[validate-p4] OK');
  process.exit(0);
}

main();

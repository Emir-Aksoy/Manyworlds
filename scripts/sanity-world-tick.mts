/**
 * P4 World Tick sanity check.
 *
 * 用法: npx tsx scripts/sanity-world-tick.mts
 *
 * 跑 evaluator on docs/example-scenario-p4.json,把关键输出 dump 出来,
 * 人工 eyeball 一下结构是否合理。不替代后续真单测,但能立刻发现明显 bug。
 *
 * 不导入 plaza.ts(避免 window dependency)。只用 lib/world-tick.ts 纯函数。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Scenario } from '../lib/scenarios.js';
import {
  advanceClockWithEvents,
  findFiringWorldEvents,
  findScheduleEntry,
  getInitialClock,
  getNpcRuntime,
  isEventVisibleToNpc,
  renderClock,
} from '../lib/world-tick.js';

const EXAMPLE_PATH = resolve(process.cwd(), 'docs/example-scenario-p4.json');

const raw = readFileSync(EXAMPLE_PATH, 'utf8');
const scenario = JSON.parse(raw) as Scenario;

console.log('=== Loaded scenario ===');
console.log(`id: ${scenario.id}  name: ${scenario.name}`);
console.log(
  `eraTemplate: ${!!scenario.eraTemplate}  worldEvents: ${scenario.worldEvents?.length ?? 0}  npcs: ${scenario.npcs.length}  locations: ${scenario.locations?.length ?? 0}`,
);

console.log('\n=== Initial clock ===');
const init = getInitialClock(scenario);
console.log(`{ day: ${init.day}, hour: ${init.hour} }`);
console.log(`rendered: "${renderClock(scenario.eraTemplate, init)}"`);

console.log('\n=== NPC runtime @ initial ===');
for (const npc of scenario.npcs) {
  const rt = getNpcRuntime(npc, scenario, init);
  const hit = rt.scheduleHit ? '🎯' : '↩';
  console.log(
    `  ${hit} ${npc.identity.name.padEnd(14)} → loc=${(rt.locationId ?? '<null>').padEnd(20)} action="${rt.action}"`,
  );
}

console.log('\n=== Events firing @ initial (day 0 hour 8) ===');
const fired0 = findFiringWorldEvents(scenario, init, [], []);
if (fired0.length === 0) console.log('  (none)');
for (const ev of fired0) {
  console.log(`  - ${ev.id}: ${ev.short_summary}  [vis=${ev.visibility}]`);
}

console.log('\n=== Advance +52h (day +2 hour +4) ===');
const adv = advanceClockWithEvents(scenario, init, 52, [], []);
console.log(`new clock: { day: ${adv.clock.day}, hour: ${adv.clock.hour} }`);
console.log(`rendered: "${renderClock(scenario.eraTemplate, adv.clock)}"`);
console.log(`events fired during advance: ${adv.events.length}`);
for (const ev of adv.events) {
  console.log(`  - ${ev.id}: ${ev.short_summary}  [vis=${ev.visibility}]`);
}

console.log('\n=== NPC runtime @ new clock ===');
for (const npc of scenario.npcs) {
  const rt = getNpcRuntime(npc, scenario, adv.clock);
  const hit = rt.scheduleHit ? '🎯' : '↩';
  console.log(
    `  ${hit} ${npc.identity.name.padEnd(14)} → loc=${(rt.locationId ?? '<null>').padEnd(20)} action="${rt.action}"`,
  );
}

console.log('\n=== Visibility check (first fired event vs all NPCs) ===');
if (adv.events.length > 0) {
  const ev = adv.events[0];
  console.log(`event: ${ev.id}  vis=${ev.visibility}`);
  for (const npc of scenario.npcs) {
    const rt = getNpcRuntime(npc, scenario, adv.clock);
    const vis = isEventVisibleToNpc(ev, npc, rt);
    console.log(`  ${vis ? '👁' : '·'} ${npc.identity.name.padEnd(14)}  rt.loc=${rt.locationId ?? '<null>'}`);
  }
} else {
  console.log('  (no events fired during advance)');
}

console.log('\n=== Schedule probe: every hour of day 0 ===');
for (let h = 0; h < 24; h++) {
  const clock = { day: 0, hour: h };
  const homes = scenario.npcs.map((n) => {
    const e = findScheduleEntry(n, 0, h);
    return e ? `${n.identity.name}@${e.locationId}` : `${n.identity.name}@-`;
  });
  console.log(`  h=${String(h).padStart(2, '0')}  ${homes.join('  ')}`);
}

console.log('\n✅ sanity dump complete');

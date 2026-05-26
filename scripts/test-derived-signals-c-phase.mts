/**
 * C 阶段验收的 ad-hoc 回归测试。
 * 验证 C1 (emotion→trust map) + C2 (analyzeReplyStructure + engagementHint 分类) 行为。
 *
 * 跑法:npx tsx scripts/test-derived-signals-c-phase.mts
 * 用完即扔(不在 CI 里跑)
 */

import { getEmotionAutoTrust } from '../lib/emotion-detect';
import {
  analyzeReplyStructure,
  recordReplyMetrics,
  getReplyMetrics,
  clearReplyMetrics,
  type EngagementHint,
} from '../lib/reply-metrics';

// ─── C1: emotion → trust map ──────────────────────────────────
console.log('\n=== C1: emotion → trust auto map ===\n');
const c1Cases: Array<[string, number]> = [
  ['neutral', 0],
  ['happy', +1],
  ['serious', 0],
  ['sad', 0],
  ['intense', -1],
];
let c1Pass = 0;
for (const [emo, expected] of c1Cases) {
  const got = getEmotionAutoTrust(emo as 'neutral');
  const ok = got === expected;
  console.log(`  ${ok ? '✓' : '✗'} ${emo} → ${got} (expect ${expected})`);
  if (ok) c1Pass++;
}
console.log(`  → ${c1Pass}/${c1Cases.length} PASS`);

// ─── C2: analyzeReplyStructure + engagementHint 分类 ──────────
console.log('\n=== C2: reply structure analysis ===\n');

interface C2Case {
  name: string;
  text: string;
  expectHint: EngagementHint;
  /** 抽样指标断言(可选) */
  expectMinLen?: number;
}

const c2Cases: C2Case[] = [
  {
    name: 'withdrawn — 短而无问',
    text: '不知道。',
    expectHint: 'withdrawn',
  },
  {
    name: 'withdrawn — 冷淡两字',
    text: '走吧。',
    expectHint: 'withdrawn',
  },
  {
    name: 'curious — 连珠反问',
    text: '你是谁?你从哪里来?为何要来找我?',
    expectHint: 'curious',
    expectMinLen: 10,
  },
  {
    name: 'expressive — 长 + 感叹号',
    text: '哈哈哈!好极了!这一刀真够利落!想不到你竟有这般本事,真是大开眼界,佩服佩服!',
    expectHint: 'expressive',
  },
  {
    name: 'lecturing — 长 + 自我指涉 + 无问号',
    text: '我告诉你,本座行走江湖三十年,见过太多年少轻狂之辈。我劝你早日收手。我可以放你一马,但本座的耐心有限。',
    expectHint: 'lecturing',
  },
  {
    name: 'engaged — 中等正常对话',
    text: '今夜月色不错,我们坐下喝一杯吧。',
    expectHint: 'engaged',
  },
  {
    name: '剥 WC 注释后才算长度',
    text: '嗯。<!-- WC-TRUST delta=+1 reason="客气" --><!-- WC-EVENT location-changed value=changan reason="北上" -->',
    expectHint: 'withdrawn', // 注释剥掉后只剩 "嗯。" 2 字
  },
];

let c2Pass = 0;
for (const c of c2Cases) {
  const m = analyzeReplyStructure(c.text);
  const hintOk = m.engagementHint === c.expectHint;
  const lenOk = c.expectMinLen == null || m.length >= c.expectMinLen;
  const ok = hintOk && lenOk;
  console.log(`  ${ok ? '✓' : '✗'} ${c.name}`);
  console.log(`     got: hint=${m.engagementHint} len=${m.length} q=${m.questionRatio.toFixed(2)} excl=${m.exclamationRatio.toFixed(2)} self=${m.selfRefRatio.toFixed(2)}`);
  console.log(`     expect: hint=${c.expectHint}${c.expectMinLen ? ` len≥${c.expectMinLen}` : ''}`);
  if (ok) c2Pass++;
}
console.log(`  → ${c2Pass}/${c2Cases.length} PASS`);

// ─── C2-bis: ring buffer ──────────────────────────────────────
console.log('\n=== C2-bis: ring buffer ===\n');
clearReplyMetrics();
for (let i = 0; i < 3; i++) {
  recordReplyMetrics(`npc-test-${i}`, analyzeReplyStructure(`第 ${i} 条`));
}
const records = getReplyMetrics();
console.log(`  得到 ${records.length} 条 (期望 3)`);
console.log(`  最后一条 npcId = ${records[records.length - 1]?.npcId}`);
const bufOk = records.length === 3 && records[records.length - 1]?.npcId === 'npc-test-2';
console.log(`  → ${bufOk ? '✓' : '✗'} ring buffer 工作正确`);

// ─── 总结 ─────────────────────────────────────────────────────
const totalPass = c1Pass + c2Pass + (bufOk ? 1 : 0);
const total = c1Cases.length + c2Cases.length + 1;
console.log(`\n=== 总计 ${totalPass}/${total} PASS ===`);
if (totalPass !== total) process.exit(1);

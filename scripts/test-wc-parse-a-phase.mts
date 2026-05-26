/**
 * A 阶段验收的 ad-hoc 回归测试。
 * 验证 A2/A3/A4/A5 在实际输入下的行为。
 *
 * 跑法:npx tsx scripts/test-wc-parse-a-phase.mts
 * 用完即扔(不在 CI 里跑)
 */

import {
  parseWcEvents,
  parseWcStatEvents,
  parseWcTrustEvents,
  getWcParseFailures,
  clearWcParseFailures,
} from '../lib/llm-events';

interface Case {
  name: string;
  text: string;
  expect: string;
}

const cases: Case[] = [
  {
    name: 'A3 ❶ value 用双引号',
    text: '<!-- WC-EVENT location-changed value="changan" reason="北上" -->',
    expect: '应 parse 出 1 个 event,id=changan',
  },
  {
    name: 'A3 ❷ value 用单引号',
    text: "<!-- WC-EVENT location-changed value='luoyang' reason=\"南下\" -->",
    expect: 'id=luoyang',
  },
  {
    name: 'A3 ❸ WC-STAT 浮点 hp/stamina',
    text: '<!-- WC-STAT subject=player hp=-20.5 stamina=+10.7 reason="挨刀" -->',
    expect: 'hp=-20(trunc), stamina=+10(trunc)',
  },
  {
    name: 'A3 ❹ WC-TRUST 浮点 delta',
    text: '<!-- WC-TRUST delta=+2.6 reason="对话融洽" -->',
    expect: 'delta=+3(round)',
  },
  {
    name: 'A5 ❶ 多个 WC-TRUST 合并',
    text:
      '<!-- WC-TRUST delta=+3 reason="帮我解围" -->\n' +
      '<!-- WC-TRUST delta=+2 reason="赠我酒" -->',
    expect: '合并成 1 个 delta=+5, reason="帮我解围 / 赠我酒"',
  },
  {
    name: 'A5 ❷ 累加抵消',
    text:
      '<!-- WC-TRUST delta=+5 reason="帮我" -->\n' +
      '<!-- WC-TRUST delta=-5 reason="然后骗我" -->',
    expect: '抵消 → 空数组',
  },
  {
    name: 'A5 ❸ clamp 防爆',
    text:
      '<!-- WC-TRUST delta=+9 reason="一" -->\n' +
      '<!-- WC-TRUST delta=+9 reason="二" -->\n' +
      '<!-- WC-TRUST delta=+9 reason="三" -->',
    expect: '累加 27 → clamp 到 +10',
  },
  {
    name: 'A2 ❶ reason 漏引号',
    text: '<!-- WC-TRUST delta=+3 reason=漏引号 -->',
    expect: '0 事件 + 1 fail (hint 应含 "reason 漏双引号")',
  },
  {
    name: 'A2 ❷ value 含中文',
    text: '<!-- WC-EVENT location-changed value=长安 reason="北上" -->',
    expect: '0 事件 + 1 fail (hint 应含 "中文/标点")',
  },
  {
    name: 'A2 ❸ delta 非数字',
    text: '<!-- WC-TRUST delta=很多 reason="信任爆棚" -->',
    expect: '0 事件 + 1 fail',
  },
  {
    name: '✓ 正常通过 (无 fail)',
    text: '<!-- WC-EVENT location-changed value=changan reason="北上" -->',
    expect: '1 event, 0 fail',
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  clearWcParseFailures();
  const evts = parseWcEvents(c.text);
  const stats = parseWcStatEvents(c.text);
  const trusts = parseWcTrustEvents(c.text);
  const fails = getWcParseFailures();
  const summary = {
    evts: evts.map((e) => ({ kind: e.kind, id: e.id })),
    stats: stats.map((s) => ({
      subject: s.subject,
      hp: s.hp,
      stamina: s.stamina,
      willpower: s.willpower,
    })),
    trusts: trusts.map((t) => ({ delta: t.delta, reason: t.reason })),
    fails: fails.map((f) => `[${f.kind}] ${f.hint}`),
  };
  console.log(`\n— ${c.name}`);
  console.log(`  期望: ${c.expect}`);
  console.log(`  得到: ${JSON.stringify(summary, null, 0)}`);
  pass++;
}

console.log(`\n=== 跑完 ${pass + fail} 个 case ===`);

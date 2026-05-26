/**
 * Prompt Snapshot
 * ================
 *
 * 用途:验证 prompt 段化重构后,公开剧本 fixture 的 system prompt
 * 跟 baseline 完全一致(byte-identical)。
 *
 * 跑法:
 *   npm run test:prompt-snapshot                  # 跑公开 fixtures,写入 / 更新 baseline
 *   npm run test:prompt-snapshot -- --check       # check 模式:对比公开 baseline
 *   npm run test:prompt-snapshot -- --include-private --check
 *                                                # 本机存在 ignored 私有 DLC 时才跑私有 fixtures
 *
 * 第一次跑产出 baseline 写到 __snapshots__/prompts/;以后修改了 prompt 段化相关代码,
 * 重跑能立刻看出哪些 prompt 发生了变化(新增段 / 段顺序变 / 段内容变)。
 *
 * 不依赖 dev server,纯 CLI(tsx 跑 TS,直接 import lib/*)。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

import { validateScenario } from '../lib/scenarios/custom';
import { _registerDlcScenario, _markDlcReady, getScenario } from '../lib/scenarios';
import { assembleSystemPrompt } from '../lib/prompt-segments';
import type { CharacterSpec } from '../lib/character-spec';
import type { SystemPromptContext } from '../lib/characters';
import type { Scenario } from '../lib/scenarios';

/**
 * tsx 把 lib/scenarios 解析成多个模块实例(脚本看到的 dlcRegistry 跟 characters.ts
 * 看到的不是同一份),所以不能用 characters.ts:buildSystemPromptForCharacter — 它内部
 * 调 getScenario() 会查到空 registry。改成直接调 assembleSystemPrompt + 手动注入 scenario。
 */
function findNpc(scenarioId: string, npcId: string) {
  const sc = getScenario(scenarioId);
  return sc?.npcs.find((c) => c.character_id === npcId);
}

/** 等价于 characters.ts:buildSystemPromptForCharacter,但不依赖 dlcRegistry。 */
function buildPromptForSnapshot(
  char: CharacterSpec,
  scenario: Scenario,
  ctx: SystemPromptContext,
): string {
  const adaptation = ctx.scenarioId
    ? char.world_adaptation?.per_world_overrides?.[ctx.scenarioId]
    : undefined;
  return assembleSystemPrompt({ char, scenario, ctx, adaptation });
}

const args = new Set(process.argv.slice(2));
const checkMode = args.has('--check');
const includePrivate = args.has('--include-private') || process.env.WC_PROMPT_SNAPSHOT_PRIVATE === '1';

// ─── 1) 加载公开 manifest DLC ──────────────────────────────────────

const manifestPath = join(repoRoot, 'public/dlc/manifest.json');
const dlcManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  scenarios: Array<{ id: string; url: string }>;
};

const loadedScenarioIds = new Set<string>();

function loadScenarioFile(id: string, filePath: string) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const v = validateScenario(raw);
  if (!v.ok) {
    console.error(`[snapshot] ${id} schema 错误:`, v.errors);
    process.exit(1);
  }
  _registerDlcScenario(v.scenario);
  loadedScenarioIds.add(v.scenario.id);
  console.log(`[snapshot] 注册 ${v.scenario.id} (${v.scenario.npcs.length} NPC)`);
}

for (const entry of dlcManifest.scenarios) {
  const filePath = join(repoRoot, 'public', entry.url);
  loadScenarioFile(entry.id, filePath);
}

function loadPrivateScenarioIfNeeded(id: string) {
  if (loadedScenarioIds.has(id)) return;
  const filePath = join(repoRoot, 'public', 'dlc', `${id}.json`);
  if (!existsSync(filePath)) {
    console.error(`[snapshot] --include-private 需要本机存在 ${filePath}`);
    process.exit(1);
  }
  loadScenarioFile(id, filePath);
}

if (includePrivate) {
  for (const id of ['warhammer40k', 'datang']) loadPrivateScenarioIfNeeded(id);
}
_markDlcReady();


// ─── 2) Fixture 定义 ────────────────────────────────────────────────

interface Fixture {
  scenarioId: string;
  npcId: string;
  variant: 'minimal' | 'rich';
}

const PUBLIC_SCENARIO_FIXTURES: Array<{ id: string; npcs: string[] }> = [
  {
    id: 'starmail',
    npcs: ['starmail-npc-halia', 'starmail-npc-bao', 'starmail-npc-lighthouse'],
  },
  {
    id: 'yuanmo',
    npcs: ['yuanmo-npc-zhu-yuanzhang', 'yuanmo-npc-xu-da', 'yuanmo-npc-chang-yuchun'],
  },
];

const PRIVATE_SCENARIO_FIXTURES: Array<{ id: string; npcs: string[] }> = [
  {
    id: 'warhammer40k',
    npcs: [
      'warhammer40k-npc-magister-karaeth',
      'warhammer40k-npc-reclusiarch-vorel',
      'warhammer40k-npc-apothecary-sulam',
    ],
  },
  {
    id: 'datang',
    npcs: ['datang-npc-kou-zhong', 'datang-npc-xu-ziling', 'datang-npc-shi-feixuan'],
  },
];

const SCENARIO_FIXTURES = includePrivate
  ? [...PUBLIC_SCENARIO_FIXTURES, ...PRIVATE_SCENARIO_FIXTURES]
  : PUBLIC_SCENARIO_FIXTURES;

const FIXTURES: Fixture[] = [];
for (const s of SCENARIO_FIXTURES) {
  for (const npc of s.npcs) {
    FIXTURES.push({ scenarioId: s.id, npcId: npc, variant: 'minimal' });
    FIXTURES.push({ scenarioId: s.id, npcId: npc, variant: 'rich' });
  }
}

// rich-ctx 用的"完整玩家上下文":带身份/愿望/同伴/物品/记忆/关系/数值/地点,
// 让段化的 player / state / scene-state / location / wc-event / wc-stat 全部触发
const RICH_CTX_BASE = {
  playerIdentity: {
    mode: 'body' as const,
    displayName: 'Aksoy',
    gender: 'male' as const,
    age: 30,
    background: '一个突然出现在这里的访客,带着另一个世界的记忆。',
    bodyEntryContext: '他乘船到江都时遭遇暴风,昏迷醒来发现自己在大唐境内。',
  },
  wishes: {
    granted: ['希望能学到一身武功'],
    denied: ['想跟历史人物谈一场恋爱'],
  },
  activeCompanions: [
    {
      characterId: 'companion-test',
      active: true,
      level: 3,
      profile: {
        characterId: 'companion-test',
        description: '一个忠诚的跟班,武功一般但脑子活',
        mentalState: '隐藏:对玩家有不可言说的感情',
        origin: '测试·伙伴',
      },
    },
  ] as any,
  inventory: [
    {
      id: 'item-test',
      name: '玄铁剑',
      level: 5,
      type: 'magic' as const,
      description: '一把来自异世界的玄铁剑,削铁如泥,但在 ki 世界里能效大减。',
      origin: 'test-world',
    },
  ] as any,
  relationship: {
    trust: 25,
    key_moments: ['第一次相遇时帮过对方解围'],
  } as any,
  memories: [
    { scene: '在江边救过这个人' },
    { scene: '一起喝过一次酒' },
  ] as any,
  summary: { text: '玩家跟此 NPC 已有数面之缘,关系算朋友但非莫逆。' } as any,
  combatStats: {
    player: {
      hp: 80,
      hpMax: 100,
      stamina: 60,
      staminaMax: 100,
      willpower: 50,
      willpowerMax: 100,
      conditions: ['轻伤'],
    },
  } as any,
};

/** 每个剧本 rich-ctx 加一个最合理的 currentLocation(动态剧本才有效果)。 */
const RICH_CTX_LOCATIONS: Record<string, string | undefined> = {
  datang: 'yangzhou',
  starmail: undefined, // starmail 是 scenes 模式,无 locations
  yuanmo: undefined, // 看一下,可能也是 scenes 模式
  warhammer40k: undefined,
};

// ─── 3) 生成 prompt + 写 snapshot ──────────────────────────────────

const SNAPSHOT_DIR = join(repoRoot, '__snapshots__/prompts');
if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });

interface Result {
  key: string;
  status: 'new' | 'unchanged' | 'changed';
  oldLen?: number;
  newLen?: number;
}

const results: Result[] = [];

for (const fx of FIXTURES) {
  const char = findNpc(fx.scenarioId, fx.npcId);
  const scenario = getScenario(fx.scenarioId);
  if (!char || !scenario) {
    console.error(`[snapshot] NPC 或剧本找不到: ${fx.npcId} (in ${fx.scenarioId})`);
    process.exit(1);
  }
  const ctx: SystemPromptContext =
    fx.variant === 'rich'
      ? {
          scenarioId: fx.scenarioId,
          ...RICH_CTX_BASE,
          currentLocation: RICH_CTX_LOCATIONS[fx.scenarioId],
        }
      : { scenarioId: fx.scenarioId };
  const prompt = buildPromptForSnapshot(char, scenario, ctx);

  const key = `${fx.scenarioId}.${fx.npcId.replace(`${fx.scenarioId}-npc-`, '')}.${fx.variant}`;
  const file = join(SNAPSHOT_DIR, `${key}.txt`);

  let status: Result['status'] = 'new';
  let oldLen: number | undefined;
  if (existsSync(file)) {
    const old = readFileSync(file, 'utf8');
    oldLen = old.length;
    if (old === prompt) {
      status = 'unchanged';
    } else {
      status = 'changed';
    }
  }

  // 非 --check 模式总是写;--check 模式不写,只对比
  if (!checkMode) {
    writeFileSync(file, prompt, 'utf8');
  }
  results.push({ key, status, oldLen, newLen: prompt.length });
}

// ─── 4) 报告 ────────────────────────────────────────────────────────

const counts = { new: 0, unchanged: 0, changed: 0 };
for (const r of results) counts[r.status]++;

console.log(
  `[snapshot] ${results.length} fixtures (${SCENARIO_FIXTURES.length} scenarios × 3 NPCs × 2 variants, private=${includePrivate ? 'on' : 'off'})`,
);
console.log(
  `  ${counts.new} new${checkMode ? ' (would write)' : ''}, ` +
    `${counts.unchanged} unchanged, ` +
    `${counts.changed} changed${checkMode ? ' (DIFF)' : ' (written)'}`,
);

if (counts.changed > 0) {
  console.log('\n变更的 fixture:');
  for (const r of results) {
    if (r.status === 'changed') {
      console.log(`  CHANGED  ${r.key}  (${r.oldLen} → ${r.newLen} chars)`);
    }
  }
}
if (counts.new > 0) {
  console.log('\n新建的 fixture:');
  for (const r of results) {
    if (r.status === 'new') {
      console.log(`  NEW      ${r.key}  (${r.newLen} chars)`);
    }
  }
}

if (checkMode && (counts.changed > 0 || counts.new > 0)) {
  console.error('\n[snapshot] --check 模式下检测到新增或变更,退出 1。');
  process.exit(1);
}

console.log(`\n[snapshot] ${checkMode ? 'check 模式,未写入' : '已写入 ' + SNAPSHOT_DIR}`);

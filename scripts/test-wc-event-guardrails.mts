import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
};

function makeStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
    removeItem(key: string) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    get length() {
      return data.size;
    },
  };
}

Object.defineProperty(globalThis, 'window', {
  value: {
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    location: { hostname: 'localhost', origin: 'http://localhost:3000' },
  },
  configurable: true,
});

const { validateScenario } = await import('../lib/scenarios/custom');
const { _registerDlcScenario, _markDlcReady } = await import('../lib/scenarios');
const { plaza } = await import('../lib/plaza');
const {
  applyWcEventsToPlaza,
  clearWcParseFailures,
  getWcParseFailures,
} = await import('../lib/llm-events');

function registerScenarioFromDlc(id: string) {
  const raw = JSON.parse(readFileSync(join(process.cwd(), 'public', 'dlc', `${id}.json`), 'utf8'));
  const result = validateScenario(raw);
  if (!result.ok) throw new Error(`scenario ${id} invalid: ${result.errors.join('; ')}`);
  _registerDlcScenario(result.scenario);
  _markDlcReady();
}

function enterNianNian() {
  plaza.reset();
  const entered = plaza.enterScenario('niannian', 0, undefined, {
    companionIds: ['companion-xiaoming'],
    itemIds: ['item-cosmic-charm'],
  });
  assert.deepEqual(entered, { ok: true });
  plaza.setCurrentLocation('niannian-bookstore');
}

registerScenarioFromDlc('niannian');

clearWcParseFailures();
enterNianNian();
applyWcEventsToPlaza(
  '我指向一扇并不存在的门。<!-- WC-EVENT location-changed value=llm-invented-room reason="幻觉地点" -->',
);
assert.equal(
  plaza.get().currentLocation,
  'niannian-bookstore',
  '未知 location-changed 必须被拒绝,不能写入 currentLocation',
);
assert.ok(
  getWcParseFailures().some((f) => f.hint.includes('已拒绝')),
  '未知 location 被拒绝时应留下可诊断的 parse failure',
);
console.log('ok rejects unknown location-changed');

clearWcParseFailures();
enterNianNian();
applyWcEventsToPlaza(
  [
    '火光一闪。',
    '<!-- WC-EVENT companion-died characterId=companion-xiaoming reason="LLM 判定死亡" -->',
    '<!-- WC-EVENT item-lost itemId=item-cosmic-charm reason="LLM 判定损毁" -->',
  ].join('\n'),
);
const state = plaza.get();
assert.notEqual(
  state.companions.find((c) => c.characterId === 'companion-xiaoming')?.hp,
  'dead',
  'companion-died 默认不能直接杀死队友',
);
assert.notEqual(
  state.inventory.find((i) => i.id === 'item-cosmic-charm')?.lost,
  true,
  'item-lost 默认不能直接损毁/丢失物品',
);
assert.ok(
  getWcParseFailures().some((f) => f.raw.includes('companion-died') && f.hint.includes('待人工确认')),
  '被拦截的 companion-died 应留下待确认诊断',
);
assert.ok(
  getWcParseFailures().some((f) => f.raw.includes('item-lost') && f.hint.includes('待人工确认')),
  '被拦截的 item-lost 应留下待确认诊断',
);
console.log('ok blocks destructive WC-EVENT by default');

import { strict as assert } from 'node:assert';

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
};

function makeStorage(seed: Record<string, string> = {}): StorageLike {
  const data = new Map(Object.entries(seed));
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

function installWindow(storageSeed: Record<string, string> = {}) {
  const localStorage = makeStorage(storageSeed);
  const sessionStorage = makeStorage();
  Object.defineProperty(globalThis, 'window', {
    value: {
      localStorage,
      sessionStorage,
      location: { hostname: 'world-crossing.example', origin: 'https://world-crossing.example' },
    },
    configurable: true,
  });
  return { localStorage, sessionStorage };
}

async function testPublicModeRouterNeverUsesLocalLanes() {
  process.env.NODE_ENV = 'production';
  installWindow();

  const { router } = await import('../lib/router');
  const { PUBLIC_UNAVAILABLE_LANES } = await import('../lib/runtime-mode');

  const lane = router.resolveLane('npc.core.dialogue');
  assert.equal(lane, 'deepseek', 'public 默认路由应使用 deepseek,不能落到本机 bridge lane');
  assert.ok(!PUBLIC_UNAVAILABLE_LANES.includes(lane), `public 路由不应返回 ${lane}`);

  window.localStorage.setItem(
    'wc_poc_router_v2',
    JSON.stringify({
      presetId: 'balanced',
      overrides: {},
      taskFallback: {
        'npc.core.dialogue': ['codex_bridge', 'local_gemma', 'deepseek'],
      },
    }),
  );

  assert.deepEqual(
    router.getTaskFallback('npc.core.dialogue'),
    ['deepseek'],
    'public 模式应过滤用户旧存档里不可用的本机 fallback lane',
  );
}

async function testDefaultFullExportStripsCustomLaneKeysAndIncludesMessages() {
  installWindow({
    wc_poc_custom_lanes_v1: JSON.stringify([
      {
        id: 'custom_story',
        label: 'Story Provider',
        baseUrl: 'https://api.example.com',
        model: 'story-model',
        apiKey: 'sk-custom-secret',
      },
    ]),
    wc_poc_custom_image_lanes_v1: JSON.stringify([
      {
        id: 'img_story',
        label: 'Image Provider',
        baseUrl: 'https://images.example.com',
        model: 'image-model',
        apiKey: 'sk-image-secret',
      },
    ]),
    wc_poc_apikey_openai: 'sk-openai-secret',
    wc_poc_messages_v2: JSON.stringify({
      starmail: {
        halia: [{ role: 'user', content: 'hello' }],
      },
    }),
  });

  const { exportAllAsJson } = await import('../lib/full-export');
  const json = exportAllAsJson();
  const payload = JSON.parse(json);

  assert.equal(payload.includesKeys, false);
  assert.ok(!json.includes('sk-custom-secret'), '默认完整导出不能包含 Custom Lane apiKey');
  assert.ok(!json.includes('sk-image-secret'), '默认完整导出不能包含 Custom Image Lane apiKey');
  assert.ok(!json.includes('sk-openai-secret'), '默认完整导出不能包含独立 BYOK apiKey');
  assert.equal(
    payload.data.wc_poc_messages_v2.starmail.halia[0].content,
    'hello',
    'localStorage 中的聊天记录应包含在完整备份里',
  );
}

async function testImageCompatDoesNotFetchPrivateReturnedUrls() {
  const originalFetch = globalThis.fetch;
  let privateUrlFetched = false;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://example.com/v1/images/generations') {
      return new Response(
        JSON.stringify({
          data: [{ url: 'http://127.0.0.1/private-image.png' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === 'http://127.0.0.1/private-image.png') {
      privateUrlFetched = true;
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const { POST } = await import('../app/api/image-compat/route');
    const req = new Request('https://world-crossing.example/api/image-compat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk-test',
        'X-Wc-Base-Url': 'https://example.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: 'portrait',
        model: 'image-model',
        responseFormat: 'url',
      }),
    });

    const resp = await POST(req as any);
    assert.notEqual(resp.status, 200, '返回私有 URL 时 image-compat 不应成功');
    assert.equal(privateUrlFetched, false, 'image-compat 不应反向 fetch 私有/内网 URL');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const tests = [
  testPublicModeRouterNeverUsesLocalLanes,
  testDefaultFullExportStripsCustomLaneKeysAndIncludesMessages,
  testImageCompatDoesNotFetchPrivateReturnedUrls,
];

for (const test of tests) {
  await test();
  console.log(`ok ${test.name}`);
}

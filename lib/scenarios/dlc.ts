/**
 * DLC 加载器 (Downloadable Content)
 * ================================
 *
 * 把所有剧本(scenarios)从主 bundle 拆出来,改成运行时从 `public/dlc/*.json` 加载的 DLC 形式。
 *
 * 流程:
 *   1. 启动时(app/page.tsx 顶层 useEffect)调 `loadAllDlc()`
 *   2. `fetch('/dlc/manifest.json')` 拉清单
 *   3. 并发 `fetch` 所有 manifest.scenarios[].url 的 JSON
 *   4. 每个 JSON 走 `validateScenario`(复用 custom.ts 的校验)→ 注册到 `dlcRegistry`(内存 Map,在 index.ts)
 *   5. `setDlcReady(true)` → Home 组件解除 loading 屏障
 *
 * 缓存:
 *   - sessionStorage 缓存,key 用 `manifest.version` 作 cache-buster
 *   - 刷新页面命中缓存 → 无 fetch 直接 register(冷启 < 100ms)
 *   - 改了 DLC 数据 → 改 manifest.version → 缓存自动失效
 *
 * 失败兜底:
 *   - manifest fetch 失败 → 返回 errors 数组,UI 显示"DLC 加载失败,部分功能不可用",主程序仍可启动
 *   - 单个 scenario fetch 失败 → 跳过它,继续注册其他
 */

import type { Scenario } from './index';
import { _registerDlcScenario, _markDlcReady } from './index';
import { validateScenario } from './custom';

const DLC_MANIFEST_URL = '/dlc/manifest.json';
const SESSION_CACHE_KEY = 'wc_poc_dlc_cache_v1';

// ─── 类型 ────────────────────────────────────────────────────────

export interface DlcManifest {
  version: number;
  scenarios: Array<{
    id: string;
    url: string;
    name: string;
    shortName: string;
    description: string;
  }>;
}

export interface DlcLoadResult {
  ok: boolean;
  /** 成功注册的 scenario ids */
  loaded: string[];
  /** 失败的 scenario ids + 原因 */
  failed: Array<{ id: string; reason: string }>;
  /** manifest 自身 fetch / parse 错误(致命) */
  fatalError?: string;
  /** 命中 sessionStorage 缓存 → 没走网络 */
  fromCache: boolean;
}

// ─── sessionStorage 缓存 ─────────────────────────────────────────

interface CachedDlc {
  version: number;
  scenarios: Array<{ id: string; data: unknown }>;
}

function readCache(): CachedDlc | null {
  if (typeof window === 'undefined') return null;
  // Dev 环境跳缓存 — 直接编辑 public/dlc/*.json 后忘了 ++manifest.version 也能看到改动。
  // production 构建里 NODE_ENV 是字符串字面量,webpack 会把整个 if 优化掉(死代码消除)。
  if (process.env.NODE_ENV !== 'production') return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (
      !obj ||
      typeof obj !== 'object' ||
      typeof obj.version !== 'number' ||
      !Array.isArray(obj.scenarios)
    ) {
      return null;
    }
    return obj as CachedDlc;
  } catch {
    return null;
  }
}

function writeCache(cache: CachedDlc) {
  if (typeof window === 'undefined') return;
  // 跟 readCache 对称:dev 既不读也不写,避免 quota 浪费
  if (process.env.NODE_ENV !== 'production') return;
  try {
    window.sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* quota 满了就算了,下次刷新重 fetch */
  }
}

export function clearDlcCache() {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(SESSION_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

// ─── 单个 scenario fetch + 校验 + 注册 ──────────────────────────────

function registerOne(raw: unknown, idHint: string): { ok: true } | { ok: false; reason: string } {
  const v = validateScenario(raw);
  if (!v.ok) {
    return { ok: false, reason: `DLC ${idHint} schema 错误: ${v.errors.join('; ')}` };
  }
  _registerDlcScenario(v.scenario);
  return { ok: true };
}

async function fetchScenarioJson(url: string): Promise<unknown> {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${url}`);
  }
  return resp.json();
}

// ─── 主入口 ──────────────────────────────────────────────────────

/**
 * 启动时调一次。完成后 isDlcReady() 返 true,Home 可以渲染主 UI。
 * 多次调用安全(register 是幂等的 — Map.set 覆盖同 id)。
 *
 * **注意**:这个函数只在 client 端跑(SSR 环境直接返回空结果)。
 */
export async function loadAllDlc(): Promise<DlcLoadResult> {
  // SSR 环境跳过(没有 window,也没 fetch 上下文)
  if (typeof window === 'undefined') {
    return { ok: false, loaded: [], failed: [], fatalError: 'SSR 环境', fromCache: false };
  }

  // 1. 先 fetch manifest(只做这一次网络请求来判断 version)
  let manifest: DlcManifest;
  try {
    const resp = await fetch(DLC_MANIFEST_URL, { cache: 'no-store' });
    if (!resp.ok) {
      _markDlcReady(); // 哪怕 manifest 拿不到,也别永远卡 loading
      return {
        ok: false,
        loaded: [],
        failed: [],
        fatalError: `manifest HTTP ${resp.status}`,
        fromCache: false,
      };
    }
    manifest = await resp.json();
    _setManifest(manifest);
  } catch (e) {
    _markDlcReady();
    return {
      ok: false,
      loaded: [],
      failed: [],
      fatalError: `manifest fetch 失败: ${e instanceof Error ? e.message : String(e)}`,
      fromCache: false,
    };
  }

  // 2. 检查 sessionStorage 缓存是否还有效
  const cache = readCache();
  if (cache && cache.version === manifest.version) {
    const loaded: string[] = [];
    const failed: DlcLoadResult['failed'] = [];
    for (const entry of cache.scenarios) {
      const r = registerOne(entry.data, entry.id);
      if (r.ok) loaded.push(entry.id);
      else failed.push({ id: entry.id, reason: r.reason });
    }
    _markDlcReady();
    return { ok: failed.length === 0, loaded, failed, fromCache: true };
  }

  // 3. 缓存不命中 → 并发 fetch 所有 scenario.json
  const results = await Promise.allSettled(
    manifest.scenarios.map(async (s) => ({ id: s.id, data: await fetchScenarioJson(s.url) })),
  );

  const loaded: string[] = [];
  const failed: DlcLoadResult['failed'] = [];
  const cacheEntries: CachedDlc['scenarios'] = [];

  results.forEach((r, idx) => {
    const entry = manifest.scenarios[idx];
    if (r.status === 'rejected') {
      failed.push({
        id: entry.id,
        reason: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
      return;
    }
    const reg = registerOne(r.value.data, entry.id);
    if (reg.ok) {
      loaded.push(entry.id);
      cacheEntries.push({ id: entry.id, data: r.value.data });
    } else {
      failed.push({ id: entry.id, reason: reg.reason });
    }
  });

  // 4. 写缓存(只缓存 register 成功的;失败的下次再 fetch)
  if (cacheEntries.length > 0) {
    writeCache({ version: manifest.version, scenarios: cacheEntries });
  }

  _markDlcReady();
  return { ok: failed.length === 0, loaded, failed, fromCache: false };
}

// ─── 工具:返回 manifest 元信息(给 PlazaTab 列表标题用)─────────────

let cachedManifest: DlcManifest | null = null;

/** 在 loadAllDlc() 之后调用,可拿到 manifest 元数据(name/url 等)。SSR 返 null。 */
export function getDlcManifest(): DlcManifest | null {
  return cachedManifest;
}

/** loadAllDlc 内部用 — 把 manifest 缓存起来给 getDlcManifest 用。 */
export function _setManifest(m: DlcManifest) {
  cachedManifest = m;
}

/** 测试 / 调试用:强制重新拉 DLC(清缓存 + 重跑 loadAllDlc)。 */
export async function reloadDlc(): Promise<DlcLoadResult> {
  clearDlcCache();
  return loadAllDlc();
}

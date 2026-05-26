/**
 * Full Storage Export — 把 PoC 在 localStorage 里持久化的**所有**用户数据
 * 打包成 JSON,供用户备份 / 跨浏览器迁移。
 *
 * 原 `plaza.exportPlazaAsJson()` 只导出 `wc_poc_plaza_v1` 一个 key,
 * 但用户的"全部进度"还包括路由配置 / 自定义 lane / 自定义剧本——
 * 漏掉它们后用户在新浏览器恢复会发现自定义剧本 / 自定义 lane 全没了。
 *
 * 覆盖范围(localStorage,sessionStorage 是临时数据不导):
 *   ✓ wc_poc_plaza_v1            广场:队友 / 物品 / 剧本进度 / 关系 / 立绘等
 *   ✓ wc_poc_router_v2           路由 preset / overrides / fallback 链
 *   ✓ wc_poc_pref_v1             用户偏好(默认 model 等)
 *   ✓ wc_poc_byok_onboarded      BYOK 引导是否已 dismiss
 *   ✓ wc_poc_custom_lanes_v1     用户自定义的 LLM lane
 *   ✓ wc_poc_custom_image_lanes_v1 用户自定义的 Image lane(立绘生图)— 内含 apiKey 明文,
 *                                 跟其他 secret 走同一规则:默认导出整条 lane 时 key
 *                                 会跟着出去(因为它在 lane 对象内部,不是独立 key)。
 *                                 ⚠️ 想完全脱敏导出,先在 ModelsTab 删掉 Image Lane 再导出。
 *   ✓ wc_poc_custom_scenarios_v1 用户自定义剧本
 *   ✓ wc_poc_apibase_*           BYOK 自定义 base URL(本身不敏感)
 *   △ wc_poc_apikey_*            BYOK API key 明文 — 默认**不导出**,需 includeKeys=true 显式启用
 *
 * 故意**不**包括:
 *   ✗ wc_poc_portraits_v1        生图缓存 — 它在 **sessionStorage** 不在 localStorage,
 *                                关 tab 即清,跨 tab/device 都不共享。后果:跨设备迁移后
 *                                立绘需要重新生(=重新付钱)。这是已知短板,正在评估
 *                                是否迁到 localStorage(配额共享)或 IndexedDB(异步重构)。
 *
 * 设计要点:
 *   - API key 是明文 secret,UI 必须显式 confirm 才传 includeKeys=true
 *   - 输出 JSON 自带 schema/version 字段,方便未来做 importer 时识别格式
 *   - 错误降级:某个 key 不存在 / JSON 损坏不应该整盘失败,跳过该项
 */

const EXPORT_KEYS_NON_SENSITIVE = [
  'wc_poc_plaza_v1',
  'wc_poc_router_v2',
  'wc_poc_pref_v1',
  'wc_poc_byok_onboarded',
  'wc_poc_custom_lanes_v1',
  'wc_poc_custom_image_lanes_v1',
  'wc_poc_custom_scenarios_v1',
];

const APIKEY_PREFIX = 'wc_poc_apikey_';
const APIBASE_PREFIX = 'wc_poc_apibase_';

export interface FullExportOptions {
  /**
   * 是否包含明文 API key(默认 false)。
   * UI 必须显式 confirm:这些是 BYOK secret,泄露后第三方可直接花用户的钱。
   */
  includeKeys?: boolean;
}

export interface FullExportPayload {
  schema: 'world-crossing-full-export';
  version: 1;
  exportedAt: string;
  appUrl: string;
  /** 导出时是否含明文 API key(透明字段,提醒导入者) */
  includesKeys: boolean;
  /** 导出涵盖的 storage key 列表(导入端可校验) */
  keys: string[];
  data: Record<string, unknown>;
}

export function exportAllAsJson(opts: FullExportOptions = {}): string {
  const includeKeys = !!opts.includeKeys;
  const data: Record<string, unknown> = {};
  const includedKeys: string[] = [];

  if (typeof window === 'undefined') {
    const empty: FullExportPayload = {
      schema: 'world-crossing-full-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      appUrl: '',
      includesKeys: false,
      keys: [],
      data: {},
    };
    return JSON.stringify(empty, null, 2);
  }

  // 1. 固定的非敏感 key 逐个读
  for (const key of EXPORT_KEYS_NON_SENSITIVE) {
    const raw = window.localStorage.getItem(key);
    if (raw == null) continue;
    try {
      data[key] = JSON.parse(raw);
    } catch {
      // 不是 JSON(比如 byok_onboarded 存的是 '1')— 保留 raw string
      data[key] = raw;
    }
    includedKeys.push(key);
  }

  // 2. 扫所有 localStorage,捕获带前缀的 BYOK base URL / API key
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key) continue;
    const isApibase = key.startsWith(APIBASE_PREFIX);
    const isApikey = key.startsWith(APIKEY_PREFIX);
    if (!isApibase && !isApikey) continue;
    if (isApikey && !includeKeys) continue;
    const raw = window.localStorage.getItem(key);
    if (raw == null) continue;
    data[key] = raw; // base/key 本来就是 string
    includedKeys.push(key);
  }

  const payload: FullExportPayload = {
    schema: 'world-crossing-full-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    appUrl: window.location.origin,
    includesKeys: includeKeys,
    keys: includedKeys,
    data,
  };

  return JSON.stringify(payload, null, 2);
}

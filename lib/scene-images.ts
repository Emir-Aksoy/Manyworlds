/**
 * 场景插画缓存 (Scene Illustration Cache)
 * =========================================
 *
 * 进 scene / 切 scene 时,根据 scene.imagePrompt 调 SDXL 生一张"场景照",
 * 显示在对话上方做氛围底图。
 *
 * 缓存策略:sessionStorage(刷新页面就丢,够 PoC 用)。
 *   key 形如 `${scenarioId}::${sceneId}`,值是 base64 dataUrl。
 *
 * 为什么不进 plaza localStorage:
 *   - 单张图 base64 经常 500KB+,几张就吃掉 localStorage 5MB 配额
 *   - 场景图是"氛围品",刷新重新生没大损失(SDXL 4-step 几秒钟)
 */

const SCENE_IMAGE_KEY = 'wc_poc_scene_images_v1';

interface SceneImageMap {
  [key: string]: string; // dataUrl
}

function readMap(): SceneImageMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(SCENE_IMAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    const out: SceneImageMap = {};
    for (const k of Object.keys(obj)) {
      const v = (obj as Record<string, unknown>)[k];
      if (typeof v === 'string' && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 写场景图 map,quota 满时按 LRU 淘汰最旧的场景图(只留当前要写的这张 + 最近 N 个 scene)。
 * 实现:用一个并行的 timestamp map(独立 sessionStorage key)。
 */
const META_STORAGE_KEY = SCENE_IMAGE_KEY + ':meta';

interface SceneImageMeta {
  /** key → 最后访问时间(epoch ms) */
  [key: string]: number;
}

function readMeta(): SceneImageMeta {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(META_STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? (obj as SceneImageMeta) : {};
  } catch {
    return {};
  }
}

function writeMeta(meta: SceneImageMeta) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(META_STORAGE_KEY, JSON.stringify(meta));
  } catch {
    /* meta 不大,失败不严重 */
  }
}

function writeMap(map: SceneImageMap) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SCENE_IMAGE_KEY, JSON.stringify(map));
  } catch (e) {
    const err = e as { name?: string };
    if (err?.name !== 'QuotaExceededError' && err?.name !== 'NS_ERROR_DOM_QUOTA_REACHED') {
      console.warn('[scene-images] write 失败(非 quota):', e);
      return;
    }
    // LRU 淘汰:按 meta 时间倒序,留最近 3 张
    const meta = readMeta();
    const sorted = Object.keys(map).sort((a, b) => (meta[b] ?? 0) - (meta[a] ?? 0));
    const keep = new Set(sorted.slice(0, 3));
    const pruned: SceneImageMap = {};
    for (const k of Object.keys(map)) {
      if (keep.has(k)) pruned[k] = map[k];
    }
    try {
      window.sessionStorage.setItem(SCENE_IMAGE_KEY, JSON.stringify(pruned));
      console.warn('[scene-images] quota 满,LRU 淘汰旧场景图后保留 3 张');
    } catch {
      console.warn('[scene-images] LRU 淘汰后仍超 quota,本次写入放弃');
    }
  }
}

function makeKey(scenarioId: string, sceneId: string): string {
  return `${scenarioId}::${sceneId}`;
}

export function readSceneImage(scenarioId: string, sceneId: string): string | null {
  const k = makeKey(scenarioId, sceneId);
  const found = readMap()[k] ?? null;
  if (found) {
    // 更新 LRU 时间戳
    const meta = readMeta();
    meta[k] = Date.now();
    writeMeta(meta);
  }
  return found;
}

export function writeSceneImage(scenarioId: string, sceneId: string, dataUrl: string) {
  const k = makeKey(scenarioId, sceneId);
  const map = readMap();
  map[k] = dataUrl;
  writeMap(map);
  // 记 LRU 时间戳
  const meta = readMeta();
  meta[k] = Date.now();
  writeMeta(meta);
}

export function clearSceneImages() {
  writeMap({});
}

/**
 * 调 /api/local-sdxl 生场景图,失败抛错(调用方自己捕获)。
 * 默认 SDXL 参数偏快(steps=4, cfg=0.0)— 跟 NPC 立绘保持一致。
 * 这里允许调用方覆盖参数(比如想让场景图更精致可以 steps=8)。
 */
export async function generateSceneImage(
  imagePrompt: string,
  opts?: { steps?: number; cfg?: number; seed?: number; negative?: string },
): Promise<string> {
  const resp = await fetch('/api/local-sdxl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: imagePrompt,
      negative:
        opts?.negative ?? 'people, characters, faces, text, watermark, low quality, blurry',
      steps: opts?.steps ?? 4,
      seed: opts?.seed ?? 0,
      cfg: opts?.cfg ?? 0.0,
    }),
  });
  const text = await resp.text();
  let data: { dataUrl?: string; error?: string; detail?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  if (!resp.ok) {
    throw new Error(`${data.error ?? `HTTP ${resp.status}`}${data.detail ? ': ' + data.detail : ''}`);
  }
  if (!data.dataUrl) throw new Error('SDXL 响应缺 dataUrl');
  return data.dataUrl;
}

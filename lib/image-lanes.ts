/**
 * Custom Image Lanes — 用户自定义生图通道(对标 lib/custom-lanes.ts)
 * ================================================================
 *
 * 让用户在公网部署上自己接入任意 OpenAI Images API 兼容服务做立绘生成:
 *   - OpenAI(DALL-E 3 / gpt-image-1)
 *   - Together AI(FLUX 系列)
 *   - SiliconFlow(各家 SDXL/Kolors)
 *   - 阿里 DashScope(通义万相 OpenAI 兼容端点)
 *   - Azure OpenAI(DALL-E 3 部署)
 *   - 自建 vLLM-image / ComfyUI OpenAI adapter
 *
 * 跟 LLM custom lane 的差异:
 *   - 不进入 LLM router/fallback 矩阵 — 生图是单点任务,失败就失败,不自动切别条 lane
 *   - 没有内置 image lane(用户决定:0 条内置,纯靠 Custom Image Lane)
 *   - 独立的 localStorage key,跟 LLM lane 完全隔离
 *   - 多了 size / quality 两个生成参数(LLM 没有)
 *
 * Zero-knowledge:apiKey 跟 LLM lane 同一隐私模型 — 只浏览器 localStorage,
 * 经 /api/image-compat zero-knowledge proxy 转发,server 不持久化 / 不日志。
 */

import { createWriteState } from './store-write-helper';

// P1-#4 模式:写入失败暴露给 UI(避免静默吞 QuotaExceededError —
// 立绘 base64 ~1.3MB/张,5MB 配额下几张就满)
const imageLanesWriteState = createWriteState('image-lanes');
export const getImageLanesWriteError = () => imageLanesWriteState.lastError();
export const clearImageLanesWriteError = () => imageLanesWriteState.clearError();

export type ImageLaneProtocol = 'openai_images_compat';

/**
 * 立绘生成参数 — 都是可选,服务端各自有默认值。
 *
 * - size:OpenAI DALL-E 3 支持 '1024x1024' / '1024x1792' / '1792x1024',
 *   gpt-image-1 还多 '512x512' 等。Together FLUX 同 OpenAI 协议但接受任意 WxH。
 *   服务不支持的尺寸通常会报 invalid_request_error。
 *
 * - quality:仅 DALL-E 3 用 'standard'(便宜) / 'hd'(贵 2 倍但更清晰)。
 *   gpt-image-1 用 'low' / 'medium' / 'high' / 'auto'。其他服务多半忽略。
 */
export interface CustomImageLane {
  id: string; // 形如 'custom_image_dalle3'(不可改,作 ImageLaneId 用)
  label: string; // UI 长名
  shortLabel: string; // 立绘 Tab 下拉短名
  protocol: ImageLaneProtocol;
  baseUrl: string; // https://... 不带尾部 /v1
  model: string; // 'dall-e-3' / 'gpt-image-1' / 'black-forest-labs/FLUX.1-dev' / ...
  apiKey: string; // BYOK,只浏览器

  // ── 生成参数(可选,UI 默认值)──
  size?: string; // 默认 '1024x1024'
  quality?: string; // 默认服务自定,UI 给 'standard' / 'hd' / '' 三选项
  responseFormat?: 'b64_json' | 'url'; // 默认 'b64_json'(站点能直接写 localStorage)

  costNote?: string; // 用户备注,如 "$0.04/张 DALL-E 3 standard"
  createdAt: number;
}

const STORAGE_KEY = 'wc_poc_custom_image_lanes_v1';
const CUSTOM_IMAGE_LANE_PREFIX = 'custom_image_';

/**
 * 生成新 image lane id。基于 label 转 kebab + 随机后缀,前缀跟 LLM lane 区分。
 */
export function generateImageLaneId(label: string, existing: CustomImageLane[]): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const base = `${CUSTOM_IMAGE_LANE_PREFIX}${slug || 'lane'}`;
  if (!existing.some((l) => l.id === base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.some((l) => l.id === candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function isImageLaneId(id: string): boolean {
  return id.startsWith(CUSTOM_IMAGE_LANE_PREFIX);
}

// ─── 持久化 ────────────────────────────────────────────────────────

function readAll(): CustomImageLane[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidImageLane);
  } catch {
    return [];
  }
}

function writeAll(lanes: CustomImageLane[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lanes));
    imageLanesWriteState.reportSuccess();
  } catch (e) {
    imageLanesWriteState.reportFailure(e, '自定义 Image Lane 保存失败');
  }
}

function isValidImageLane(x: unknown): x is CustomImageLane {
  if (!x || typeof x !== 'object') return false;
  const l = x as Record<string, unknown>;
  return (
    typeof l.id === 'string' &&
    typeof l.label === 'string' &&
    typeof l.baseUrl === 'string' &&
    typeof l.model === 'string' &&
    typeof l.apiKey === 'string' &&
    typeof l.protocol === 'string'
  );
}

// ─── 公开 API ───────────────────────────────────────────────────────

export function listImageLanes(): CustomImageLane[] {
  return readAll();
}

export function getImageLane(id: string): CustomImageLane | undefined {
  return readAll().find((l) => l.id === id);
}

/**
 * 创建或更新 image lane。
 * - 传 id + 已存在 → 更新
 * - 传 id + 不存在 → 创建(用这个 id)
 * - 不传 id → 生成新 id,创建
 */
export function upsertImageLane(
  input: Omit<CustomImageLane, 'id' | 'createdAt' | 'shortLabel'> & {
    id?: string;
    shortLabel?: string;
  },
): CustomImageLane {
  const label = input.label.trim();
  if (!label) throw new Error('label 不能为空');
  if (!input.baseUrl.trim()) throw new Error('baseUrl 不能为空');
  if (!/^https:\/\//i.test(input.baseUrl)) throw new Error('baseUrl 必须 https:// 开头');
  if (!input.model.trim()) throw new Error('model 不能为空');
  if (!input.apiKey.trim()) throw new Error('apiKey 不能为空');

  const all = readAll();
  let id = input.id;
  if (!id) {
    id = generateImageLaneId(label, all);
  }

  const shortLabel = (input.shortLabel ?? label).slice(0, 12);
  const lane: CustomImageLane = {
    id,
    label,
    shortLabel,
    protocol: input.protocol,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    model: input.model.trim(),
    apiKey: input.apiKey.trim(),
    size: input.size?.trim() || undefined,
    quality: input.quality?.trim() || undefined,
    responseFormat: input.responseFormat ?? 'b64_json',
    costNote: input.costNote?.trim() || undefined,
    createdAt: all.find((l) => l.id === id)?.createdAt ?? Date.now(),
  };

  const existing = all.findIndex((l) => l.id === id);
  if (existing >= 0) {
    all[existing] = lane;
  } else {
    all.push(lane);
  }
  writeAll(all);
  return lane;
}

export function removeImageLane(id: string): void {
  const all = readAll();
  const next = all.filter((l) => l.id !== id);
  if (next.length !== all.length) writeAll(next);
}

// ─── 常见服务配置参考(给 UI 文档用,不在运行时引用)─────────────
//
// | 服务         | baseUrl                              | model 示例                                 |
// | OpenAI       | https://api.openai.com               | dall-e-3 / gpt-image-1                     |
// | Together     | https://api.together.xyz             | black-forest-labs/FLUX.1-dev               |
// | SiliconFlow  | https://api.siliconflow.cn           | Kwai-Kolors/Kolors                         |
// | DashScope    | https://dashscope.aliyuncs.com/compatible-mode | wanx-v1                          |
// | Azure        | https://YOUR.openai.azure.com        | 你的 DALL-E 3 部署名                       |
//
// 字段对照与生成约束在 USER_GUIDE 单独列出。

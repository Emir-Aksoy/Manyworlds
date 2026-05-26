/**
 * Custom Lanes — 用户自定义 LLM 通道
 * ==================================
 *
 * 让用户不限于内置的 codex_api / claude_byok / deepseek 这 3 条 BYOK lane,
 * 自己加任意 OpenAI 兼容服务(OpenRouter / Groq / SiliconFlow / Together /
 * Moonshot / 阿里通义 / 自建 vLLM / Ollama OpenAI 适配等)。
 *
 * 每条自定义 lane 包含:
 *   - id           运行时 lane 标识(custom_<random>),不能跟内置 lane 冲突
 *   - label        UI 显示名(用户填,如 "Groq Llama 70B")
 *   - shortLabel   矩阵 cell 显示(自动取 label 前 10 字)
 *   - protocol     调用方式(目前只 'openai_compat',未来可加 'anthropic_compat')
 *   - baseUrl      API base(https://, 不带尾部 /v1)
 *   - model        要传给 model 字段的精确名(因服务而异)
 *   - apiKey       BYOK key,只存浏览器 localStorage
 *   - costNote     可选备注(显示在健康卡片)
 *   - createdAt    创建时间
 *
 * 数据持久化:localStorage key `wc_poc_custom_lanes_v1`,整个数组一起 read/write。
 *
 * 安全:apiKey 跟内置 BYOK key 同一隐私模型 — 只在浏览器,经我们的 server-side
 * proxy(/api/openai-compat)中转一次,server 端不日志 / 不持久化。
 */

import { ALL_LANE_IDS } from './models';
import { createWriteState } from './store-write-helper';

// P1-#4:暴露 quota / 写入错误给 UI(自定义 lane 撞 5MB 时不再静默)
const customLanesWriteState = createWriteState('custom-lanes');
export const getCustomLanesWriteError = () => customLanesWriteState.lastError();
export const clearCustomLanesWriteError = () => customLanesWriteState.clearError();

export type CustomLaneProtocol = 'openai_compat';

export interface CustomLane {
  id: string; // 形如 'custom_groq_l70'(不可改,作 LaneId 用)
  label: string; // UI 长名
  shortLabel: string; // 矩阵短名
  protocol: CustomLaneProtocol;
  baseUrl: string; // https://... 不带尾部 /v1
  model: string; // 实际传给 API 的 model 字段
  apiKey: string; // BYOK,只浏览器
  costNote?: string; // 用户备注(可选)
  latencyHint?: 'fast' | 'mid' | 'slow';
  createdAt: number;
}

const STORAGE_KEY = 'wc_poc_custom_lanes_v1';

// ─── 内置 lane id 列表(用于碰撞检查 / is custom 判断)─────────────────
// P1-#2:从 models.ALL_LANE_IDS 派生,LANES 字典是唯一来源,加新内置 lane 不会漏改这里。

const BUILTIN_LANE_IDS = new Set<string>(ALL_LANE_IDS);

const CUSTOM_LANE_PREFIX = 'custom_';

export function isBuiltinLaneId(id: string): boolean {
  return BUILTIN_LANE_IDS.has(id);
}

export function isCustomLaneId(id: string): boolean {
  return id.startsWith(CUSTOM_LANE_PREFIX) && !BUILTIN_LANE_IDS.has(id);
}

/**
 * 生成新 lane id。基于用户 label 转 kebab + 随机后缀,确保全局唯一。
 */
export function generateCustomLaneId(label: string, existing: CustomLane[]): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const base = `${CUSTOM_LANE_PREFIX}${slug || 'lane'}`;
  if (!existing.some((l) => l.id === base)) return base;
  // 加随机后缀
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.some((l) => l.id === candidate)) return candidate;
  }
  // 兜底:时间戳
  return `${base}-${Date.now().toString(36)}`;
}

// ─── 持久化 ────────────────────────────────────────────────────────

function readAll(): CustomLane[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidCustomLane);
  } catch {
    return [];
  }
}

function writeAll(lanes: CustomLane[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lanes));
    customLanesWriteState.reportSuccess();
  } catch (e) {
    customLanesWriteState.reportFailure(e, '自定义 Lane 保存失败');
  }
}

function isValidCustomLane(x: unknown): x is CustomLane {
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

export function listCustomLanes(): CustomLane[] {
  return readAll();
}

export function getCustomLane(id: string): CustomLane | undefined {
  return readAll().find((l) => l.id === id);
}

/**
 * 创建或更新 custom lane。
 * - 传 id + 已存在 → 更新
 * - 传 id + 不存在 → 创建(用这个 id)
 * - 不传 id → 生成新 id,创建
 *
 * 返回 effective lane(含最终 id)。失败抛错。
 */
export function upsertCustomLane(input: Omit<CustomLane, 'id' | 'createdAt' | 'shortLabel'> & {
  id?: string;
  shortLabel?: string;
}): CustomLane {
  const label = input.label.trim();
  if (!label) throw new Error('label 不能为空');
  if (!input.baseUrl.trim()) throw new Error('baseUrl 不能为空');
  if (!/^https:\/\//i.test(input.baseUrl)) throw new Error('baseUrl 必须 https:// 开头');
  if (!input.model.trim()) throw new Error('model 不能为空');
  if (!input.apiKey.trim()) throw new Error('apiKey 不能为空');

  const all = readAll();
  let id = input.id;
  if (id) {
    if (isBuiltinLaneId(id)) throw new Error(`id 不能跟内置 lane 冲突: ${id}`);
  } else {
    id = generateCustomLaneId(label, all);
  }

  const shortLabel = (input.shortLabel ?? label).slice(0, 12);
  const lane: CustomLane = {
    id,
    label,
    shortLabel,
    protocol: input.protocol,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    model: input.model.trim(),
    apiKey: input.apiKey.trim(),
    costNote: input.costNote?.trim() || undefined,
    latencyHint: input.latencyHint,
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

export function removeCustomLane(id: string): void {
  const all = readAll();
  const next = all.filter((l) => l.id !== id);
  if (next.length !== all.length) writeAll(next);
}

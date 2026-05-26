/**
 * ModelGateway v2 (PoC)
 * =====================
 *
 * 主入口：
 *   callLLM(req, { task })   按任务标签路由到对应 Lane，并自动 fallback
 *   callClaude(req)          向后兼容包装（内部走 npc.core.dialogue）
 *
 * 关键设计：
 *   - 5 条 Lane（codex_bridge / codex_spark_bridge / codex_api / claude_bridge /
 *     claude_byok / deepseek / local_gemma），见 ./models.ts
 *   - 任务标签 → Lane 路由表，见 ./router.ts
 *   - Lane 不可用（缺凭证 / bridge 未启）时按 FALLBACK_CHAIN 自动降级
 *   - 内容审核统一在 callLLM 入口做（早期拦截，所有 Lane 受益）
 */

import { ALL_LANE_IDS, LaneId, LANES, TaskTag } from './models';
import { FALLBACK_CHAIN, getLaneFallbackChain, router } from './router';
import { createWriteState } from './store-write-helper';

// ─── 类型 ─────────────────────────────────────────────────────────────

export type Message = { role: 'user' | 'assistant'; content: string };

export interface ChatRequest {
  systemPrompt: string;
  messages: Message[];
  maxTokens?: number;
  /** 调用方显式锁定的 lane（绕过 task → router 解析）。 */
  forceLane?: LaneId;
  /** 任务标签——决定走哪条 Lane。默认 'npc.core.dialogue'。 */
  task?: TaskTag;
  temperature?: number;
  /** 调用方显式覆盖该 lane 的默认 model。 */
  model?: string;
}

export interface ChatResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  blocked?: { reason: string; crisisLine?: string };
  /** 实际使用的 lane（fallback 后可能不同于路由解析结果） */
  laneUsed?: LaneId;
  /** 经过的 fallback 链（按尝试顺序） */
  fallbackPath?: LaneId[];
  durationSec?: number;
}

// ─── KeyStore（支持多 provider）──────────────────────────────────────

const KEY_PREFIX = 'wc_poc_apikey_';
const BASE_PREFIX = 'wc_poc_apibase_';
export type Provider = 'anthropic' | 'openai' | 'deepseek';

// P1-#4:keyStore / prefStore 写入失败暴露给 UI(原本静默吞)
const keyStoreWriteState = createWriteState('keyStore');
const prefStoreWriteState = createWriteState('prefStore');
export const getKeyStoreWriteError = () => keyStoreWriteState.lastError();
export const clearKeyStoreWriteError = () => keyStoreWriteState.clearError();
export const getPrefStoreWriteError = () => prefStoreWriteState.lastError();
export const clearPrefStoreWriteError = () => prefStoreWriteState.clearError();

/**
 * 各 provider 的官方默认 base URL。设 base URL 时留空 = 用这些默认。
 * 注:不带尾部 / 和 /v1 等路径片段,由各 callVia 函数 / API route 拼接。
 */
export const DEFAULT_BASE_URLS: Record<Provider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  deepseek: 'https://api.deepseek.com',
};

export const keyStore = {
  set(provider: Provider, key: string) {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(KEY_PREFIX + provider, key);
      keyStoreWriteState.reportSuccess();
    } catch (e) {
      keyStoreWriteState.reportFailure(e, `${provider} API key 保存失败`);
    }
  },
  get(provider: Provider): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(KEY_PREFIX + provider);
  },
  clear(provider: Provider) {
    if (typeof window === 'undefined') return;
    // removeItem 不会撞 quota,无需 catch
    window.localStorage.removeItem(KEY_PREFIX + provider);
  },
  /**
   * 设置自定义 API base URL(BYOK 用户接 OpenRouter/Together/Groq 等 OpenAI 兼容服务时用)。
   * 留空 = 删除,回退到 DEFAULT_BASE_URLS。
   */
  setBaseUrl(provider: Provider, url: string) {
    if (typeof window === 'undefined') return;
    const trimmed = url.trim();
    if (trimmed) {
      try {
        window.localStorage.setItem(BASE_PREFIX + provider, trimmed);
        keyStoreWriteState.reportSuccess();
      } catch (e) {
        keyStoreWriteState.reportFailure(e, `${provider} base URL 保存失败`);
      }
    } else {
      window.localStorage.removeItem(BASE_PREFIX + provider);
    }
  },
  /**
   * 读自定义 base URL。返回 null = 用户没设(callVia / route 用 DEFAULT_BASE_URLS 兜底)。
   */
  getBaseUrl(provider: Provider): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(BASE_PREFIX + provider);
  },
  /**
   * 读 effective base URL(自定义优先,fallback 官方)。
   */
  getEffectiveBaseUrl(provider: Provider): string {
    return this.getBaseUrl(provider) ?? DEFAULT_BASE_URLS[provider];
  },
};

// ─── prefStore ──────────────────────────────────────────────────────

const PREF_KEY = 'wc_poc_pref_v1';

export type LlmMode = 'apikey' | 'bridge'; // 保留 v1 类型,但 v2 路由由 router 决定;此字段仅对 BYOK Anthropic Lane 内部生效（保留向后兼容）

export type UserPref = {
  anthropicModel?: string;
  llmMode?: LlmMode;
};

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';

export const prefStore = {
  get(): UserPref {
    if (typeof window === 'undefined') return {};
    try {
      const raw = window.localStorage.getItem(PREF_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as UserPref) : {};
    } catch {
      return {};
    }
  },
  set(pref: UserPref) {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(PREF_KEY, JSON.stringify(pref));
      prefStoreWriteState.reportSuccess();
    } catch (e) {
      prefStoreWriteState.reportFailure(e, '偏好设置保存失败');
    }
  },
};

// ─── Moderation ──────────────────────────────────────────────────────

const CRISIS_KEYWORDS = ['自杀', '自残', '想死', 'kill myself', 'end my life', 'self-harm'].map(
  (s) => s.toLowerCase(),
);
const HARD_BLOCKLIST = ['未成年人色情', 'CSAM', 'mickey mouse', 'harry potter'].map((s) =>
  s.toLowerCase(),
);

const CRISIS_LINES: Record<string, string> = {
  US: '988 (Suicide & Crisis Lifeline)',
  GB: 'Samaritans 116 123',
  JP: 'TELL Lifeline 03-5774-0992',
  KR: '1393',
  SG: 'SOS 1-767',
  MY: 'Befrienders KL 03-7627-2929',
  ID: '119 ext 8',
  TH: 'Samaritans Thailand 02-713-6793',
  VN: '1800 1567',
  PH: 'NCMH 0917-899-USAP',
  default: '请联系当地的心理援助热线（搜索引擎搜 "crisis hotline" + 你所在地区）',
};

function detectCrisisLine(): string {
  try {
    const lang = typeof navigator !== 'undefined' ? navigator.language : 'en';
    if (lang.startsWith('zh')) return CRISIS_LINES.MY;
    if (lang.startsWith('ja')) return CRISIS_LINES.JP;
    if (lang.startsWith('ko')) return CRISIS_LINES.KR;
  } catch {
    /* SSR */
  }
  return CRISIS_LINES.default;
}

function moderate(userText: string): { allow: boolean; reason?: string; crisisLine?: string } {
  const lower = userText.toLowerCase();
  if (CRISIS_KEYWORDS.some((k) => lower.includes(k))) {
    return { allow: false, reason: 'crisis', crisisLine: detectCrisisLine() };
  }
  if (HARD_BLOCKLIST.some((k) => lower.includes(k))) {
    return { allow: false, reason: 'hard_blocklist' };
  }
  return { allow: true };
}

// ─── 各 Lane 实现 ────────────────────────────────────────────────────

/**
 * Lane 调用结果。raw 字段保留 server route 原样数据,便于 UI 显示 lane / durationSec。
 */
interface LaneCallResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  durationSec?: number;
}

class LaneUnavailableError extends Error {
  constructor(public laneId: LaneId, message: string) {
    super(message);
    this.name = 'LaneUnavailableError';
  }
}

/**
 * 通用 OpenAI 兼容代理调用。所有"标准 OpenAI /v1/chat/completions"协议的 lane —
 * deepseek / codex_api / 以及用户自定义 lane —— 全部走这一个 helper + 单一后端
 * route(/api/openai-compat)。
 *
 * 设计:
 *   - 前端把 endpoint 信息(apiKey/baseUrl/model)显式传过来,server 端不再
 *     维护 provider 专属的 default,这样 deepseek 官方端点跟 OpenRouter/Together/
 *     Groq/自建 vLLM 同源处理。
 *   - laneId 仅用于错误日志 + LaneUnavailableError;调用本身不依赖 lane 元数据。
 *
 * 性价比说明:这个 helper 替换掉了之前 3 个 70-80 行的 callViaXxx,合计净减约 100 行,
 * 同时让 /api/deepseek 和 /api/openai-codex 两个 route 退役(Vercel 释放 2 个 lambda slot)。
 */
async function callOpenaiCompat(args: {
  laneId: LaneId;
  apiKey: string;
  baseUrl: string; // 完整 https://api.x.com,不带 /v1
  model: string;
  /** 错误信息里显示的友好名(custom lane 显示用户起的 label) */
  laneLabel?: string;
  req: ChatRequest;
}): Promise<LaneCallResult> {
  const { laneId, apiKey, baseUrl, model, laneLabel, req } = args;
  const display = laneLabel ?? laneId;

  let resp: Response;
  try {
    resp = await fetch('/api/openai-compat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Wc-Base-Url': baseUrl,
      },
      body: JSON.stringify({
        systemPrompt: req.systemPrompt,
        messages: req.messages,
        maxTokens: req.maxTokens ?? 1024,
        temperature: req.temperature,
        model,
      }),
    });
  } catch (err) {
    throw new LaneUnavailableError(
      laneId,
      `${display} 不可达: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const data = await resp.json();
  if (!resp.ok) {
    if (resp.status === 401) {
      throw new LaneUnavailableError(laneId, `${display}: API key 无效`);
    }
    if (
      resp.status === 502 ||
      resp.status === 503 ||
      resp.status === 504 ||
      resp.status === 429
    ) {
      throw new LaneUnavailableError(
        laneId,
        `${display} ${resp.status}: ${data.error ?? 'unknown'} ${data.detail ?? ''}`.trim(),
      );
    }
    throw new Error(`${display} ${resp.status}: ${data.error ?? 'unknown'} ${data.detail ?? ''}`);
  }
  return {
    text: data.text ?? '',
    usage: {
      inputTokens: data.usage?.inputTokens ?? 0,
      outputTokens: data.usage?.outputTokens ?? 0,
    },
    durationSec: data.durationSec,
  };
}

async function callViaLocalGemma(req: ChatRequest): Promise<LaneCallResult> {
  const resp = await fetch('/api/local-gemma', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemPrompt: req.systemPrompt,
      messages: req.messages,
      maxTokens: req.maxTokens ?? 1024,
      temperature: req.temperature,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    if (resp.status === 503) {
      throw new LaneUnavailableError('local_gemma', `Gemma 不可用: ${data.error}`);
    }
    throw new Error(`Gemma ${resp.status}: ${data.error ?? 'unknown'} ${data.detail ?? ''}`);
  }
  return {
    text: data.text ?? '',
    usage: { inputTokens: 0, outputTokens: 0 }, // Gemma 不返回 token 数
    durationSec: data.durationSec,
  };
}

async function callViaDeepSeek(req: ChatRequest): Promise<LaneCallResult> {
  const key = keyStore.get('deepseek');
  if (!key)
    throw new LaneUnavailableError('deepseek', 'DeepSeek API key 未设置（Settings → 凭证）');
  return callOpenaiCompat({
    laneId: 'deepseek',
    apiKey: key,
    baseUrl: keyStore.getEffectiveBaseUrl('deepseek'),
    model: req.model ?? 'deepseek-chat',
    laneLabel: 'DeepSeek',
    req,
  });
}

async function callViaCodexBridge(req: ChatRequest, spark: boolean): Promise<LaneCallResult> {
  // 默认 model：主池 gpt-5.5（ChatGPT 订阅下能用的当前主 model;gpt-5.3 在订阅下不支持），
  // Spark 池 gpt-5.3-codex-spark。
  const model = req.model ?? (spark ? 'gpt-5.3-codex-spark' : 'gpt-5.5');
  let resp: Response;
  try {
    resp = await fetch('/api/local-codex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemPrompt: req.systemPrompt,
        messages: req.messages,
        maxTokens: req.maxTokens ?? 1024,
        model,
      }),
    });
  } catch (err) {
    throw new LaneUnavailableError(
      spark ? 'codex_spark_bridge' : 'codex_bridge',
      `Codex Bridge 不可达: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const data = await resp.json();
  if (!resp.ok) {
    // S5 修复:把所有 5xx 都视为 lane 暂不可用,让 fallback 链能跑。
    // 旧实现只认 503,但实际 codex CLI 子进程退出超时会返回 502/504,
    // 用户截图里那个 "failed to refresh available models: timeout waiting for child process to exit"
    // 就是 502,fallback 完全断了。改成 502/503/504/408/429 全部 LaneUnavailable。
    if (
      resp.status === 502 ||
      resp.status === 503 ||
      resp.status === 504 ||
      resp.status === 408 ||
      resp.status === 429
    ) {
      throw new LaneUnavailableError(
        spark ? 'codex_spark_bridge' : 'codex_bridge',
        `Codex Bridge ${resp.status}: ${data.error ?? 'unknown'} ${data.hint ?? ''} ${data.detail ?? ''}`.trim(),
      );
    }
    throw new Error(`Codex Bridge ${resp.status}: ${data.error ?? 'unknown'} ${data.detail ?? ''}`);
  }
  return {
    text: data.text ?? '',
    usage: { inputTokens: 0, outputTokens: 0 },
    durationSec: data.durationSec,
  };
}

async function callViaCodexApi(req: ChatRequest): Promise<LaneCallResult> {
  const key = keyStore.get('openai');
  if (!key) throw new LaneUnavailableError('codex_api', 'OpenAI API key 未设置（Settings → 凭证）');
  return callOpenaiCompat({
    laneId: 'codex_api',
    apiKey: key,
    baseUrl: keyStore.getEffectiveBaseUrl('openai'),
    model: req.model ?? 'gpt-5.2-codex',
    laneLabel: 'OpenAI Codex',
    req,
  });
}

async function callViaClaudeBridge(req: ChatRequest): Promise<LaneCallResult> {
  let resp: Response;
  try {
    resp = await fetch('/api/local-claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemPrompt: req.systemPrompt,
        messages: req.messages,
        maxTokens: req.maxTokens ?? 1024,
        model: req.model ?? prefStore.get().anthropicModel ?? DEFAULT_ANTHROPIC_MODEL,
      }),
    });
  } catch (err) {
    throw new LaneUnavailableError(
      'claude_bridge',
      `Claude Bridge 不可达: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const data = await resp.json();
  if (!resp.ok) {
    // S5 修复:所有 5xx + 401 + 408/429 都让 fallback 接管(跟 codex bridge 对齐)
    if (
      resp.status === 401 ||
      resp.status === 408 ||
      resp.status === 429 ||
      resp.status === 502 ||
      resp.status === 503 ||
      resp.status === 504
    ) {
      throw new LaneUnavailableError(
        'claude_bridge',
        `Claude Bridge ${resp.status}: ${data.error ?? 'unknown'} ${data.hint ?? ''}`,
      );
    }
    throw new Error(`Claude Bridge ${resp.status}: ${data.error ?? 'unknown'} ${data.detail ?? ''}`);
  }
  return {
    text: data.text ?? '',
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
    durationSec: data.durationSec,
  };
}

async function callViaClaudeBYOK(req: ChatRequest): Promise<LaneCallResult> {
  const apiKey = keyStore.get('anthropic');
  if (!apiKey) throw new LaneUnavailableError('claude_byok', 'Anthropic API key 未设置');

  const model = req.model ?? prefStore.get().anthropicModel ?? DEFAULT_ANTHROPIC_MODEL;
  // BYOK-BASE:用户可在 Settings 改 Anthropic base URL(接 Anthropic 兼容 proxy)。
  // 留空 = 走官方 api.anthropic.com。
  const baseUrl = keyStore.getEffectiveBaseUrl('anthropic');
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 1024,
        system: req.systemPrompt,
        messages: req.messages,
      }),
    });
  } catch (err) {
    throw new LaneUnavailableError(
      'claude_byok',
      `Anthropic 直调失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 401) throw new LaneUnavailableError('claude_byok', 'Anthropic 401: key 无效');
    if (resp.status === 404 || /model[_ ]not[_ ]found|invalid.*model/i.test(text)) {
      throw new Error(
        `Anthropic 404: 模型 "${model}" 不可用。改 Settings → Anthropic Model 字段，比如 claude-sonnet-4-5-20250929`,
      );
    }
    throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const text =
    data.content?.find((b: { type: string; text?: string }) => b.type === 'text')?.text ?? '';
  return {
    text,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
}

// ─── Custom Lane(用户在 ModelsTab 自定义的 OpenAI 兼容 lane)─────────

async function callViaCustomLane(laneId: string, req: ChatRequest): Promise<LaneCallResult> {
  // 动态 require 避免循环依赖(custom-lanes 不 import gateway,gateway 也不静态 import custom-lanes)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getCustomLane } = require('./custom-lanes') as typeof import('./custom-lanes');
  const lane = getCustomLane(laneId);
  if (!lane) {
    throw new LaneUnavailableError(laneId, `custom lane ${laneId} 不存在(可能已被删除)`);
  }
  if (!lane.apiKey) {
    throw new LaneUnavailableError(laneId, `custom lane "${lane.label}" 缺 API key`);
  }
  if (!lane.baseUrl) {
    throw new LaneUnavailableError(laneId, `custom lane "${lane.label}" 缺 baseUrl`);
  }
  return callOpenaiCompat({
    laneId,
    apiKey: lane.apiKey,
    baseUrl: lane.baseUrl,
    // req.model 优先(单次调用可覆盖),否则用 lane 默认 model
    model: req.model ?? lane.model,
    laneLabel: lane.label,
    req,
  });
}

// ─── 主入口：callLLM ──────────────────────────────────────────────

import type { BuiltinLaneId } from './models';

const LANE_CALLERS: Record<BuiltinLaneId, (req: ChatRequest) => Promise<LaneCallResult>> = {
  local_gemma: callViaLocalGemma,
  deepseek: callViaDeepSeek,
  codex_bridge: (req) => callViaCodexBridge(req, false),
  codex_spark_bridge: (req) => callViaCodexBridge(req, true),
  codex_api: callViaCodexApi,
  claude_bridge: callViaClaudeBridge,
  claude_byok: callViaClaudeBYOK,
};

export async function callLLM(req: ChatRequest): Promise<ChatResponse> {
  // 1) 统一审核
  const allUserText = req.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');
  const mod = moderate(allUserText);
  if (!mod.allow) {
    return {
      text:
        mod.reason === 'crisis'
          ? `（我想我们应该停下来一会儿。如果你正在经历困难，请尝试联系信任的人，或拨打 ${mod.crisisLine}。）`
          : '（这个话题我们不能继续。）',
      usage: { inputTokens: 0, outputTokens: 0 },
      blocked: { reason: mod.reason!, crisisLine: mod.crisisLine },
    };
  }

  // 2) 解析目标 lane
  const task = req.task ?? 'npc.core.dialogue';
  const primaryLane = req.forceLane ?? (typeof window !== 'undefined' ? router.resolveLane(task) : 'local_gemma');

  // 3) 组装 fallback 链：primary → task 级 → lane 级兜底（去重）
  //    task 级是用户在 ModelsTab 里配的（默认 ['codex_bridge'] / public 模式默认 ['deepseek']）
  //    lane 级是 getLaneFallbackChain(primaryLane),按运行模式分支:
  //      - dev:    完整 FALLBACK_CHAIN(含 bridge / local_gemma 兜底)
  //      - public: 仅 BYOK lane 之间降级(deepseek/codex_api/claude_byok)
  const taskFallback = typeof window !== 'undefined' ? router.getTaskFallback(task) : [];
  const laneFallback = typeof window !== 'undefined' ? getLaneFallbackChain(primaryLane) : (FALLBACK_CHAIN[primaryLane as BuiltinLaneId] ?? []);
  const seen = new Set<LaneId>();
  const chain: LaneId[] = [];
  for (const lane of [primaryLane, ...taskFallback, ...laneFallback]) {
    if (!seen.has(lane)) {
      seen.add(lane);
      chain.push(lane);
    }
  }

  const tried: LaneId[] = [];
  let lastError: Error | null = null;

  for (const lane of chain) {
    tried.push(lane);
    // custom lane:走通用 OpenAI 兼容代理(/api/openai-compat),lane 定义里自带 baseUrl/model/key
    let caller: (r: ChatRequest) => Promise<LaneCallResult>;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isCustomLaneId } = require('./custom-lanes') as typeof import('./custom-lanes');
    if (isCustomLaneId(lane)) {
      caller = (r) => callViaCustomLane(lane, r);
    } else {
      const builtinCaller = LANE_CALLERS[lane as BuiltinLaneId];
      if (!builtinCaller) {
        lastError = new Error(`unknown lane ${lane}`);
        continue;
      }
      caller = builtinCaller;
    }
    try {
      const started = Date.now();
      const result = await caller(req);
      return {
        ...result,
        laneUsed: lane,
        fallbackPath: tried,
        durationSec: result.durationSec ?? (Date.now() - started) / 1000,
      };
    } catch (err) {
      if (err instanceof LaneUnavailableError) {
        // 继续往 fallback 走
        lastError = err;
        continue;
      }
      // 真错误（不是 unavailable）—— 直接抛
      throw err;
    }
  }

  throw new Error(
    `所有 lane 都不可用（尝试了 ${tried.join(' → ')}）。最后错误：${lastError?.message ?? '未知'}`,
  );
}

// ─── 向后兼容：callClaude(req) ────────────────────────────────────────

/** @deprecated 用 callLLM 代替。这个保留只为不破坏现有 ChatTab。 */
export async function callClaude(req: ChatRequest): Promise<ChatResponse> {
  return callLLM({ ...req, task: req.task ?? 'npc.core.dialogue' });
}

// ─── Lane 健康检查 ───────────────────────────────────────────────────

export type LaneHealth = {
  laneId: LaneId;
  ok: boolean;
  reason?: string; // 'no_key' | 'bridge_unreachable' | 'server_down' | 'ok'
  detail?: string;
};

export async function checkLaneHealth(laneId: LaneId): Promise<LaneHealth> {
  const def = LANES[laneId as keyof typeof LANES];
  if (!def) {
    // custom lane:不做 server-side 探活(各家 endpoint 不同),只标记"已配置"
    return { laneId, ok: true, reason: 'ok', detail: 'Custom lane (未探活)' };
  }
  // 凭证检查（不需要发起请求就能判断）
  if (def.requires.apiKey === 'anthropic' && !keyStore.get('anthropic')) {
    return { laneId, ok: false, reason: 'no_key', detail: '缺 Anthropic API key' };
  }
  if (def.requires.apiKey === 'openai' && !keyStore.get('openai')) {
    return { laneId, ok: false, reason: 'no_key', detail: '缺 OpenAI API key' };
  }
  if (def.requires.apiKey === 'deepseek' && !keyStore.get('deepseek')) {
    return { laneId, ok: false, reason: 'no_key', detail: '缺 DeepSeek API key' };
  }

  // Bridge / 本地服务探活
  // P1-#2 注:deepseek/codex_api/claude_byok 都不再 probe。
  // 它们的健康度等价于"key 存在与否"(在上面 def.requires.apiKey 检查时已经判过),
  // 而且 /api/deepseek 和 /api/openai-codex 这两个 route 已经合入 /api/openai-compat,
  // 不再独立暴露 GET 探活端点。BYOK 网络可用性等到真发请求时再决定 fallback。
  const probeUrl =
    laneId === 'claude_bridge'
      ? '/api/local-claude'
      : laneId === 'codex_bridge' || laneId === 'codex_spark_bridge'
        ? '/api/local-codex'
        : laneId === 'local_gemma'
          ? '/api/local-gemma'
          : null;

  if (!probeUrl) {
    // deepseek / codex_api / claude_byok 都走这里:key 已通过即视作 ok
    return { laneId, ok: true };
  }

  try {
    const resp = await fetch(probeUrl, { method: 'GET' });
    const data = await resp.json();
    if (!data.reachable && !data.ok) {
      return {
        laneId,
        ok: false,
        reason: 'bridge_unreachable',
        detail: data.detail ?? '未启动',
      };
    }
    // bridge 还需要进一步看里面的状态
    if (
      laneId === 'claude_bridge' &&
      data.reachable &&
      (!data.sdkLoaded || !data.hasOauthToken)
    ) {
      const miss = [];
      if (!data.sdkLoaded) miss.push('SDK 包未装');
      if (!data.hasOauthToken) miss.push('OAuth token 未配置');
      return { laneId, ok: false, reason: 'bridge_unconfigured', detail: miss.join('；') };
    }
    if ((laneId === 'codex_bridge' || laneId === 'codex_spark_bridge') && !data.codexAvailable) {
      return { laneId, ok: false, reason: 'bridge_unconfigured', detail: data.codexError ?? 'codex CLI 不可用' };
    }
    return { laneId, ok: true };
  } catch (err) {
    return {
      laneId,
      ok: false,
      reason: 'server_down',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkAllLanes(): Promise<Record<LaneId, LaneHealth>> {
  // P1-#2:用 ALL_LANE_IDS 派生,避免与 models.ts LANES 字典脱节(加新 lane 不再漏改)
  const ids: LaneId[] = [...ALL_LANE_IDS];
  const results = await Promise.all(ids.map((id) => checkLaneHealth(id)));
  return Object.fromEntries(results.map((r) => [r.laneId, r])) as Record<LaneId, LaneHealth>;
}

// 向后兼容：旧的 checkBridgeHealth（指 Claude bridge）
export type BridgeHealth = {
  ok: boolean;
  reachable: boolean;
  sdkLoaded?: boolean;
  hasOauthToken?: boolean;
  sdkLoadError?: string | null;
  port?: number;
  detail?: string;
};

export async function checkBridgeHealth(): Promise<BridgeHealth> {
  try {
    const resp = await fetch('/api/local-claude', { method: 'GET' });
    if (!resp.ok) return { ok: false, reachable: false, detail: `HTTP ${resp.status}` };
    return (await resp.json()) as BridgeHealth;
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── 立绘 Prompt 导出（unchanged）──────────────────────────────────

export function exportImagePrompt(input: {
  characterId: string;
  context: string;
  basePrompt: string;
  negativePrompt?: string;
}) {
  return {
    type: 'wc_image_prompt_v1' as const,
    purpose: 'companion_portrait' as const,
    characterId: input.characterId,
    context: input.context,
    mainPrompt: input.basePrompt,
    negativePrompt: input.negativePrompt ?? 'deformed, extra limbs, lowres',
    styleHints: {
      preset: 'starmail_default',
      aspectRatio: '3:4',
      recommendedModel: 'flux-1.1-pro on fal.ai',
    },
    referenceImages: [],
    exportedAt: new Date().toISOString(),
  };
}

// ─── 记忆固化（按任务标签路由）─────────────────────────────────

export async function consolidateMemory(args: {
  worldId: string;
  companionName: string;
  episodicEvents: string[];
}): Promise<{ semantic: string[]; summary: string; laneUsed?: LaneId }> {
  if (args.episodicEvents.length === 0) {
    return { semantic: [], summary: '（这次没什么值得记下的事。）' };
  }

  const systemPrompt = `你正在帮一个名叫"${args.companionName}"的 AI 队友固化这次冒险的记忆。

你的任务：
1. 从下面的事件列表中，提炼出 1–3 条"性格演化结论"（semantic memory），用第一人称、简短陈述
2. 写一段不超过 80 字的本次冒险总结（summary）

返回 JSON 格式（严格）：
{
  "semantic": ["...", "..."],
  "summary": "..."
}`;

  const userText =
    `世界：${args.worldId}\n队友：${args.companionName}\n本次事件：\n` +
    args.episodicEvents.map((e, i) => `${i + 1}. ${e}`).join('\n');

  const resp = await callLLM({
    systemPrompt,
    messages: [{ role: 'user', content: userText }],
    maxTokens: 512,
    task: 'memory.consolidate',
  });

  try {
    const jsonMatch = resp.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        semantic: Array.isArray(parsed.semantic) ? parsed.semantic : [],
        summary: typeof parsed.summary === 'string' ? parsed.summary : resp.text,
        laneUsed: resp.laneUsed,
      };
    }
  } catch {
    /* fall through */
  }
  return { semantic: [], summary: resp.text || '（记忆固化失败。）', laneUsed: resp.laneUsed };
}

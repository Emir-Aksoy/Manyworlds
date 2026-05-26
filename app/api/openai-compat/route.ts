/**
 * POST /api/openai-compat
 *
 * 通用 OpenAI 兼容代理 — 给"用户自定义 Lane"用。
 *
 * 跟 /api/deepseek 和 /api/openai-codex 的差异:
 *   - base URL **必填**(从 X-Wc-Base-Url header 拿,不像那俩有 fallback default)
 *   - model **必填**(每个 custom lane 自带,不像那俩有内置默认 model)
 *   - 协议假设标准 OpenAI `/v1/chat/completions`(POST,Authorization Bearer,
 *     OpenAI 兼容的 request/response 格式)
 *
 * Zero-knowledge:apiKey 从 Authorization: Bearer 头从前端 localStorage 传过来,
 * server 不持久化、不日志、只做一次转发。
 *
 * 适配的服务范围:
 *   OpenRouter / Together / Groq / SiliconFlow / Moonshot / DeepSeek / Fireworks /
 *   Azure OpenAI / 阿里通义 OpenAI 兼容端点 / 自建 vLLM / Ollama (OpenAI adapter) / ...
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveCustomBaseUrlSafely } from '../../../lib/api-base-resolver';

type ChatBody = {
  systemPrompt?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  temperature?: number;
  model: string; // 必填(对 custom lane 没有兜底)
};

export async function POST(req: NextRequest) {
  const startedAt = Date.now();

  // key 从 Authorization 头传(BYOK,server 不存)
  const auth = req.headers.get('authorization') ?? '';
  const apiKey = auth.replace(/^Bearer\s+/i, '').trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'missing API key', hint: '在 ModelsTab → 自定义 Lane 填一个 key' },
      { status: 401 },
    );
  }

  // baseUrl 从 X-Wc-Base-Url 头传,必填(custom lane 没有 server-side default)
  let baseUrl: string;
  try {
    const url = req.headers.get('x-wc-base-url')?.trim();
    if (!url) {
      return NextResponse.json(
        { error: 'missing X-Wc-Base-Url header', hint: 'custom lane 必须传 baseUrl' },
        { status: 400 },
      );
    }
    baseUrl = await resolveCustomBaseUrlSafely(req, url);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: 'messages required' }, { status: 400 });
  }
  if (!body.model?.trim()) {
    return NextResponse.json(
      { error: 'model required', hint: 'custom lane 必须自带 model 名(各服务命名不同)' },
      { status: 400 },
    );
  }

  // 拼装 OpenAI-format messages
  const openaiMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  if (body.systemPrompt) openaiMessages.push({ role: 'system', content: body.systemPrompt });
  for (const m of body.messages) openaiMessages.push({ role: m.role, content: m.content });

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: body.model,
        messages: openaiMessages,
        max_tokens: Math.max(1, Math.min(8192, Number(body.maxTokens) || 1024)),
        temperature: Number.isFinite(body.temperature) ? body.temperature : 0.7,
        stream: false,
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: '调用 custom lane 失败',
        detail: err instanceof Error ? err.message : String(err),
        baseUrl,
      },
      { status: 503 },
    );
  }

  const text = await upstream.text();
  let data: {
    error?: { message?: string; code?: string };
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    data = JSON.parse(text);
  } catch {
    return NextResponse.json(
      {
        error: `custom lane 响应非 JSON (HTTP ${upstream.status})`,
        detail: text.slice(0, 300),
      },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    return NextResponse.json(
      {
        error: `custom lane ${upstream.status}`,
        detail: data.error?.message ?? text.slice(0, 300),
        code: data.error?.code,
      },
      { status: upstream.status },
    );
  }

  return NextResponse.json({
    text: data.choices?.[0]?.message?.content ?? '',
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
    durationSec: (Date.now() - startedAt) / 1000,
    lane: 'openai_compat',
  });
}

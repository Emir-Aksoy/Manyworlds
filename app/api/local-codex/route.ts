/**
 * POST /api/local-codex
 *
 * 转发到本机 Codex Bridge（默认 127.0.0.1:8766）。
 * 让 PoC 通过用户的 `codex` CLI 消耗 ChatGPT Pro 订阅的 Codex 主池 / Spark 独立池。
 *
 * 见 /poc/scripts/codex_bridge.mjs。
 */

import { NextRequest, NextResponse } from 'next/server';
import { devOnlyGuard } from '../../../lib/dev-only-guard';

const BRIDGE_BASE = process.env.WC_CODEX_BRIDGE_URL ?? 'http://127.0.0.1:8766';

type ChatBody = {
  systemPrompt?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  model?: string;
};

export async function POST(req: NextRequest) {
  const blocked = devOnlyGuard();
  if (blocked) return blocked;
  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: 'messages required' }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${BRIDGE_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: '无法连接 Codex Bridge。请先 `node poc/scripts/codex_bridge.mjs`，确认 8766 端口可达。',
        detail: err instanceof Error ? err.message : String(err),
        bridgeUrl: BRIDGE_BASE,
      },
      { status: 503 },
    );
  }

  const text = await upstream.text();
  let data: { error?: string; detail?: string; hint?: string; text?: string; durationSec?: number };
  try {
    data = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: `bridge 返回非 JSON (HTTP ${upstream.status})`, detail: text.slice(0, 300) },
      { status: 502 },
    );
  }
  if (!upstream.ok) return NextResponse.json(data, { status: upstream.status });
  return NextResponse.json(data);
}

export async function GET() {
  const blocked = devOnlyGuard();
  if (blocked) return blocked;
  try {
    const resp = await fetch(`${BRIDGE_BASE}/health`, { signal: AbortSignal.timeout(2_000) });
    const health = await resp.json();
    return NextResponse.json({ ok: !!health.ok, reachable: true, ...health });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      reachable: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      Allow: 'POST, GET, OPTIONS',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

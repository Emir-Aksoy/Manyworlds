/**
 * POST /api/local-claude
 *
 * 把请求转发到本机的 Claude Agent SDK Bridge（默认 127.0.0.1:8765），
 * 让 PoC 经由用户本机的 OAuth token 调用 Anthropic，从而消耗 Claude 订阅的
 * Agent SDK Credit 池（Pro $20 / Max 5x $100 / Max 20x $200 / 月，
 * 2026-06-15 生效，月底清零）。
 *
 * 详细启动流程见 /poc/scripts/claude_bridge.mjs 文件头注释，
 * 以及 /tech/Claude-Agent-SDK-Bridge-接入指南.md。
 */

import { NextRequest, NextResponse } from 'next/server';
import { devOnlyGuard } from '../../../lib/dev-only-guard';

const BRIDGE_BASE = process.env.WC_BRIDGE_URL ?? 'http://127.0.0.1:8765';

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
      // Agent SDK 首响应可能稍慢（model + agentic loop init）
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error:
          '无法连接本机 Claude Bridge。请先在另一个终端运行 `node poc/scripts/claude_bridge.mjs`，并确认 8765 端口可访问。',
        detail: msg,
        bridgeUrl: BRIDGE_BASE,
      },
      { status: 503 },
    );
  }

  const text = await upstream.text();
  let data: { error?: string; detail?: string; hint?: string; text?: string; usage?: unknown; durationSec?: number };
  try {
    data = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: `bridge 返回非 JSON (HTTP ${upstream.status})`, detail: text.slice(0, 300) },
      { status: 502 },
    );
  }

  // 把 bridge 的错误如实回传（保留 hint 字段，前端可以显示给用户）
  if (!upstream.ok) {
    return NextResponse.json(data, { status: upstream.status });
  }

  return NextResponse.json(data);
}

export async function GET() {
  const blocked = devOnlyGuard();
  if (blocked) return blocked;
  // 探活：让前端能"健康检查"bridge 是否在跑，决定要不要 enable "Bridge 模式"按钮
  let upstream: Response;
  try {
    upstream = await fetch(`${BRIDGE_BASE}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2_000),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, reachable: false, detail: err instanceof Error ? err.message : String(err) },
      { status: 200 },
    );
  }
  try {
    const health = await upstream.json();
    return NextResponse.json({ ok: !!health.ok, reachable: true, ...health }, { status: 200 });
  } catch {
    return NextResponse.json(
      { ok: false, reachable: true, detail: 'bridge 健康端点返回非 JSON' },
      { status: 200 },
    );
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

/**
 * POST /api/local-gemma
 *
 * 转发到本机 Gemma 4 E4B MLX（同一个 Gradio 服务 :7860 上的 /respond 端点）。
 *
 * Gradio /respond 参数（11 个，其中 2 个 State 在 /info 里看不到必须补 null）：
 *   [0] 输入 (str)
 *   [1] 图片 (filepath | null)
 *   [2] history (list[ChatMessage])      ← 这一项暂传 []，我们把历史拼到输入里
 *   [3] System (str)
 *   [4] max_tokens (float, 默认 512, 上限 4096)
 *   [5] temperature (float, 默认 0.2)
 *   [6] max_kv_size (float, 默认 4096)
 *   [7] 自动压缩会话 (bool, 默认 true)
 *   [8] 保留最近轮数 (float, 默认 6)
 *   [9] State (空字符串占位)
 *   [10] State (空字符串占位)
 */

import { NextRequest, NextResponse } from 'next/server';
import { devOnlyGuard } from '../../../lib/dev-only-guard';

const GEMMA_UI = process.env.GEMMA_UI_BASE ?? 'http://127.0.0.1:7860';

type ChatBody = {
  systemPrompt?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  temperature?: number;
};

export async function POST(req: NextRequest) {
  const blocked = devOnlyGuard();
  if (blocked) return blocked;
  const startedAt = Date.now();

  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: 'messages required' }, { status: 400 });
  }

  // Gemma /respond 是 chatbot 模式 + history list。但 Gradio 的 history schema
  // 字段又长又复杂，我们把整段历史拼成单个 user prompt 给它，最稳。
  const userText = body.messages
    .map((m) => `[${m.role === 'user' ? '用户' : '助手'}] ${m.content}`)
    .join('\n');

  // 数值兜底
  const maxTokens = Number.isFinite(body.maxTokens) ? Math.max(1, Math.min(4096, body.maxTokens!)) : 1024;
  const temperature = Number.isFinite(body.temperature) ? body.temperature : 0.6;

  const payload = {
    data: [
      userText, // 0 输入
      null, // 1 图片
      [], // 2 history (空,因为我们把历史拼进了输入)
      body.systemPrompt ?? '你是一个简洁、准确的中文助手。', // 3 System
      maxTokens, // 4 max_tokens
      temperature, // 5 temperature
      8192, // 6 max_kv_size（比默认 4096 大一些,给长对话留余地）
      true, // 7 自动压缩
      6, // 8 保留最近轮数
      '', // 9 State
      '', // 10 State
    ],
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${GEMMA_UI}/gradio_api/run/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error:
          '无法连接本地 Gemma UI。请先双击 Start-Gemma4.command，确认 http://127.0.0.1:7860 可访问。',
        detail: msg,
      },
      { status: 503 },
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    return NextResponse.json(
      { error: `gradio ${upstream.status}`, detail: text.slice(0, 500) },
      { status: 502 },
    );
  }

  let raw: { data?: unknown[]; error?: string };
  try {
    raw = (await upstream.json()) as typeof raw;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: 'gradio 响应解析失败', detail: msg }, { status: 502 });
  }

  if (raw.error) {
    return NextResponse.json({ error: 'gradio handler error', detail: String(raw.error).slice(0, 500) }, { status: 502 });
  }

  // 提取最后一条 assistant 回复
  const data = raw.data ?? [];
  const history = (data[0] as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> | string }>) ?? [];
  let answer = '';
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg && msg.role === 'assistant') {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && c.type === 'text' && typeof c.text === 'string') {
            answer += c.text;
          }
        }
      } else if (typeof content === 'string') {
        answer = content;
      }
      break;
    }
  }

  return NextResponse.json({
    text: answer,
    usage: null, // Gemma 不返回 token 计数；前端用估算或不显示
    durationSec: (Date.now() - startedAt) / 1000,
    lane: 'local_gemma',
    contextEstimate: typeof data[3] === 'string' ? (data[3] as string) : null,
  });
}

export async function GET() {
  const blocked = devOnlyGuard();
  if (blocked) return blocked;
  // 探活：直接 ping Gradio 根目录
  try {
    const resp = await fetch(`${GEMMA_UI}/config`, { signal: AbortSignal.timeout(2_000) });
    return NextResponse.json({ ok: resp.ok, reachable: true, status: resp.status });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      reachable: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

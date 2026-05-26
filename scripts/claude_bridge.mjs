#!/usr/bin/env node
/**
 * Claude Agent SDK Bridge
 * =======================
 *
 * 把本机 Claude Agent SDK 暴露为 http://127.0.0.1:8765 上的最小 HTTP 接口，
 * 让 Manyworlds（Next.js 跑在 :3000）通过 /api/local-claude 转发调用，
 * 进而消耗你 Claude 订阅的「Agent SDK Credit 池」（Pro $20 / Max 5x $100 / Max 20x $200，
 * 每月清零，按 API 标价扣费；2026-06-15 生效）。
 *
 * 为什么不能让浏览器直连？
 *   - OAuth token 是个人凭证。放浏览器 = 暴露 token + 违反 Anthropic ToS。
 *   - 必须本机进程持有 token，HTTP-only 服务给本机的前端用。
 *
 * 前置 (2026-06-15 生效后)：
 *   1) npm i -g @anthropic-ai/claude-code            # 装 CLI
 *   2) claude setup-token                             # 浏览器登录 → 拿 1 年 OAuth token
 *   3) cd poc && npm i @anthropic-ai/claude-agent-sdk
 *   4) export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
 *      （或者写进 poc/.env.local；本脚本会自动读）
 *   5) node scripts/claude_bridge.mjs                # 启动 bridge
 *
 * 关键：必须 unset ANTHROPIC_API_KEY 和 ANTHROPIC_AUTH_TOKEN，否则 SDK 优先级会
 * 走 API key（扣 Console pay-as-you-go 余额）而不是 OAuth（扣 Agent SDK 池）。
 * 本脚本启动时会强制 unset 这两个变量并打印告警。
 *
 * 仅限个人单机用——不要把 :8765 暴露到 LAN 或者公网（违反 ToS）。
 */

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.WC_BRIDGE_PORT ?? 8765);
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env.local');

// ─── 加载 .env.local（最小解析；不依赖 dotenv 包）─────────────────────────────

if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, k, vRaw] = m;
    // 去掉单/双引号
    const v = vRaw.replace(/^["'](.*)["']$/, '$1');
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

// ─── 强制走 OAuth 路径 ─────────────────────────────────────────────────────

const interferingVars = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const removed = [];
for (const v of interferingVars) {
  if (process.env[v]) {
    removed.push(v);
    delete process.env[v];
  }
}
if (removed.length) {
  console.warn(
    `[bridge] ⚠ 已临时 unset ${removed.join(', ')}，否则 Agent SDK 会优先走 API key 扣 Console 余额而不是 Agent SDK Credit 池。`,
  );
}

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error(
    '[bridge] ❌ 没找到 CLAUDE_CODE_OAUTH_TOKEN。请先跑：\n' +
      '          npm i -g @anthropic-ai/claude-code\n' +
      '          claude setup-token\n' +
      '        然后把输出的 token 写进 poc/.env.local：\n' +
      '          CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...\n' +
      '        注意：Agent SDK Credit 池 2026-06-15 才生效；今天提前装也是空跑的。',
  );
  // 不立即退出——允许 health endpoint 仍可被 PoC 探测到 bridge 在跑但未授权
}

// ─── 动态加载 Agent SDK（可能未安装，给友好错误）────────────────────────────

/** @type {undefined | ((args: any) => AsyncIterable<any>)} */
let sdkQuery;
let sdkLoadError = null;

try {
  const mod = await import('@anthropic-ai/claude-agent-sdk');
  sdkQuery = mod.query;
} catch (err) {
  sdkLoadError = err instanceof Error ? err.message : String(err);
  console.warn(
    `[bridge] ⚠ 还没装 @anthropic-ai/claude-agent-sdk。bridge 会启动，但 /chat 会返回 503，直到你装好它：\n` +
      `          cd poc && npm i @anthropic-ai/claude-agent-sdk\n` +
      `        当前错误：${sdkLoadError}`,
  );
}

// ─── HTTP 服务 ────────────────────────────────────────────────────────────

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // 只允许同机 PoC 来源；多增一道防线，避免 LAN 上别的设备误用
    'Access-Control-Allow-Origin': 'http://localhost:3000',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('payload too large (>2MB)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // 只接受 localhost loopback 流量
  const remote = req.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    return send(res, 403, { error: 'only localhost allowed' });
  }

  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, {
      ok: true,
      sdkLoaded: !!sdkQuery,
      sdkLoadError,
      hasOauthToken: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
      port: PORT,
      ts: Date.now(),
    });
  }

  if (req.method === 'POST' && req.url === '/chat') {
    if (!sdkQuery) {
      return send(res, 503, {
        error: 'agent sdk not installed',
        detail: sdkLoadError,
        hint: 'cd poc && npm i @anthropic-ai/claude-agent-sdk',
      });
    }
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return send(res, 401, {
        error: 'no oauth token',
        hint: '先跑 `claude setup-token`，然后把输出写进 poc/.env.local',
      });
    }

    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return send(res, 400, { error: 'invalid JSON', detail: String(err) });
    }

    const {
      systemPrompt = '',
      messages = [],
      maxTokens = 1024,
      model, // 不传则让 SDK 用 Claude Code 默认
    } = body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return send(res, 400, { error: 'messages required' });
    }

    // Agent SDK 当前 API 是 query({ prompt, options }) 单 prompt + agentic loop。
    // 我们的 PoC 是 chat completion 用法——所以把整个 history 拼成一段 prompt 给它。
    // （注意：6-15 上线后请根据 SDK 实际签名调整；本结构是 2026-05 时的最佳猜测，
    //  已留出最小修改面：只动这块拼装 + 下面的 for await 处理就行。）
    const prompt = [
      systemPrompt && `# System\n${systemPrompt}`,
      ...messages.map((m) => `# ${m.role === 'user' ? 'User' : 'Assistant'}\n${m.content}`),
    ]
      .filter(Boolean)
      .join('\n\n');

    const options = {
      // 禁止 agentic 工具，让它纯做 chat 回复——避免 SDK 自作主张去读你磁盘 / 跑 bash
      allowedTools: [],
      maxThinkingTokens: 0,
      ...(model ? { model } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      // PoC 用，不需要 multi-turn agent 状态
    };

    const started = Date.now();
    let fullText = '';
    let usage = null;
    try {
      for await (const msg of sdkQuery({ prompt, options })) {
        // SDK 流式消息有几种 type：'system' / 'assistant' / 'user' / 'result'
        // 实际字段可能因 SDK 版本变动；这里做最宽松的兼容性处理。
        if (msg?.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              fullText += block.text;
            }
          }
        } else if (msg?.type === 'result' && msg.usage) {
          usage = msg.usage;
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return send(res, 502, { error: 'agent sdk call failed', detail });
    }

    return send(res, 200, {
      text: fullText,
      usage,
      durationSec: (Date.now() - started) / 1000,
      mode: 'bridge',
    });
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(
    `[bridge] listening on http://${HOST}:${PORT}\n` +
      `         endpoints: GET /health   POST /chat\n` +
      `         oauth_token: ${process.env.CLAUDE_CODE_OAUTH_TOKEN ? '✓ loaded' : '✗ MISSING'}\n` +
      `         agent_sdk:   ${sdkQuery ? '✓ loaded' : '✗ not installed'}\n` +
      `         credit pool: Agent SDK ($20/$100/$200/月)，2026-06-15 生效`,
  );
});

// 优雅关闭
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[bridge] ${sig} received, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  });
}

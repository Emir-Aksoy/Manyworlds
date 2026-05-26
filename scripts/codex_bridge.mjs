#!/usr/bin/env node
/**
 * Codex CLI Bridge
 * ================
 *
 * 让 PoC 通过本机 `codex` CLI 走 ChatGPT Pro 订阅的 Codex 5h/7d 池
 * （以及 Codex-Spark 独立池），不走 OpenAI API key 的 pay-as-you-go。
 *
 * 跟 claude_bridge.mjs 同款架构：
 *   - 监听 127.0.0.1:8766（Claude 是 8765，Codex 是 8766）
 *   - POST /chat 转发到 `codex exec` 子进程（non-interactive 模式）
 *   - GET /health 健康检查
 *   - 只接受 loopback 流量
 *
 * 前置：
 *   1) npm i -g @openai/codex                  # 装 codex CLI
 *   2) codex login                              # 用 ChatGPT Pro 账号登录
 *   3) node poc/scripts/codex_bridge.mjs        # 启 bridge
 *
 * 用法（PoC 内）：
 *   - Settings → 模型路由 → 任务选 Codex 主池 / Spark
 *   - bridge 不可用时 ModelGateway 会自动降级到 codex_api（如填了 OpenAI key）
 *     或 deepseek / local_gemma
 *
 * 仅限个人单机用——不要把 :8766 暴露到 LAN 或公网。
 *
 * 重要警告：codex CLI 的 `exec` 子命令 / non-interactive 接口可能因版本而异。
 * 当前实现是 best-effort，2026-05-17 用户实际接入时可能需要根据 codex 版本调整
 * spawnArgs。如果 codex 版本变化，主要改 buildCodexArgs() 函数即可。
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.WC_CODEX_BRIDGE_PORT ?? 8766);
const CODEX_BIN = process.env.WC_CODEX_BIN ?? 'codex';
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env.local');

// ─── 加载 .env.local ──────────────────────────────────────────────────

if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, k, vRaw] = m;
    const v = vRaw.replace(/^["'](.*)["']$/, '$1');
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

// ─── 强制走 OAuth 订阅池 ────────────────────────────────────────────

// codex CLI 优先级：OPENAI_API_KEY > OAuth session。
// 想消耗订阅池必须 unset OPENAI_API_KEY。
const interferingVars = ['OPENAI_API_KEY', 'OPENAI_API_BASE'];
const removed = [];
for (const v of interferingVars) {
  if (process.env[v]) {
    removed.push(v);
    delete process.env[v];
  }
}
if (removed.length) {
  console.warn(
    `[codex-bridge] ⚠ 已临时 unset ${removed.join(', ')}，否则 codex CLI 会优先走 API key（pay-as-you-go）而不是订阅池。`,
  );
}

// ─── codex CLI 探活 ────────────────────────────────────────────────

async function checkCodexAvailable() {
  return new Promise((resolve) => {
    const p = spawn(CODEX_BIN, ['--version'], { stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (c) => (out += c.toString()));
    p.stderr.on('data', (c) => (out += c.toString()));
    p.on('error', () => resolve({ available: false, error: `cannot spawn ${CODEX_BIN}` }));
    p.on('close', (code) => {
      if (code === 0) resolve({ available: true, version: out.trim().slice(0, 100) });
      else resolve({ available: false, error: `exit ${code}: ${out.trim().slice(0, 200)}` });
    });
    setTimeout(() => {
      p.kill();
      resolve({ available: false, error: 'spawn timeout' });
    }, 3000);
  });
}

let codexInfo = await checkCodexAvailable();
if (!codexInfo.available) {
  console.warn(
    `[codex-bridge] ⚠ 没找到 codex CLI 或无法运行。\n` +
      `   错误：${codexInfo.error}\n` +
      `   修复：npm i -g @openai/codex && codex login\n` +
      `   bridge 会启动但 /chat 会返回 503 直到 CLI 就位。`,
  );
}

// ─── codex exec 参数构造 ───────────────────────────────────────────

/**
 * 构造 `codex exec` 的命令行参数（针对 codex-cli ≥ 0.130 的 API）。
 *
 * 关键 flags：
 *   --skip-git-repo-check    允许在非 git 目录跑（PoC 工作区可能不是 repo）
 *   --sandbox read-only      只读 sandbox（我们只 chat，不需要让 codex 跑 shell）
 *   --model <name>           选模型（含 'gpt-5.3-codex-spark' 跑 Spark 池）
 *   --output-last-message F  把最终回复写到文件，stdout 留给 events log
 *   -                        从 stdin 读 prompt
 *
 * @param {string} model
 * @param {string} outputFile
 */
function buildCodexArgs(model, outputFile) {
  return [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--model',
    model,
    '--output-last-message',
    outputFile,
    '-', // prompt 从 stdin 读
  ];
}

// ─── HTTP 服务 ────────────────────────────────────────────────────

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
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
        reject(new Error('payload too large'));
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

async function runCodex(model, fullPrompt) {
  return new Promise((resolve, reject) => {
    // 用 tmp 文件接最终回复（codex --output-last-message 写文件,stdout 是 event log）
    const outputFile = path.join(os.tmpdir(), `codex_wc_${process.pid}_${Date.now()}.txt`);
    const args = buildCodexArgs(model, outputFile);
    const proc = spawn(CODEX_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    proc.stderr.on('data', (c) => (stderr += c.toString('utf8')));

    let done = false;
    proc.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
    proc.on('close', (code) => {
      if (done) return;
      done = true;
      if (code === 0) {
        // 读 output-last-message 文件
        let answer = '';
        try {
          answer = readFileSync(outputFile, 'utf8');
          unlinkSync(outputFile);
        } catch {
          // 文件读失败,fallback 用 stdout
          answer = stdout;
        }
        resolve({ text: answer.trim(), stderr, eventsLog: stdout });
      } else {
        reject(
          new Error(
            `codex exit ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`,
          ),
        );
      }
    });

    // 通过 stdin 喂 prompt
    proc.stdin.write(fullPrompt);
    proc.stdin.end();

    // 120s 兜底
    const killer = setTimeout(() => {
      proc.kill('SIGTERM');
      if (!done) {
        done = true;
        reject(new Error('codex call timeout (120s)'));
      }
    }, 120_000);
    killer.unref();
  });
}

const server = http.createServer(async (req, res) => {
  const remote = req.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    return send(res, 403, { error: 'only localhost allowed' });
  }

  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (req.method === 'GET' && req.url === '/health') {
    // 重新探一次,而不是用启动时的缓存(用户可能中途装了)
    codexInfo = await checkCodexAvailable();
    return send(res, 200, {
      ok: codexInfo.available,
      reachable: true,
      codexAvailable: codexInfo.available,
      codexVersion: codexInfo.version,
      codexError: codexInfo.error,
      hasOpenaiApiKey: !!process.env.OPENAI_API_KEY, // 这里应该是 false（启动时被 unset）
      port: PORT,
      ts: Date.now(),
    });
  }

  if (req.method === 'POST' && req.url === '/chat') {
    if (!codexInfo.available) {
      // 重新探一次再决定
      codexInfo = await checkCodexAvailable();
      if (!codexInfo.available) {
        return send(res, 503, {
          error: 'codex CLI not available',
          detail: codexInfo.error,
          hint: 'npm i -g @openai/codex && codex login',
        });
      }
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
      model = 'gpt-5.5', // 默认走主池;调用方可传 'gpt-5.3-codex-spark' 走 Spark 池
    } = body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return send(res, 400, { error: 'messages required' });
    }

    // 把 history 拼成 markdown 风格的 single prompt
    const prompt =
      [
        systemPrompt && `# System\n${systemPrompt}`,
        ...messages.map(
          (m) => `# ${m.role === 'user' ? 'User' : 'Assistant'}\n${m.content}`,
        ),
        '# Assistant',
      ]
        .filter(Boolean)
        .join('\n\n') + '\n';

    const started = Date.now();
    try {
      const { text, stderr } = await runCodex(model, prompt);
      return send(res, 200, {
        text,
        stderr: stderr ? stderr.slice(0, 500) : undefined,
        durationSec: (Date.now() - started) / 1000,
        mode: 'bridge',
        lane: model.includes('spark') ? 'codex_spark_bridge' : 'codex_bridge',
        model,
      });
    } catch (err) {
      return send(res, 502, {
        error: 'codex call failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(
    `[codex-bridge] listening on http://${HOST}:${PORT}\n` +
      `         endpoints: GET /health   POST /chat\n` +
      `         codex CLI: ${codexInfo.available ? '✓ ' + (codexInfo.version || '') : '✗ ' + codexInfo.error}\n` +
      `         credit pool: ChatGPT Pro 5h+7d 主池 + Spark 独立池`,
  );

  // ── Spark warm-up ─────────────────────────────────────────────────
  // codex CLI v0.130.x 有个 known issue：spark 池 第一次冷启动时,
  // 内部的 codex_models_manager 子进程会卡 20s 才返回 "failed to refresh
  // available models: timeout waiting for child process to exit",首请求必挂。
  // 这里 bridge 起来后 5 秒,自己跑一次最小 prompt 把 spark 状态预热好,
  // 之后用户真请求过来就是热路径。
  // 不想要这个 warm-up 就 export WC_CODEX_SKIP_WARMUP=1。
  if (!codexInfo.available || process.env.WC_CODEX_SKIP_WARMUP === '1') return;
  setTimeout(async () => {
    const sparkModel = 'gpt-5.3-codex-spark';
    console.log(`[codex-bridge] warm-up: 预热 ${sparkModel}（首次约需 20-40s,失败不影响正常使用）...`);
    const started = Date.now();
    try {
      await runCodex(sparkModel, 'Reply with just "ok".\n');
      console.log(
        `[codex-bridge] ✓ spark warm-up ok (${((Date.now() - started) / 1000).toFixed(1)}s)`,
      );
    } catch (err) {
      console.warn(
        `[codex-bridge] ⚠ spark warm-up 失败（不致命,主池/降级链仍可用）: ${
          err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
        }`,
      );
    }
  }, 5000).unref();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[codex-bridge] ${sig} received, shutting down...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  });
}

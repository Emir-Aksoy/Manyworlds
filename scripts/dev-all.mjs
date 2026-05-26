#!/usr/bin/env node
/**
 * 一键启动 Manyworlds 所需的 4 个服务：
 *   1) Gemma UI (Gradio :7860)  — 本地 Gemma 4 + SDXL
 *   2) Codex bridge (:8766)     — ChatGPT Pro 订阅池 (gpt-5.5 / gpt-5.3-codex-spark)
 *   3) Claude bridge (:8765)    — Claude Max Agent SDK 池（2026-06-15 才生效，先占位）
 *   4) Next.js dev (:3000)      — PoC 前端
 *
 * 行为：
 *   - 已在跑的端口会 skip 启动（不冲突），但仍然等它 ready
 *   - 自己 spawn 的进程在 Ctrl-C 时会被优雅 SIGTERM
 *   - 外部进程不会被杀（你自己手动启的不归我管）
 *
 * 用法：
 *   npm run dev:all
 *
 * 环境变量（可选）：
 *   WC_GEMMA_DIR         Gemma UI 项目根 (默认 /Users/emiraksoy/Documents/Codex/2026-04-30/mlx-gemma4-e4b)
 *   WC_GEMMA_PYTHON      Gemma venv python (默认 <GEMMA_DIR>/.venv-mlx312/bin/python)
 *   WC_SKIP_GEMMA=1      不启 Gemma（已经手动跑了或不需要本地模型）
 *   WC_SKIP_CODEX=1      不启 Codex bridge
 *   WC_SKIP_CLAUDE=1     不启 Claude bridge（6-15 前 stub 状态，可省）
 *   WC_SKIP_NEXT=1       不启 Next dev
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { existsSync } from 'node:fs';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const POC_ROOT = path.resolve(__dirname, '..');

const GEMMA_DIR = process.env.WC_GEMMA_DIR ?? '/Users/emiraksoy/Documents/Codex/2026-04-30/mlx-gemma4-e4b';
const GEMMA_PY = process.env.WC_GEMMA_PYTHON ?? path.join(GEMMA_DIR, '.venv-mlx312/bin/python');

// ─── ANSI 颜色前缀 ───────────────────────────────────────────────────

const COLOR = {
  gemma: '\x1b[36m', //  cyan
  codex: '\x1b[33m', //  yellow
  claude: '\x1b[34m', // blue
  next: '\x1b[35m', //   magenta
  ok: '\x1b[32m', //     green
  warn: '\x1b[33m', //   yellow
  err: '\x1b[31m', //    red
  dim: '\x1b[2m', //     dim
  reset: '\x1b[0m',
};

function paintPrefix(name) {
  const col = COLOR[name] ?? '';
  return `${col}[${name.padEnd(6)}]${COLOR.reset} `;
}

/** 把 child 的 stdout/stderr 行前加色标。 */
function pipeWithPrefix(name, child) {
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout?.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) process.stdout.write(paintPrefix(name) + line + '\n');
    }
  });
  child.stderr?.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) process.stderr.write(paintPrefix(name) + line + '\n');
    }
  });
}

// ─── 端口探测 ────────────────────────────────────────────────────────

function isPortListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host, timeout: 1000 });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function waitReady(probeUrl, timeoutMs, name) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    try {
      const resp = await fetch(probeUrl, { signal: AbortSignal.timeout(2_000) });
      // 任何 < 500 的 HTTP 状态都算可达（Next root 是 200，Gradio /config 是 200，bridge /health 是 200）
      if (resp.status < 500) {
        return { ok: true, attempts };
      }
    } catch {
      /* fetch failed, retry */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return { ok: false, attempts };
}

// ─── 服务定义 ────────────────────────────────────────────────────────

const services = [];

if (!process.env.WC_SKIP_GEMMA) {
  services.push({
    name: 'gemma',
    label: 'Gemma UI (Gradio + SDXL)',
    port: 7860,
    probe: 'http://127.0.0.1:7860/config',
    timeoutMs: 60_000,
    preflight() {
      if (!existsSync(GEMMA_DIR)) {
        return `Gemma 项目目录不存在: ${GEMMA_DIR}\n           设 WC_SKIP_GEMMA=1 跳过，或设 WC_GEMMA_DIR=...`;
      }
      if (!existsSync(GEMMA_PY)) {
        return `Gemma Python venv 不存在: ${GEMMA_PY}`;
      }
      return null;
    },
    spawn() {
      return spawn(GEMMA_PY, ['app.py', '--host', '127.0.0.1', '--port', '7860'], {
        cwd: GEMMA_DIR,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
  });
}

if (!process.env.WC_SKIP_CODEX) {
  services.push({
    name: 'codex',
    label: 'Codex bridge (gpt-5.5 / Spark)',
    port: 8766,
    probe: 'http://127.0.0.1:8766/health',
    timeoutMs: 15_000,
    preflight() {
      return null;
    },
    spawn() {
      return spawn('node', ['scripts/codex_bridge.mjs'], {
        cwd: POC_ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
  });
}

if (!process.env.WC_SKIP_CLAUDE) {
  services.push({
    name: 'claude',
    label: 'Claude bridge (Agent SDK 池, 6-15 才生效)',
    port: 8765,
    probe: 'http://127.0.0.1:8765/health',
    timeoutMs: 15_000,
    preflight() {
      return null;
    },
    spawn() {
      return spawn('node', ['scripts/claude_bridge.mjs'], {
        cwd: POC_ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
  });
}

if (!process.env.WC_SKIP_NEXT) {
  services.push({
    name: 'next',
    label: 'Next.js dev (PoC 前端)',
    port: 3000,
    probe: 'http://localhost:3000',
    timeoutMs: 30_000,
    preflight() {
      return null;
    },
    spawn() {
      return spawn('npx', ['next', 'dev'], {
        cwd: POC_ROOT,
        env: { ...process.env, FORCE_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
  });
}

// ─── 主流程 ──────────────────────────────────────────────────────────

const spawnedChildren = []; // 我们自己起的进程,Ctrl-C 时杀掉

async function startAll() {
  console.log(`${COLOR.ok}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLOR.reset}`);
  console.log(`${COLOR.ok}Manyworlds · 一键启动${COLOR.reset}`);
  console.log(`${COLOR.ok}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLOR.reset}`);
  console.log('');

  // 1) 先打印计划
  for (const svc of services) {
    const inUse = await isPortListening(svc.port);
    svc._external = inUse;
    const status = inUse ? `${COLOR.dim}已在跑 (外部进程,不接管生命周期)${COLOR.reset}` : '将启动';
    console.log(`  ${paintPrefix(svc.name)}${svc.label}  :${svc.port}  ${status}`);
  }
  console.log('');

  // 2) Preflight 检查
  for (const svc of services) {
    if (svc._external) continue;
    const err = svc.preflight();
    if (err) {
      console.error(`${COLOR.err}[${svc.name}] preflight 失败：${COLOR.reset}\n           ${err}\n`);
      console.error(`${COLOR.err}aborting.${COLOR.reset}`);
      process.exit(1);
    }
  }

  // 3) Spawn 自己负责的服务
  for (const svc of services) {
    if (svc._external) continue;
    try {
      const child = svc.spawn();
      svc._child = child;
      spawnedChildren.push({ name: svc.name, child });
      pipeWithPrefix(svc.name, child);
      child.on('exit', (code, sig) => {
        if (shuttingDown) {
          // 我们自己主动杀的,不算意外
          console.log(`${COLOR.dim}  ${svc.name} stopped (code=${code}, sig=${sig})${COLOR.reset}`);
          return;
        }
        console.error(
          `${COLOR.err}[${svc.name}] exited unexpectedly (code=${code}, signal=${sig})${COLOR.reset}`,
        );
        // 一个服务挂了,其它也一起退 —— 否则用户看不到 dev 环境其实坏了一半
        shutdownAll(1);
      });
    } catch (err) {
      console.error(
        `${COLOR.err}[${svc.name}] spawn failed: ${err instanceof Error ? err.message : String(err)}${COLOR.reset}`,
      );
      shutdownAll(1);
      return;
    }
  }

  // 4) 探活
  console.log(`${COLOR.dim}-- 等待所有服务 ready --${COLOR.reset}`);
  const probes = services.map(async (svc) => {
    const started = Date.now();
    const result = await waitReady(svc.probe, svc.timeoutMs, svc.name);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (result.ok) {
      console.log(
        `  ${COLOR.ok}✓${COLOR.reset} ${paintPrefix(svc.name)}ready (${elapsed}s, ${result.attempts} probes)`,
      );
    } else {
      console.error(
        `  ${COLOR.err}✗${COLOR.reset} ${paintPrefix(svc.name)}timeout after ${elapsed}s (${result.attempts} probes)`,
      );
    }
    return result.ok;
  });
  const oks = await Promise.all(probes);
  if (!oks.every(Boolean)) {
    console.error('');
    console.error(`${COLOR.err}部分服务未能 ready,看上面的 [name] 日志找原因。${COLOR.reset}`);
    shutdownAll(1);
    return;
  }

  // 5) 完成
  console.log('');
  console.log(`${COLOR.ok}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLOR.reset}`);
  console.log(`${COLOR.ok}全部就绪。打开 http://localhost:3000${COLOR.reset}`);

  if (spawnedChildren.length === 0) {
    // 全是外部进程,没有 child 要托管 —— 立即退出
    console.log(
      `${COLOR.dim}${services.length} 个服务都是外部进程,dev:all 不接管它们的生命周期,直接退出。${COLOR.reset}`,
    );
    console.log(
      `${COLOR.dim}下次要重启某个进程时,先 kill 它再跑 \`npm run dev:all\`。${COLOR.reset}`,
    );
    console.log(`${COLOR.ok}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLOR.reset}`);
    console.log('');
    process.exit(0);
  }

  console.log(
    `${COLOR.dim}托管中: ${spawnedChildren.map((c) => c.name).join(', ')} · Ctrl-C 优雅退出${COLOR.reset}`,
  );
  console.log(`${COLOR.ok}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLOR.reset}`);
  console.log('');
}

// ─── 优雅关闭 ────────────────────────────────────────────────────────

let shuttingDown = false;
function shutdownAll(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (spawnedChildren.length === 0) {
    process.exit(code);
  }
  console.log(`\n${COLOR.dim}-- 正在关闭 ${spawnedChildren.length} 个子进程… --${COLOR.reset}`);
  for (const { name, child } of spawnedChildren) {
    if (child.killed) continue;
    try {
      child.kill('SIGTERM');
      console.log(`  ${COLOR.dim}sent SIGTERM to ${name} (pid ${child.pid})${COLOR.reset}`);
    } catch {
      /* already gone */
    }
  }

  // 5s 后强制 SIGKILL
  const killer = setTimeout(() => {
    for (const { name, child } of spawnedChildren) {
      if (!child.killed) {
        try {
          child.kill('SIGKILL');
          console.log(`  ${COLOR.err}SIGKILL ${name}${COLOR.reset}`);
        } catch {
          /* ignore */
        }
      }
    }
    process.exit(code);
  }, 5_000);

  // 全退完了就立刻 exit
  let exited = 0;
  for (const { child } of spawnedChildren) {
    child.once('exit', () => {
      exited++;
      if (exited === spawnedChildren.length) {
        clearTimeout(killer);
        process.exit(code);
      }
    });
  }
}

process.on('SIGINT', () => shutdownAll(0));
process.on('SIGTERM', () => shutdownAll(0));
process.on('uncaughtException', (err) => {
  console.error(`${COLOR.err}uncaught: ${err.stack ?? err}${COLOR.reset}`);
  shutdownAll(1);
});

startAll().catch((err) => {
  console.error(`${COLOR.err}startAll failed: ${err.stack ?? err}${COLOR.reset}`);
  shutdownAll(1);
});

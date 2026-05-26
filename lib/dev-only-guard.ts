/**
 * Dev-Only API Route Guard
 * =========================
 *
 * `/api/local-*` 系列 route(local-claude / local-codex / local-gemma / local-sdxl)
 * 转发到本机 127.0.0.1:8765 / 8766 / 7860 上的 bridge / Gradio 进程,
 * **只在本机 dev 模式下可用**。
 *
 * 但 Next.js App Router 会按 `app/api/` 目录自动注册所有 route,导致它们在
 * Vercel / Netlify production 部署时也会被打成 lambda 函数,占用 Hobby plan
 * 的 12 个函数 slot 中的 4 个,并且每次调用都因为容器内部无法访问 127.0.0.1
 * 而必然返回 503——纯属浪费。
 *
 * 这个 guard 让 dev-only route 在 production NODE_ENV 下直接 early-return 404。
 *
 * Escape hatch:
 *   - 本机想跑 `npm run build && npm start` 测试 prod build 但仍需 local bridge?
 *     设环境变量 WC_ALLOW_LOCAL_API=1 即可解开守卫。
 */

import { NextResponse } from 'next/server';

export function devOnlyGuard(): NextResponse | null {
  // Next.js dev server: NODE_ENV === 'development'
  if (process.env.NODE_ENV !== 'production') return null;
  // 本机 prod build escape hatch
  if (process.env.WC_ALLOW_LOCAL_API === '1') return null;
  return NextResponse.json(
    {
      error: 'dev-only API route',
      hint: '此 endpoint 依赖本机 127.0.0.1 上的 Gradio / bridge,只在 dev 模式可用。公网部署版的等价能力请在前端用 BYOK lane(/api/deepseek、/api/openai-codex、/api/openai-compat)。',
    },
    { status: 404 },
  );
}

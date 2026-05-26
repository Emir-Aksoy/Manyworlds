/**
 * Prebuild — 在 Vercel build 时把 dev-only API route 从 app/ 目录隐藏。
 * =========================================================
 *
 * P1-#7:Vercel App Router 会扫描 `app/api/` 下所有 route.ts,每个都打成
 * lambda 函数(Hobby plan 上限 12 个)。我们有 4 个 `local-*` route 依赖本机
 * 127.0.0.1:8765/7860 的桥/Gradio 进程,公网部署上必然 404(P0 dev-only-guard 已守住),
 * 但 lambda 仍占 slot —— 浪费 4/12 的配额。
 *
 * Next.js 14 没有原生的"per-route exclude from build"机制。`outputFileTracingExcludes`
 * 只能减小单个 lambda 的 bundle 大小,不能阻止 route 注册。
 *
 * 这个脚本利用 **Next.js 私有目录约定**(以 `_` 开头的目录不会被识别为 route)
 * 在 Vercel build 时把 4 个 local-* 目录改名移走,Next 扫不到 = 不打 lambda。
 *
 * 触发条件:
 *   - 只在 Vercel CI 环境运行(检测 process.env.VERCEL === '1')
 *   - 本机 `npm run build`、`npm run dev` 完全不受影响
 *
 * Vercel CI 每次都是干净 clone,所以不需要 postbuild 恢复 —— 改名只对本次 build 生效。
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

if (!process.env.VERCEL) {
  console.log('[prebuild-exclude-dev-routes] 非 Vercel 环境,跳过(本机 build 保留所有 dev route)');
  process.exit(0);
}

const ROUTES_TO_EXCLUDE = ['local-claude', 'local-codex', 'local-gemma', 'local-sdxl'];
const stagingRoot = join(projectRoot, 'app/api/_disabled-on-vercel');

mkdirSync(stagingRoot, { recursive: true });

let moved = 0;
for (const r of ROUTES_TO_EXCLUDE) {
  const src = join(projectRoot, 'app/api', r);
  const dst = join(stagingRoot, r);
  if (existsSync(src) && !existsSync(dst)) {
    renameSync(src, dst);
    console.log(`[prebuild-exclude-dev-routes] 隐藏 app/api/${r} → app/api/_disabled-on-vercel/${r}`);
    moved += 1;
  }
}
console.log(
  `[prebuild-exclude-dev-routes] 完成 — 移走 ${moved}/${ROUTES_TO_EXCLUDE.length} 个 dev-only route。` +
    `Vercel 这次 build 将只打 ${ROUTES_TO_EXCLUDE.length === moved ? 'BYOK' : '剩余'} route 的 lambda。`,
);

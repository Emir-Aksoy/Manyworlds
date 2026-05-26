/**
 * POST /api/local-sdxl
 *
 * Lane A 本地版：通过本地 Gemma UI（127.0.0.1:7860）暴露的 Gradio HTTP API
 * 调 SDXL Turbo 生成图片。
 *
 * 前置：用户需要先双击 Start-Gemma4.command 启动 Gemma UI。
 *
 * 这条路径在 PoC 里替代了"BYOK 直连 Fal.ai"——因为用户机器上已有 SDXL
 * 本地推理能力，平台层面不需要付任何 token，也不需要 API key。
 *
 * 安全：图片不再通过本地路径直接 readFile（防止 Gradio 响应被污染时任意文件读取），
 * 而是用 Gradio 自己暴露的 `/gradio_api/file=...` URL 反向 fetch，再返回 dataURL。
 */

import { NextRequest, NextResponse } from 'next/server';
import { devOnlyGuard } from '../../../lib/dev-only-guard';

const GEMMA_UI = process.env.GEMMA_UI_BASE ?? 'http://127.0.0.1:7860';

type Body = {
  prompt: string;
  negative?: string;
  steps?: number;
  cfg?: number;
  seed?: number;
  nImages?: number;
  quantize?: boolean;
  autoRelease?: boolean;
};

export async function POST(req: NextRequest) {
  const blocked = devOnlyGuard();
  if (blocked) return blocked;
  const startedAt = Date.now();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!body.prompt || !body.prompt.trim()) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }

  // 输入校验 + 数值兜底（防止前端传 NaN / 超界）
  const stepsRaw = Number(body.steps);
  const cfgRaw = Number(body.cfg);
  const seedRaw = Number(body.seed);
  const nImagesRaw = Number(body.nImages);

  const payload = {
    data: [
      body.prompt,
      body.negative ?? '',
      Number.isFinite(stepsRaw) ? Math.max(1, Math.min(8, Math.trunc(stepsRaw))) : 4,
      Number.isFinite(cfgRaw) ? cfgRaw : 0.0,
      Number.isFinite(seedRaw) ? Math.trunc(seedRaw) : -1,
      Number.isFinite(nImagesRaw) ? Math.max(1, Math.min(4, Math.trunc(nImagesRaw))) : 1,
      body.quantize ?? true,
      body.autoRelease ?? true,
    ],
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${GEMMA_UI}/gradio_api/run/generate_sdxl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // Gradio sync run 可能需要较长时间；首次冷启动 30-90s
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error: '无法连接本地 Gemma UI。请确认双击 Start-Gemma4.command 已启动，且端口 7860 可访问。',
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

  let data: {
    data?: [{ path?: string; url?: string }, string?];
  };
  try {
    data = (await upstream.json()) as typeof data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: 'gradio 响应解析失败', detail: msg }, { status: 502 });
  }

  const imgEntry = data.data?.[0];
  const status = (data.data?.[1] as string | undefined) ?? '';
  const imgUrl = imgEntry?.url;

  if (!imgUrl) {
    return NextResponse.json(
      { error: 'gradio 返回缺少图片 url', detail: JSON.stringify(data).slice(0, 500) },
      { status: 502 },
    );
  }

  // 安全校验：只允许 Gradio 自己 host 出来的 file 端点。
  // Gradio 6.x 返回的 url 形如 http://127.0.0.1:7860/gradio_api/file=/private/var/...
  // 用 URL 解析 + origin + path 前缀双校验，挡掉任何被污染回的恶意 url（含 SSRF）。
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(imgUrl);
  } catch {
    return NextResponse.json({ error: '非法图片 url 格式', detail: imgUrl }, { status: 502 });
  }
  const expectedOrigin = new URL(GEMMA_UI).origin;
  if (parsedUrl.origin !== expectedOrigin || !parsedUrl.pathname.startsWith('/gradio_api/file=')) {
    return NextResponse.json(
      { error: '图片 url 来源不匹配 GEMMA_UI', detail: imgUrl },
      { status: 502 },
    );
  }

  // 反向 fetch 图片，转 dataURL 给前端（避开浏览器对 127.0.0.1:7860 的跨域）
  let dataUrl: string;
  try {
    const imgResp = await fetch(imgUrl, { signal: AbortSignal.timeout(30_000) });
    if (!imgResp.ok) {
      return NextResponse.json(
        { error: `获取图片失败 ${imgResp.status}`, detail: imgUrl },
        { status: 502 },
      );
    }
    const buf = Buffer.from(await imgResp.arrayBuffer());
    const mime = imgResp.headers.get('content-type') || 'image/png';
    dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: '获取图片失败', detail: msg }, { status: 500 });
  }

  return NextResponse.json({
    dataUrl,
    status,
    // Gradio 6.x sync /run 响应里没有顶层 duration 字段，自己计时
    durationSec: (Date.now() - startedAt) / 1000,
    sourceUrl: imgUrl,
  });
}

// 显式拒绝非 POST 请求（避免 Next 默认 405 但缺乏 Allow 头）
export async function GET() {
  return NextResponse.json(
    { error: 'method not allowed; use POST with JSON body' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

// CORS preflight：PoC 同源，这里只是为了不让浏览器在 strict 模式下卡死
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      Allow: 'POST, OPTIONS',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

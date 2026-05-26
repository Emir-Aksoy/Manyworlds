/**
 * POST /api/image-compat
 *
 * 通用 OpenAI Images API 兼容代理 — 给"用户自定义 Image Lane"用。
 *
 * 协议:OpenAI 标准 `POST /v1/images/generations`,详见
 *   https://platform.openai.com/docs/api-reference/images/create
 *
 * 适配的服务:
 *   OpenAI(DALL-E 3 / gpt-image-1)/ Together(FLUX) / SiliconFlow(Kolors 等) /
 *   阿里 DashScope OpenAI 兼容模式(通义万相) / Azure OpenAI(DALL-E 3 部署) /
 *   自建 vLLM-image / ComfyUI OpenAI adapter
 *
 * Zero-knowledge:
 *   - apiKey 从 Authorization: Bearer 头传(BYOK,server 不存)
 *   - baseUrl 从 X-Wc-Base-Url 头传(必填,custom lane 没有 server-side default)
 *   - server 不日志、不持久化、不缓存任何用户字段
 *
 * 返回格式:
 *   - 始终返回 { dataUrl: 'data:image/png;base64,...', durationSec, lane }
 *   - 客户端写到 plaza state appearance.portraits[emotion],跟现有上传图片同结构
 *   - 如果上游服务返回 b64_json,我们直接组装 dataUrl
 *   - 如果上游只返回 url(部分服务不支持 response_format=b64_json),server 反向 fetch
 *     转 base64 再组装。这是为了:
 *       a) 屏蔽各服务 url 过期时间不同(OpenAI 1 小时,Together 24 小时等)
 *       b) 让 localStorage 持久化不依赖外部 CDN 可用性
 *       c) 避开浏览器 mixed-content 拦截
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  assertPublicResolvableUrl,
  resolveCustomBaseUrlSafely,
} from '../../../lib/api-base-resolver';

type ImageBody = {
  prompt: string;
  model: string; // 必填(对 custom lane 没有兜底)
  size?: string; // '1024x1024' / '1024x1792' / 自由 WxH
  quality?: string; // DALL-E 3 'standard'|'hd' / gpt-image-1 'low'|'medium'|'high'
  n?: number; // 1-4,DALL-E 3 强制 1
  responseFormat?: 'b64_json' | 'url'; // 默认 b64_json,服务不支持时降级 url 再 server fetch
  negativePrompt?: string; // 仅部分服务支持(Together / SiliconFlow);OpenAI 忽略
};

type UpstreamImageData = {
  error?: { message?: string; code?: string; type?: string };
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SAFE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

async function fetchSafeImageUrl(rawUrl: string): Promise<Response> {
  let current = await assertPublicResolvableUrl(rawUrl, 'image lane 返回 URL');
  for (let i = 0; i < 4; i++) {
    const resp = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) return resp;
      current = await assertPublicResolvableUrl(new URL(location, current).toString(), 'image lane 跳转 URL');
      continue;
    }
    return resp;
  }
  throw new Error('image lane 返回 URL 跳转次数过多');
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();

  // ── 1. 凭证 ──
  const auth = req.headers.get('authorization') ?? '';
  const apiKey = auth.replace(/^Bearer\s+/i, '').trim();
  if (!apiKey) {
    return NextResponse.json(
      {
        error: 'missing API key',
        hint: '在 ModelsTab → 🎨 自定义 Image Lane 填一个 key',
      },
      { status: 401 },
    );
  }

  // ── 2. baseUrl ──
  let baseUrl: string;
  try {
    const url = req.headers.get('x-wc-base-url')?.trim();
    if (!url) {
      return NextResponse.json(
        { error: 'missing X-Wc-Base-Url header', hint: 'custom image lane 必须传 baseUrl' },
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

  // ── 3. body ──
  let body: ImageBody;
  try {
    body = (await req.json()) as ImageBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!body.prompt?.trim()) {
    return NextResponse.json({ error: 'prompt required' }, { status: 400 });
  }
  if (!body.model?.trim()) {
    return NextResponse.json(
      { error: 'model required', hint: 'custom image lane 必须自带 model 名(各服务命名不同)' },
      { status: 400 },
    );
  }

  // ── 4. 拼装上游 request ──
  // OpenAI Images API 规范:
  //   { model, prompt, n?, size?, quality?, response_format?: 'url' | 'b64_json' }
  // 部分服务(Together / SiliconFlow)还接受 negative_prompt / steps 等扩展字段,
  // 用 snake_case 透传,服务不认识就会忽略。
  const desiredFormat = body.responseFormat === 'url' ? 'url' : 'b64_json';
  const upstreamReq: Record<string, unknown> = {
    model: body.model,
    prompt: body.prompt,
    n: Math.max(1, Math.min(4, Number(body.n) || 1)),
    response_format: desiredFormat,
  };
  if (body.size?.trim()) upstreamReq.size = body.size.trim();
  if (body.quality?.trim()) upstreamReq.quality = body.quality.trim();
  if (body.negativePrompt?.trim()) upstreamReq.negative_prompt = body.negativePrompt.trim();

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamReq),
      // 生图普遍比 chat 慢得多(DALL-E 3 ~10-20s,FLUX dev ~30-60s)
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: '调用 image lane 失败',
        detail: err instanceof Error ? err.message : String(err),
        baseUrl,
      },
      { status: 503 },
    );
  }

  const text = await upstream.text();
  let data: UpstreamImageData;
  try {
    data = JSON.parse(text) as UpstreamImageData;
  } catch {
    return NextResponse.json(
      {
        error: `image lane 响应非 JSON (HTTP ${upstream.status})`,
        detail: text.slice(0, 300),
      },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    return NextResponse.json(
      {
        error: `image lane ${upstream.status}`,
        detail: data.error?.message ?? text.slice(0, 300),
        code: data.error?.code,
        type: data.error?.type,
      },
      { status: upstream.status },
    );
  }

  // ── 5. 取第一张图 ──
  const first = data.data?.[0];
  if (!first) {
    return NextResponse.json(
      { error: 'image lane 响应 data 为空', detail: text.slice(0, 300) },
      { status: 502 },
    );
  }

  let dataUrl: string;
  const revisedPrompt = first.revised_prompt; // DALL-E 3 会自动改写 prompt 返回这字段

  if (first.b64_json) {
    // 服务直接给了 base64 — 最理想路径,组装 dataUrl
    dataUrl = `data:image/png;base64,${first.b64_json}`;
  } else if (first.url) {
    // 服务只给了 url — server 反向 fetch 转 base64
    let imgResp: Response;
    try {
      imgResp = await fetchSafeImageUrl(first.url);
    } catch (err) {
      return NextResponse.json(
        {
          error: '反向获取生图结果失败',
          detail: err instanceof Error ? err.message : String(err),
          url: first.url,
        },
        { status: 502 },
      );
    }
    if (!imgResp.ok) {
      return NextResponse.json(
        { error: `反向获取生图结果失败 ${imgResp.status}`, url: first.url },
        { status: 502 },
      );
    }
    const mime = (imgResp.headers.get('content-type') || 'image/png').split(';')[0].trim().toLowerCase();
    if (!SAFE_IMAGE_MIME.has(mime)) {
      return NextResponse.json(
        { error: `反向获取生图结果返回了非安全图片类型: ${mime}`, url: first.url },
        { status: 502 },
      );
    }
    const contentLength = Number(imgResp.headers.get('content-length') || '0');
    if (contentLength > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: `反向获取生图结果过大(${contentLength} bytes)`, url: first.url },
        { status: 502 },
      );
    }
    const buf = Buffer.from(await imgResp.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: `反向获取生图结果过大(${buf.byteLength} bytes)`, url: first.url },
        { status: 502 },
      );
    }
    dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  } else {
    return NextResponse.json(
      { error: 'image lane 响应既无 b64_json 也无 url', detail: text.slice(0, 300) },
      { status: 502 },
    );
  }

  return NextResponse.json({
    dataUrl,
    durationSec: (Date.now() - startedAt) / 1000,
    lane: 'openai_images_compat',
    revisedPrompt, // 透传给 UI 显示(让用户知道 prompt 被服务改了)
  });
}

// 显式拒绝非 POST(避免 Next 默认 405 但缺 Allow 头)
export async function GET() {
  return NextResponse.json(
    { error: 'method not allowed; use POST with JSON body' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      Allow: 'POST, OPTIONS',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Wc-Base-Url',
    },
  });
}

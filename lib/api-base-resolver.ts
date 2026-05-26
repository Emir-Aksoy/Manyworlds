/**
 * Server-side helper: 解析 BYOK 用户从 `X-Wc-Base-Url` header 传过来的自定义 base URL,
 * 做最小安全检查(避免把 Vercel function 变成开放 SSRF proxy)。
 *
 * 用法:
 *   import { resolveCustomBaseUrl } from '@/lib/api-base-resolver';
 *   const baseUrl = resolveCustomBaseUrl(req, 'https://api.deepseek.com');  // 抛错 throw
 *
 * 安全规则:
 *   - 必须 https://(不允许 http,避免 server 端访问明文内网)
 *   - 不能指向 localhost / 0.0.0.0 / 127.x / 内网 RFC1918 网段 / link-local 169.254.x
 *   - 不能指向 .internal / .lan / .local 等本地后缀
 *   - server-side 出站请求额外做 DNS 解析,解析结果不能落到私网 / loopback / link-local
 *
 * 不做的:
 *   - 不做域名 allowlist(BYOK 就是要自由,让用户自己负责接入哪家服务)
 *   - 不做路径限制(各家 endpoint 路径细节不同)
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { NextRequest } from 'next/server';

const PRIVATE_IP_PATTERNS: RegExp[] = [
  /^127\./, // loopback
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // RFC1918
  /^169\.254\./, // link-local
  /^0\./, // wildcard
  /^::1$/, // IPv6 loopback
  /^fc/i, // IPv6 unique local
  /^fe80:/i, // IPv6 link-local
];

const PRIVATE_HOST_SUFFIXES = ['.local', '.internal', '.lan', '.localhost'];

function displayValue(raw: string): string {
  return raw.slice(0, 80);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

function isPrivateIp(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (!isIP(normalized) && !/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) return false;
  return PRIVATE_IP_PATTERNS.some((re) => re.test(normalized));
}

function assertPublicHost(hostname: string, label: string) {
  const host = normalizeHostname(hostname);

  if (host === 'localhost' || host === '0.0.0.0') {
    throw new Error(`${label} 不能指向 localhost(${host})`);
  }
  if (isPrivateIp(host)) {
    throw new Error(`${label} 不能指向私有 / 内网地址(host: ${host})`);
  }
  for (const suffix of PRIVATE_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      throw new Error(`${label} 不能指向本地解析后缀(host: ${host})`);
    }
  }
}

export function normalizePublicHttpsUrl(rawUrl: string, label = 'URL'): string {
  const raw = rawUrl.trim();
  if (!raw) throw new Error(`${label} 不能为空`);

  // 必须 https
  if (!/^https:\/\//i.test(raw)) {
    throw new Error(
      `${label} 必须以 https:// 开头(避免明文内网请求)。收到: ${displayValue(raw)}`,
    );
  }

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${label} 不是合法 URL: ${displayValue(raw)}`);
  }

  assertPublicHost(u.hostname, label);

  // 删尾部 /,统一格式
  return raw.replace(/\/+$/, '');
}

export function resolveCustomBaseUrl(req: NextRequest, defaultBase: string): string {
  const custom = req.headers.get('x-wc-base-url')?.trim();
  if (!custom) return defaultBase;
  return normalizePublicHttpsUrl(custom, 'X-Wc-Base-Url');
}

export async function assertPublicResolvableUrl(rawUrl: string, label = 'URL'): Promise<string> {
  const normalized = normalizePublicHttpsUrl(rawUrl, label);
  const host = normalizeHostname(new URL(normalized).hostname);

  if (!isIP(host)) {
    let answers: { address: string }[];
    try {
      answers = await lookup(host, { all: true, verbatim: true });
    } catch (err) {
      throw new Error(`${label} DNS 解析失败(${host}): ${err instanceof Error ? err.message : String(err)}`);
    }
    const privateAnswer = answers.find((a) => isPrivateIp(a.address));
    if (privateAnswer) {
      throw new Error(`${label} DNS 解析到私有 / 内网地址(${privateAnswer.address})`);
    }
  }

  return normalized;
}

export async function resolveCustomBaseUrlSafely(
  req: NextRequest,
  defaultBase: string,
): Promise<string> {
  const custom = req.headers.get('x-wc-base-url')?.trim();
  return assertPublicResolvableUrl(custom || defaultBase, 'X-Wc-Base-Url');
}

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
 *
 * 不做的:
 *   - 不做域名 allowlist(BYOK 就是要自由,让用户自己负责接入哪家服务)
 *   - 不做路径限制(各家 endpoint 路径细节不同)
 */
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

export function resolveCustomBaseUrl(
  req: NextRequest,
  defaultBase: string,
): string {
  const custom = req.headers.get('x-wc-base-url')?.trim();
  if (!custom) return defaultBase;

  // 必须 https
  if (!/^https:\/\//i.test(custom)) {
    throw new Error(
      `X-Wc-Base-Url 必须以 https:// 开头(避免明文内网请求)。收到: ${custom.slice(0, 80)}`,
    );
  }

  let u: URL;
  try {
    u = new URL(custom);
  } catch {
    throw new Error(`X-Wc-Base-Url 不是合法 URL: ${custom.slice(0, 80)}`);
  }

  const host = u.hostname.toLowerCase();

  // 禁 localhost / private IP
  if (host === 'localhost' || host === '0.0.0.0') {
    throw new Error(`X-Wc-Base-Url 不能指向 localhost(${host})`);
  }
  for (const re of PRIVATE_IP_PATTERNS) {
    if (re.test(host)) {
      throw new Error(`X-Wc-Base-Url 不能指向私有 / 内网地址(host: ${host})`);
    }
  }
  for (const suffix of PRIVATE_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      throw new Error(`X-Wc-Base-Url 不能指向本地解析后缀(host: ${host})`);
    }
  }

  // 删尾部 /,统一格式
  return custom.replace(/\/+$/, '');
}

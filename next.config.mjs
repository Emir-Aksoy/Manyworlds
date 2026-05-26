/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 不在 response 头里暴露 x-powered-by: Next.js
  poweredByHeader: false,
  // P1-#6:prod build 剥除 console.log / console.warn / console.info / console.debug,
  // 只保留 console.error(关键诊断 + 错误上报场景)。
  // 目的:
  //   - 减小 client bundle(代码里 50 处 console.*,主要散在 WC-EVENT parser / lane fallback 等地)
  //   - 隐私:BYOK 模式下别在公网用户的浏览器 console 暴露 lane 切换路径 / token 数 / 内部状态
  //   - dev 模式仍保留所有 console(`npm run dev` 不会触发 removeConsole)
  compiler: {
    removeConsole: {
      exclude: ['error'],
    },
  },
};

export default nextConfig;

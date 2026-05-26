# Deploy — Manyworlds(公网试玩 / BYOK)

把 PoC 部署到 Vercel 公网,让朋友 / 试玩者用自己的 LLM key 玩。**不收费、不收用户数据**。

## 前置条件

- GitHub / GitLab / Bitbucket 账号(代码托管)
- Vercel 账号(免费 Hobby plan 也能跑,但 API timeout 上限 10s 可能不够 LLM 长响应)
- 一个 Vercel-friendly 的 git remote(把这个仓库推上去)

## 5 分钟部署

1. **推代码到 git remote**(主分支即可)

2. **Vercel Import Project**
   - 登 https://vercel.com → New Project → Import 你刚推的 repo
   - Framework Preset 会自动识别 **Next.js**
   - **不要**填任何环境变量(BYOK 模式,服务端不持有任何 key)
   - Build Command / Output Directory / Install Command 全部用默认值

3. **Deploy**
   - 第一次 build 大约 1-2 分钟
   - 完成后 Vercel 给你一个 `*.vercel.app` 域名

4. **首次访问验证**
   - 用一个**全新浏览器 / 无痕窗口**打开生成的域名
   - 应该自动弹 `BYOK Onboarding Modal`(欢迎 + 隐私 + 三选一 key 申请链接)
   - 走到设置 → 模型路由 → 应该**只看到 3 条 BYOK lane**:
     `Codex API` / `Claude API (BYOK)` / `DeepSeek`
   - **不应**看到 `Codex 主池 (订阅)` / `Spark` / `Claude (订阅 SDK)` / `Gemma 4 (本地)` 这些

5. **Plan 选择**
   - **Hobby (免费)**:API route 超时 10s,LLM 长响应可能被 cut。够试玩,不够正式。
   - **Pro ($20/mo)**:API route 超时 60s(`vercel.json` 已经配好),完整体验。
   - `vercel.json` 已经给 `/api/openai-compat` 配了 `maxDuration: 60`(它是 BYOK 通道里唯一会跑 LLM 长请求的 route)。Hobby 用户可以把它改回 10,或忽略 warning。

6. **Vercel 部署自动精简**(P1-#7)
   - `scripts/prebuild-exclude-dev-routes.mjs` 在 Vercel CI(`VERCEL=1` 环境变量由 Vercel 自动注入)build 前会把 4 个 `/api/local-*` 路由(只本机 bridge/Gradio 才用得到)移到 Next.js 私有目录,Vercel build 扫不到 = 不打 lambda
   - 结果:Vercel 上你只看到 **1 个 lambda(`/api/openai-compat`)**。Hobby plan 的 12 个 slot 配额释放出 11 个给未来扩展
   - 本机 `npm run dev` / `npm run build` 完全不受影响(没 VERCEL 环境变量,脚本会直接 exit)

## 用户怎么接其他 OpenAI 兼容服务

部署后用户可以**完全自定义 lane**(不限于 DeepSeek / OpenAI / Anthropic 三家):

1. 进站 → 顶部"模型路由" Tab
2. 最上面"🛠 自定义 Lane"区域 → 点"+ 添加自定义 Lane"
3. 填写:
   - **名称**:任起,如 "Groq Llama 70B"
   - **API Base URL**:`https://api.groq.com/openai`(或 OpenRouter / Together / SiliconFlow / 自建 vLLM 等)
   - **Model 名**:`llama-3.3-70b-versatile`(或服务对应的精确 model 名)
   - **API Key**:对应服务的 key(只存浏览器 localStorage)
   - **备注**(可选):提醒自己价钱 / 用途
4. 保存后,这条 lane 自动出现在下方"路由矩阵"和"fallback 链编辑器"的下拉里
5. 在"路由矩阵"里把任意任务(NPC 核心对话 / Director 推进 / 队友闲聊 / ...)指向这条 lane

**所有调用走 `/api/openai-compat` zero-knowledge proxy** —— server 端不持久化 / 不日志 key 和 baseUrl。

常见服务对照:

| 服务 | API Base URL | Model 名(示例) |
|---|---|---|
| **OpenRouter** | `https://openrouter.ai/api` | `anthropic/claude-3.5-sonnet` / `meta-llama/llama-3.3-70b-instruct` |
| **Groq** | `https://api.groq.com/openai` | `llama-3.3-70b-versatile` |
| **SiliconFlow** | `https://api.siliconflow.cn` | `Qwen/Qwen2.5-72B-Instruct` |
| **Moonshot** | `https://api.moonshot.cn` | `moonshot-v1-32k` |
| **Together** | `https://api.together.xyz` | `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo` |
| **Fireworks** | `https://api.fireworks.ai/inference` | `accounts/fireworks/models/llama-v3p3-70b-instruct` |
| **Azure OpenAI** | `https://YOUR.openai.azure.com` | 你的部署名 |
| **自建 vLLM** | `https://your-vllm.example.com` | 你部署的 model id |

## 部署后清单

完成部署后,在公网域名上验证:

- [ ] BYOK Onboarding Modal 自动弹(无痕窗口,未填 key 状态)
- [ ] 设置页只显示 3 条 BYOK lane(没有 codex_bridge / local_gemma)
- [ ] 填一个 DeepSeek key,进大唐双龙剧本,跟寇仲对话能正常响应
- [ ] Footer 底部三行声明可见,展开"完整声明"显示涉及作品列表
- [ ] 设置页底部"💾 存储用量"面板可见(初始 ~0.x MB)
- [ ] 试一次"导出全部进度"按钮,能下载 JSON
- [ ] 故意不填 key 发对话 → 出现 Friendly Error 卡片 + "去设置填 key" 按钮可跳转
- [ ] 进 ModelsTab → 顶部"🛠 自定义 Lane"区域可见 → 能添加 / 编辑 / 删除 / 列表显示
- [ ] ModelsTab 第二个区域"🎨 自定义 Image Lane(OpenAI Images API 兼容)"可见 → 能添加 / 编辑 / 删除
- [ ] 填一条 OpenAI DALL-E 3(`https://api.openai.com` + `dall-e-3`)→ 立绘 Tab → "立绘生成 Lane C" 卡片选这条 lane → 生成一张测试图 → 显示成功 + duration
- [ ] 进剧本 → 切到一个 NPC(该 NPC 没上传立绘也没剧本预生成图)→ 后台自动调 `/api/image-compat` 生立绘(看 Network 面板)→ 控制台**不**出现"public 模式未配 Image Lane,跳过 …"
- [ ] 立绘生成后 sessionStorage 应该有 `wc_poc_portraits_v1` 项,内容形如 `{"<npcId>":{"neutral":"data:image/png;base64,..."}}`
- [ ] 关 tab 重开站点 → 立绘**会重新生成**(因为 sessionStorage 关 tab 即清,这是符合预期的)。其他进度(剧本、对话、关系)正常保留

## 自定义域名(可选)

Vercel Dashboard → Project → Settings → Domains → Add → 跟着提示改 DNS。

## 关掉这次部署

如果想关闭公网试玩:Vercel Dashboard → Project → Settings → Delete Project。所有数据(包括你部署期间产生的 logs)随之删除。**所有用户的进度本来就在他们浏览器 localStorage 里,跟项目删除无关**。

## 不需要做的事

- ❌ 不需要任何服务端环境变量
- ❌ 不需要数据库
- ❌ 不需要 Redis / 缓存
- ❌ 不需要用户系统 / 鉴权
- ❌ 不需要 analytics(完全可选)
- ❌ 不需要付费集成

所有这些 Manyworlds 都不做 — 它是 BYOK 同人项目,你只是个静态 + zero-knowledge proxy 的载体。

## 故障排查

| 现象 | 原因 | 修法 |
|---|---|---|
| 部署后白屏 | bundle 加载失败 | 看 Vercel function logs,通常是 DLC manifest fetch 失败,检查 `public/dlc/*.json` 是否被推到 git |
| BYOK modal 不弹 | runtime-mode 误判为 dev | 看 `lib/runtime-mode.ts` 的 hostname 黑名单,确认部署域名不在 `.local` 等列表里 |
| 对话超时(30s+ 没响应) | Hobby plan 10s API timeout | 升 Pro plan,或者改 `vercel.json` 把 `maxDuration` 调回 10 接受截断 |
| 看到 codex_bridge lane | runtime-mode 没生效 | `npm run build` 本地跑过,检查是否在 `production` 模式部署 |

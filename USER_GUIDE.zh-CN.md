# Manyworlds 使用手册(中文)

> AI 角色扮演 / 多剧本同人项目 · BYOK 模式(自带 LLM Key)· 无账号 · 无服务端数据库

---

## 1. 这是什么

**Manyworlds** 是一个浏览器上跑的 AI 角色扮演沙盒。你扮演一个穿越者,在不同的"剧本世界"里跟 NPC 对话、做选择、组队、推进剧情。

核心机制:

- **BYOK(Bring Your Own Key)**:LLM 调用用你自己的 API Key(DeepSeek / OpenAI / Anthropic / 任意 OpenAI 兼容服务),站方不持有任何 key。
- **零持久化**:所有游戏进度只存在**你浏览器 localStorage**。没有账号、没有数据库、没有用户系统。
- **同人项目**:涉及作品仅作非商业二次创作展示,不收费、不收用户数据。

---

## 2. 5 分钟上手

### 第一步:进站

打开站点(本地 `http://localhost:3000`,或公网部署域名)。

首次访问会弹 **👋 欢迎来 Manyworlds** 引导弹窗,包含:

- 项目介绍
- 🔒 隐私保证
- 三选一 Key 申请链接

### 第二步:申请一个 LLM Key(三选一)

| 服务 | 价钱 | 推荐场景 | 申请地址 |
|---|---|---|---|
| **DeepSeek** | $0.07 / $0.28 per 1M tokens(**最便宜,推荐入门**) | 大量对话、不追求极致质量 | https://platform.deepseek.com/api_keys |
| **OpenAI** | GPT-5 系列(贵但智能) | 复杂剧情、精细 NPC | https://platform.openai.com/api-keys |
| **Anthropic** | Claude(中文文学性强) | 古风剧本、情感戏 | https://console.anthropic.com/ |

> 三家都需要绑信用卡 / 充值。如果不想用三家自己的 key,也可以走聚合服务(OpenRouter / Groq / SiliconFlow / Moonshot / Together / Fireworks 等),做法看下文第 4 节。

### 第三步:把 Key 填进设置

1. 顶栏点 **"设置 / 凭证"** Tab
2. 在 BYOK Key 区域粘贴你刚拿到的 Key
3. 自动保存到**浏览器 localStorage**(server 不会经手)

### 第四步:进剧本

1. 回到 **"广场"** Tab
2. 在剧本卡片里点你想玩的(初次推荐 **星际邮差** 或 **大唐双龙传**)
3. 弹出 **EntryModal**,会显示 `👥 携带队友 (0/N)` 让你选要不要带队友(可不带)
4. 点 **"发愿,启程 →"**(或"无愿启程 — 走入命运。")
5. 一段骰子动画后,跳到 **"聊天"** Tab,场景已就绪

### 第五步:开始对话

聊天界面下方有 **"💬 对 [NPC 名] 说"** 输入框,例如:

- `💬 对寇仲说`(大唐双龙)
- `💬 对哈利亚说`(星际邮差)

打字 → Enter → NPC 通过你配的 Lane 走 LLM 响应。

---

## 3. 顶栏 6 个 Tab 说明

| Tab | 用途 |
|---|---|
| **广场** | 剧本列表 / 收藏 / 进入剧本 / 进度卡片 |
| **聊天** | 主交互界面:NPC 对话 / Director 推进 / 队友闲聊 / 场景进度 |
| **记忆固化** | 长对话压缩后的"记忆条"管理,导出/编辑/删除 |
| **立绘** | NPC 立绘选择 / 上传自定义立绘 |
| **模型路由** | 配置哪个任务走哪条 LLM lane,自定义 Lane,健康检查 |
| **设置 / 凭证** | BYOK Key 管理、存储用量、导出 / 清空数据 |

---

## 4. 模型路由 详解(模型路由 Tab)

### 4.1 Lane 是什么

一条 Lane = 一个 LLM 接入通道。公网部署默认有 3 条 BYOK Lane:

- **Codex API**(OpenAI GPT 系列)
- **Claude API (BYOK)**(Anthropic Claude)
- **DeepSeek**(DeepSeek 官方)

### 4.2 自定义 Lane(支持任意 OpenAI 兼容服务)

模型路由 Tab 顶部有 **🛠 自定义 Lane(OpenAI 兼容)** 区域,点 **"+ 添加自定义 Lane"**,填:

| 字段 | 说明 | 示例 |
|---|---|---|
| **名称** | UI 显示名,随便起 | `Groq Llama 70B` |
| **API Base URL** | `https://` 开头,不带尾部 `/v1` 或 `/chat/completions`,路径由站点拼 | `https://api.groq.com/openai` |
| **Model 名** | 精确 model 名,因服务而异 | `llama-3.3-70b-versatile` |
| **API Key** | 只存你浏览器 localStorage,server 不持久化 | `gsk_xxx...` |
| **备注(可选)** | 健康卡片会显示这一行,提醒自己价钱 / 用途 | `$0.59/M 输出,便宜的 70B` |

**常用聚合服务对照**:

| 服务 | Base URL | Model 示例 |
|---|---|---|
| OpenRouter | `https://openrouter.ai/api` | `anthropic/claude-3.5-sonnet` |
| Groq | `https://api.groq.com/openai` | `llama-3.3-70b-versatile` |
| SiliconFlow | `https://api.siliconflow.cn` | `Qwen/Qwen2.5-72B-Instruct` |
| Moonshot | `https://api.moonshot.cn` | `moonshot-v1-32k` |
| Together | `https://api.together.xyz` | `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo` |
| Fireworks | `https://api.fireworks.ai/inference` | `accounts/fireworks/models/llama-v3p3-70b-instruct` |
| Azure OpenAI | `https://YOUR.openai.azure.com` | 你的部署名 |
| 自建 vLLM | `https://your-vllm.example.com` | 你部署的 model id |

### 4.3 路由矩阵(把任务指到 Lane)

下方"路由矩阵"是个表格,行是任务类型(NPC 核心对话 / Director / 队友闲聊 / 立绘描述 / 记忆压缩...),列是 Lane。下拉选一条 Lane 即可。

### 4.4 Fallback 链

每个 Lane 可以配 fallback(主 Lane 挂了自动回退)。比如:
- 主选 DeepSeek → 副选 Codex API → 兜底自定义 Lane

可视化编辑器在路由矩阵下方。

### 4.5 健康检查

页面上每条 Lane 都有健康卡片(✅ 通 / ❌ 不通 / ⚠ 慢)。一般 30 秒探一次。新加的 Lane 没填 Key 会立刻显示 ❌。

### 4.6 🎨 自定义 Image Lane(立绘生图)

跟 LLM Lane **并列独立**的生图通道。走 **OpenAI Images API 兼容协议** —— 也就是说任何实现了 `POST /v1/images/generations` 的服务都能接。

**加 Lane 流程**:模型路由 Tab → 滚到"🎨 自定义 Image Lane(OpenAI Images API 兼容)"区域 → 点 **"+ 添加 Image Lane"** → 填:

| 字段 | 说明 | 示例 |
|---|---|---|
| **名称** | UI 显示名,随便起 | `OpenAI DALL-E 3` |
| **API Base URL** | `https://` 开头,不带尾部 `/v1` 或 `/images/generations` | `https://api.openai.com` |
| **Model 名** | 精确 model 名,各家不同 | `dall-e-3` |
| **API Key** | 只存浏览器 localStorage | `sk-...` |
| **尺寸(size)** | OpenAI / FLUX 支持 `1024x1024` `1024x1792` 等 | `1024x1024` |
| **质量(quality)** | DALL-E 3 用 `standard`/`hd`,gpt-image-1 用 `low`/`medium`/`high`,其他服务忽略 | `standard` |
| **备注** | 自己记价钱 / 用途 | `DALL-E 3 standard $0.04/张` |

**常见服务对照**:

| 服务 | API Base URL | Model 示例 | 一张 ~价钱 |
|---|---|---|---|
| **OpenAI** DALL-E 3 | `https://api.openai.com` | `dall-e-3` | $0.04 (standard) / $0.08 (hd) |
| **OpenAI** gpt-image-1 | `https://api.openai.com` | `gpt-image-1` | $0.011 (low) / $0.063 (high) |
| **Together AI** FLUX | `https://api.together.xyz` | `black-forest-labs/FLUX.1-dev` | ~$0.025 |
| **Together AI** FLUX-pro | `https://api.together.xyz` | `black-forest-labs/FLUX.1.1-pro` | ~$0.04 |
| **SiliconFlow** Kolors | `https://api.siliconflow.cn` | `Kwai-Kolors/Kolors` | ¥0.04 |
| **阿里 DashScope** 通义万相 | `https://dashscope.aliyuncs.com/compatible-mode` | `wanx-v1` | ¥0.20 (一次) |
| **Azure OpenAI** DALL-E 3 | `https://YOUR.openai.azure.com` | 你的部署名 | 同 OpenAI |
| **自建 ComfyUI/vLLM-image** | `https://your-host` | 你的 model id | 0 |

**生图触发时机**:

1. **自动**:在剧本里切到某个 NPC + 该 NPC 没缓存立绘 + 你**没**上传立绘 → 公网模式下站点用 Image Lane 列表**第一条**自动给该 NPC 生 neutral 表情 + 按 tier 配额预生其他 emotion
2. **手动**:立绘 Tab → "立绘生成 Lane C · BYOK 在线生图" 卡片 → 选 lane → 输 prompt → 生成(只测试链路,不写入 NPC 立绘)

**关键提示**:

- 🚨 **生图比文本贵 100-1000 倍**。DALL-E 3 一张 ~$0.04,一晚上多 NPC 多 emotion 烧 5-10 美金不奇怪。预算紧建议用 **Together FLUX** 或 **SiliconFlow Kolors**(便宜 5-10 倍)。
- 🚨 **立绘存在 sessionStorage(关 tab 就清)**。生成的图按 base64 存浏览器 `sessionStorage['wc_poc_portraits_v1']`,1024×1024 PNG ~1.3MB,~5MB 配额下 3-4 张就满。**`sessionStorage` 关闭浏览器标签后清空,跨标签 / 跨浏览器都不共享,"⬇ 导出全部进度"也不会带走立绘**。换句话说:每次重开站点都要重生立绘(=重新付钱)。这是当前已知短板,如果你重度用,建议在同一 tab 内一次玩到底。
- ⚠ **没配 Image Lane 不影响玩**。公网模式下若 0 条 Image Lane,立绘自动生图静默跳过 —— 用户依然能通过"上传图片"路径手动给 NPC 配立绘,或者用剧本内置图(部分剧本有)。
- ⚠ **OpenAI 会自动改写 prompt**。DALL-E 3 / gpt-image-1 会重写你的 prompt 防止滥用,Lane C 测试卡会显示改写后的版本。其他服务一般不改。

---

## 5. 8 个剧本简介

| 剧本 | 类型 | 推荐入门 |
|---|---|---|
| **星际邮差** | 科幻 · 太空冒险 | ⭐ 系统教学最完整 |
| **大唐双龙传** | 武侠 · 古风群像 | ⭐ 中文对话最自然 |
| **念念** | 都市 · 情感 | - |
| **簪花** | 古风 · 女性视角 | - |
| **申城谜影** | 民国 · 悬疑推理 | - |
| **回光** | 末世 · 心理 | - |
| **元末风云** | 历史 · 权谋 | - |
| **挽歌之矛** | 奇幻 · 战争 | - |

> 想加自己的剧本?在"广场"右上角可加载自定义剧本 JSON(localStorage 存储,key:`wc_poc_custom_scenarios_v1`)。

---

## 6. 数据 / 隐私 / 导出(设置 / 凭证 Tab)

### 6.1 你的数据存在哪

**两层存储:大部分进度在 localStorage(持久 + 可导出),立绘缓存单独在 sessionStorage(关 tab 即清)。**

**localStorage**(关 tab / 重启浏览器仍在,可被"⬇ 导出全部进度"打包):

| Key | 内容 |
|---|---|
| `wc_poc_plaza_v1` | 广场数据(队友 / 物品 / 进度 / 关系 / NPC spec 内嵌立绘) |
| `wc_poc_router_v2` | 路由预设 / 覆盖 / fallback 链 |
| `wc_poc_pref_v1` | 用户偏好(默认 model 等) |
| `wc_poc_byok_onboarded` | 引导是否已 dismiss |
| `wc_poc_custom_lanes_v1` | 自定义 LLM Lane(含 apiKey 嵌入,默认导出会清空) |
| `wc_poc_custom_image_lanes_v1` | 自定义 Image Lane(立绘生图,含 apiKey 嵌入,默认导出会清空) |
| `wc_poc_custom_scenarios_v1` | 自定义剧本 |
| `wc_poc_messages_v2` | NPC 对话历史 |
| `wc_poc_events` | 记忆 Tab 事件流 |
| `wc_poc_apikey_*` | 你的独立 BYOK API Keys(**敏感**,默认不导出) |

**sessionStorage**(**关 tab 立即清空**,**不**进导出包,**不**跨 tab / 跨设备):

| Key | 内容 |
|---|---|
| `wc_poc_portraits_v1` | 立绘生图缓存(NPC × emotion → base64 dataUrl) |

> ⚠️ **立绘是单 tab session 临时缓存**。重开浏览器、关 tab、新窗口、跨设备 — 立绘**都会丢**,要重新生(=重新花钱)。如果你在做大量在线生图,建议**单 tab 一次玩到底**,中途别关。这是当前已知短板,正在评估是否迁到 localStorage(配额 5MB 共享,几张图就满)或 IndexedDB(50MB+,需要异步重构)。

### 6.2 导出全部进度

设置 Tab → **"存储用量"** 面板 → 点 **"⬇ 导出全部进度(JSON)"**

- 默认**不包含 BYOK API Key**:独立的 `wc_poc_apikey_*` 不导出,Custom Lane / Image Lane 对象里的 `apiKey` 会清空
- 勾选"包含 Key"会弹确认对话框,确认后**独立**的 `wc_poc_apikey_*` 和 Custom Lane / Image Lane 内嵌 `apiKey` 都会导出
- ⚠️ **不包含 sessionStorage 中的立绘缓存** — 跨设备迁移后立绘需要重新生

### 6.3 清空数据

设置 Tab 底部有清空按钮,清空后等于全新用户(BYOK Onboarding 会再弹)。

### 6.4 跨设备迁移

A 设备导出 JSON → 把文件发给自己 → B 设备同一站点 → 设置 Tab "导入" 按钮上传 JSON。

### 6.5 隐私保证(footer 显示)

> 🔒 无账号 · 不收集任何数据 · 所有进度只存你浏览器 · API 调用 BYOK 直发第三方

服务端 `/api/openai-compat` 是 **zero-knowledge proxy**:不持久化、不日志、不缓存你的 Key 和 baseUrl。

---

## 7. 常见问题 FAQ

**Q: 我没绑信用卡的话能玩吗?**
A: 不行。LLM 调用必须真实 Key。DeepSeek 充值门槛最低(¥10 起),起步推荐。

**Q: Key 会发给"作者"吗?**
A: 不会。Key 只存你浏览器 localStorage,只在你点"发送"那一刻通过 `/api/openai-compat` zero-knowledge proxy 转发给你指定的 LLM 服务商。代码开源,可自查。

**Q: 进度会丢吗?**
A: 清浏览器缓存 / 换浏览器 / 换设备会丢。**养成定期"⬇ 导出全部进度"的习惯**,JSON 文件丢 iCloud / Dropbox / Google Drive 都行。

**Q: 为什么关浏览器再开,立绘全没了?(对话历史 / 队友 / 进度都在)**
A: 立绘缓存比其他数据**更短命** — 它存在浏览器 sessionStorage(`wc_poc_portraits_v1`),关 tab 立刻清。剧本进度等存在 localStorage,持久。这是因为 base64 图占空间大(1024×1024 ~1.3MB),怕跟剧本数据共享 5MB 配额时撞墙。代价就是每开一个新 tab 立绘要重生。**短期对策**:同一 tab 玩到底;**中期对策**:见第 6.1 节说明,我们在评估迁 localStorage。

**Q: 对话超时怎么办?**
A: 部署在 Vercel Hobby plan 时 API timeout 是 10s,LLM 长响应可能被截。升级到 Vercel Pro($20/月)可享 60s timeout。或者换更快的 Lane(Groq / 本地 vLLM)。

**Q: 怎么换 NPC 立绘?**
A: 顶栏"立绘"Tab → 选 NPC → 选/上传图。

**Q: 记忆固化是干嘛的?**
A: 对话超长会让 LLM context 撑爆。"记忆固化"会把旧对话压成几条要点,腾空间给新对话。"记忆固化"Tab 里能看 / 编辑 / 删这些记忆条。

**Q: 我加的 Custom Lane 怎么删?**
A: 模型路由 Tab → 🛠 自定义 Lane 区域 → 找到那条 lane → 删除按钮。

**Q: 一定要按"广场 → 聊天"顺序吗?**
A: 是。剧本要从广场进,因为入场时会随机初始关系、队友、进度。

---

## 8. 故障排查

| 现象 | 可能原因 | 修法 |
|---|---|---|
| 进站白屏 | bundle 加载失败 | 强刷(Cmd+Shift+R / Ctrl+F5),或换浏览器 |
| BYOK 引导不弹 | 之前 dismiss 过 | localStorage 清掉 `wc_poc_byok_onboarded` 这一项 |
| 对话"⚠️ LLM 调用失败"卡片 | Key 错 / 余额没了 / 服务方挂 | 看卡片提示,点"去设置填 key"跳转设置 Tab |
| 对话半天没响应 | timeout(Hobby 10s) | 切到更快 Lane,或自己用 Pro plan |
| 看到 "⚠ N 个 store 写入失败" | localStorage 满了(~5MB 配额) | 在"存储用量"面板看哪些 key 占地大,导出后清掉旧剧本 |
| Custom Lane 一直 ❌ | Base URL 拼错 / 末尾带了 /v1 | URL 不要带尾部 /v1 / /chat/completions,路径由站点自己拼 |
| 跨设备进度对不上 | 没导出导入 | 见 6.4 节 |
| 关 tab 重开,立绘全没 | 立绘在 sessionStorage(关 tab 即清) | 已知行为,见 FAQ。同 tab 内玩到底,或备份 PortraitTab 单张 img → 上传作为 user_uploaded |

---

## 9. 高级用法

### 9.1 改 fallback 链

模型路由 Tab → 找到 Lane → 编辑 fallback → 调顺序。

适用场景:DeepSeek 不稳定时自动切 Codex API。

### 9.2 多 Key 池

每条 BYOK Lane 都有自己的 Key 输入框,可以同时配 3 家。

### 9.3 用本地 LLM(高级)

本机跑 vLLM / LM Studio / Ollama(OpenAI 兼容模式)→ 加自定义 Lane,Base URL 填 `http://localhost:xxxx`(注意:浏览器可能拦 mixed-content,要在 HTTPS 站点连 HTTP 本地服务,需开放 mixed content 例外)。

最佳方式还是**本地跑站点**(`npm run dev`),这样浏览器和 LLM 都在 localhost,无 CORS / mixed-content 问题。

### 9.4 编辑自定义剧本

剧本 JSON schema 在 `poc/lib/scenario-types.ts`(或同名文件)。在"广场"右上角加载自定义剧本 JSON。

---

## 10. 关于这个项目

这是个**同人非商业 PoC**。涉及作品(大唐双龙传 / 元末风云 / ...)版权属于原作者,本站仅作展示性二次创作,不收费、不出售、不收集用户数据。

部署 / 自建 / 改造请看根目录 `DEPLOY.md`。

源码与开发文档:见仓库 README。

---

**末更新**:2026-05-26

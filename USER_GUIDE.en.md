# World Crossing PoC — User Guide (English)

> AI roleplay / multi-scenario fan project · BYOK (Bring Your Own LLM Key) · No accounts · No server-side database

---

## 1. What is this

**World Crossing PoC** is a browser-based AI roleplay sandbox. You play a "world-crossing" protagonist who enters different scenario worlds, talks to NPCs, makes choices, recruits companions, and pushes the plot forward.

Core principles:

- **BYOK (Bring Your Own Key)**: LLM calls use *your* API key (DeepSeek / OpenAI / Anthropic / any OpenAI-compatible service). The site does not hold any keys.
- **Zero persistence**: All game progress lives in **your browser's localStorage only**. No accounts, no database, no user system.
- **Fan project**: Referenced IPs are non-commercial derivative showcases; we charge nothing and collect no user data.

---

## 2. 5-Minute Quickstart

### Step 1: Open the site

Open the URL (local: `http://localhost:3000`, or your Vercel domain).

First visit triggers the **👋 Welcome to World Crossing** onboarding modal:

- Project intro
- 🔒 Privacy guarantee
- Three key-application links

### Step 2: Get an LLM key (pick one)

| Service | Price | Best for | Get key |
|---|---|---|---|
| **DeepSeek** | $0.07 / $0.28 per 1M tokens (**cheapest, recommended for beginners**) | Heavy chat use, casual play | https://platform.deepseek.com/api_keys |
| **OpenAI** | GPT-5 family (pricey but smart) | Complex plots, nuanced NPCs | https://platform.openai.com/api-keys |
| **Anthropic** | Claude (strong Chinese literary style) | Period-setting scenarios, emotional scenes | https://console.anthropic.com/ |

> All three require a credit card / prepayment. If you don't want to use the providers directly, you can also use aggregator services (OpenRouter / Groq / SiliconFlow / Moonshot / Together / Fireworks etc.) — see Section 4 below.

### Step 3: Paste the key into Settings

1. Click the **"Settings / Credentials"** (设置 / 凭证) tab in the top nav
2. Paste the key in the BYOK Key section
3. It auto-saves to **browser localStorage** (the server never sees it)

### Step 4: Enter a scenario

1. Go back to the **"Plaza"** (广场) tab
2. Click any scenario card (**Interstellar Postman** / **Tang Twin Dragons** are good starters)
3. The **EntryModal** appears, showing `👥 Companions (0/N)` for you to optionally bring companions
4. Click **"Make a wish, depart →"** (发愿,启程 →) or **"Depart without a wish — walk into fate"** (无愿启程 — 走入命运。)
5. After a dice-roll animation, you land in the **"Chat"** (聊天) tab with the scene ready

### Step 5: Start chatting

The chat input is labeled **"💬 Speak to [NPC]"** (💬 对 [NPC] 说), e.g.:

- `💬 对寇仲说` (Tang Twin Dragons)
- `💬 对哈利亚说` (Interstellar Postman)

Type → Enter → the NPC responds via your configured Lane.

---

## 3. The 6 Top Tabs

| Tab (Chinese label) | Purpose |
|---|---|
| **广场** (Plaza) | Scenario list / favorites / scenario entry / progress cards |
| **聊天** (Chat) | Main interface: NPC dialog, Director plot pushes, companion banter, scene progress |
| **记忆固化** (Memory Consolidation) | Manage "memory" snippets that compress long conversations: view / edit / delete / export |
| **立绘** (Portraits) | NPC portrait picker / upload custom portraits |
| **模型路由** (Model Routing) | Configure which task uses which LLM lane, define custom lanes, run health checks |
| **设置 / 凭证** (Settings / Credentials) | BYOK key management, storage usage, export / clear data |

---

## 4. Model Routing in Detail

### 4.1 What is a Lane

A "Lane" is one LLM access channel. The public deployment ships 3 BYOK lanes by default:

- **Codex API** (OpenAI GPT family)
- **Claude API (BYOK)** (Anthropic Claude)
- **DeepSeek** (DeepSeek official)

### 4.2 Custom Lanes (any OpenAI-compatible service)

In Model Routing tab, the top section is **🛠 自定义 Lane(OpenAI 兼容)** ("Custom Lanes — OpenAI-compatible"). Click **"+ 添加自定义 Lane"** ("+ Add Custom Lane") and fill in:

| Field (Chinese label) | Notes | Example |
|---|---|---|
| **名称** (Name) | Display name, anything you like | `Groq Llama 70B` |
| **API Base URL** | Starts with `https://`. **Do not** include trailing `/v1` or `/chat/completions` — the site appends the path itself | `https://api.groq.com/openai` |
| **Model 名** (Model name) | Exact model ID, varies by provider | `llama-3.3-70b-versatile` |
| **API Key** | Stored in your browser localStorage only; server does not persist | `gsk_xxx...` |
| **备注 (可选)** (Notes, optional) | Shown on the lane's health card — useful for pricing reminders | `$0.59/M output, cheap 70B` |

**Common aggregator service mappings**:

| Service | Base URL | Example model |
|---|---|---|
| OpenRouter | `https://openrouter.ai/api` | `anthropic/claude-3.5-sonnet` |
| Groq | `https://api.groq.com/openai` | `llama-3.3-70b-versatile` |
| SiliconFlow | `https://api.siliconflow.cn` | `Qwen/Qwen2.5-72B-Instruct` |
| Moonshot | `https://api.moonshot.cn` | `moonshot-v1-32k` |
| Together | `https://api.together.xyz` | `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo` |
| Fireworks | `https://api.fireworks.ai/inference` | `accounts/fireworks/models/llama-v3p3-70b-instruct` |
| Azure OpenAI | `https://YOUR.openai.azure.com` | your deployment name |
| Self-hosted vLLM | `https://your-vllm.example.com` | your model id |

### 4.3 The Routing Matrix

Below the lane list is the Routing Matrix — a table where rows are task types (NPC core dialog / Director / companion banter / portrait description / memory compression…) and columns are lanes. Use the dropdown to assign each task to a lane.

### 4.4 Fallback Chains

Every lane can declare fallbacks (auto-failover if the primary fails). Example:
- Primary: DeepSeek → Fallback 1: Codex API → Fallback 2: your custom lane

The visual chain editor is below the routing matrix.

### 4.5 Health Checks

Each lane shows a health card (✅ healthy / ❌ down / ⚠ slow). Probed roughly every 30 seconds. New lanes without keys show ❌ immediately.

### 4.6 🎨 Custom Image Lanes (Portrait Generation)

A **separate, parallel** channel from LLM lanes, dedicated to image generation. Uses the **OpenAI Images API compatible protocol** — any service implementing `POST /v1/images/generations` works.

**Adding a lane**: Model Routing tab → scroll to "🎨 自定义 Image Lane(OpenAI Images API 兼容)" → click **"+ 添加 Image Lane"** → fill in:

| Field (Chinese label) | Notes | Example |
|---|---|---|
| **名称** (Name) | Display name | `OpenAI DALL-E 3` |
| **API Base URL** | Starts with `https://`, no trailing `/v1` or `/images/generations` | `https://api.openai.com` |
| **Model 名** (Model name) | Exact model ID, varies by provider | `dall-e-3` |
| **API Key** | Stored only in browser localStorage | `sk-...` |
| **尺寸 (size)** | OpenAI / FLUX support `1024x1024` `1024x1792` etc. | `1024x1024` |
| **质量 (quality)** | DALL-E 3: `standard`/`hd`. gpt-image-1: `low`/`medium`/`high`. Others ignore. | `standard` |
| **备注** (Notes) | Track price / purpose for yourself | `DALL-E 3 standard $0.04/image` |

**Common service mappings**:

| Service | API Base URL | Model example | ~Price per image |
|---|---|---|---|
| **OpenAI** DALL-E 3 | `https://api.openai.com` | `dall-e-3` | $0.04 (standard) / $0.08 (hd) |
| **OpenAI** gpt-image-1 | `https://api.openai.com` | `gpt-image-1` | $0.011 (low) / $0.063 (high) |
| **Together AI** FLUX | `https://api.together.xyz` | `black-forest-labs/FLUX.1-dev` | ~$0.025 |
| **Together AI** FLUX-pro | `https://api.together.xyz` | `black-forest-labs/FLUX.1.1-pro` | ~$0.04 |
| **SiliconFlow** Kolors | `https://api.siliconflow.cn` | `Kwai-Kolors/Kolors` | ¥0.04 |
| **Alibaba DashScope** Wanx | `https://dashscope.aliyuncs.com/compatible-mode` | `wanx-v1` | ¥0.20 |
| **Azure OpenAI** DALL-E 3 | `https://YOUR.openai.azure.com` | your deployment name | same as OpenAI |
| **Self-hosted ComfyUI / vLLM-image** | `https://your-host` | your model id | 0 |

**Generation triggers**:

1. **Automatic**: when you switch to an NPC inside a scenario AND that NPC has no cached portrait AND you haven't uploaded one → in public mode the site uses the **first** Image Lane in your list to auto-generate the NPC's neutral portrait, plus pre-generates other emotions per tier budget
2. **Manual**: Portrait tab (立绘) → "立绘生成 Lane C · BYOK 在线生图" card → pick lane → enter prompt → generate (link-test only, does not write back to NPC portrait)

**Critical notes**:

- 🚨 **Image generation is 100-1000× more expensive than text**. DALL-E 3 is ~$0.04 per image — a single evening across multiple NPCs / emotions can burn $5-10. On a budget, use **Together FLUX** or **SiliconFlow Kolors** (5-10× cheaper).
- 🚨 **Portraits live in sessionStorage (cleared when tab closes)**. Generated images are stored as base64 in browser `sessionStorage['wc_poc_portraits_v1']`; one 1024×1024 PNG is ~1.3 MB — 3-4 images fill the ~5 MB quota. **`sessionStorage` is wiped when you close the tab, isn't shared across tabs / browsers, and is NOT included in "⬇ Export All Progress"**. In other words: every fresh session re-generates portraits = re-pays. This is a known limitation; if you generate heavily, finish the session in one tab without closing.
- ⚠ **Skipping Image Lanes doesn't break gameplay**. In public mode with 0 Image Lanes, auto-generation silently skips — you can still upload images manually per NPC, or use a scenario's bundled portraits (some have them).
- ⚠ **OpenAI auto-revises your prompt**. DALL-E 3 / gpt-image-1 rewrite prompts to prevent abuse; the Lane C test card displays the rewritten version. Other services usually don't.

---

## 5. The 8 Built-in Scenarios

| Scenario (Chinese title) | Genre | Beginner pick |
|---|---|---|
| **星际邮差** (Interstellar Postman) | Sci-fi · Space adventure | ⭐ Most complete tutorial flow |
| **大唐双龙传** (Tang Twin Dragons) | Wuxia · Period ensemble | ⭐ Most natural Chinese dialog |
| **念念** (Niannian) | Modern · Emotional | - |
| **簪花** (Hairpin Flowers) | Period · Female perspective | - |
| **申城谜影** (Shanghai Mysteries) | 1930s Republican · Mystery | - |
| **回光** (Afterglow) | Post-apocalyptic · Psychological | - |
| **元末风云** (End of Yuan Dynasty) | Historical · Political intrigue | - |
| **挽歌之矛** (Spear of the Dirge) | Fantasy · War | - |

> Want to add your own scenario? Plaza top-right has an "import custom scenario" option (stored in localStorage key `wc_poc_custom_scenarios_v1`).

---

## 6. Data / Privacy / Export (Settings / Credentials tab)

### 6.1 Where your data lives

**Two layers: most progress lives in localStorage (persistent + exportable); generated portrait cache lives separately in sessionStorage (wiped when you close the tab).**

**localStorage** (survives tab close / browser restart; included in "⬇ Export All Progress"):

| Key | Contents |
|---|---|
| `wc_poc_plaza_v1` | Plaza data (companions / items / progress / relationships / NPC-spec embedded portraits) |
| `wc_poc_router_v2` | Routing presets / overrides / fallback chains |
| `wc_poc_pref_v1` | User preferences (default model etc.) |
| `wc_poc_byok_onboarded` | Whether BYOK onboarding was dismissed |
| `wc_poc_custom_lanes_v1` | Custom LLM lanes (apiKey embedded inline) |
| `wc_poc_custom_image_lanes_v1` | Custom Image Lanes (apiKey embedded inline) |
| `wc_poc_custom_scenarios_v1` | Custom scenarios |
| `wc_poc_apikey_*` | Standalone BYOK API keys (**sensitive**, not exported by default) |

**sessionStorage** (**wiped the moment you close the tab**, **NOT** included in exports, **NOT** shared across tabs / devices):

| Key | Contents |
|---|---|
| `wc_poc_portraits_v1` | Generated portrait cache (NPC × emotion → base64 dataUrl) |

> ⚠️ **Portraits are single-tab session-scoped caches**. Reopening the browser, closing the tab, opening a new window, switching devices — portraits are all lost and must be re-generated (= re-paid). If you're doing heavy online image generation, **stay in one tab until you're done**. This is a known limitation; we're evaluating migration to localStorage (5 MB shared quota, fills fast) or IndexedDB (50 MB+, requires async refactor).

### 6.2 Export all progress

Settings tab → **Storage Usage** panel → click **"⬇ 导出全部进度(JSON)"** ("⬇ Export All Progress (JSON)").

- By default the export **excludes standalone BYOK API keys** (safe to share). Note: the apiKey field *embedded* inside each Custom Lane / Image Lane object IS included by default — if you want a fully scrubbed export, delete those lanes in ModelsTab before exporting.
- Checking "include keys" pops a confirm dialog; after confirming, the standalone `wc_poc_apikey_*` keys are also included.
- ⚠️ **sessionStorage portrait cache is NOT included** — after cross-device migration, portraits need to be re-generated.

### 6.3 Clear data

The clear button is at the bottom of the Settings tab. After clearing, you're back to a brand-new user state (BYOK onboarding will re-trigger).

### 6.4 Cross-device migration

Device A → export JSON → send the file to yourself → Device B → same site → Settings tab "Import" button → upload JSON.

### 6.5 Privacy guarantee (shown in footer)

> 🔒 No accounts · No data collection · All progress lives only in your browser · API calls are BYOK direct to third parties

The server endpoint `/api/openai-compat` is a **zero-knowledge proxy**: it does not persist, log, or cache your key or baseUrl.

---

## 7. FAQ

**Q: Can I play without a credit card?**
A: No. LLM calls require a real key. DeepSeek has the lowest entry barrier (~¥10 / few USD prepay) — start there.

**Q: Will my key be sent to "the author"?**
A: No. Your key is stored in your browser localStorage only, and is forwarded only at the moment you press send, via the `/api/openai-compat` zero-knowledge proxy, to the LLM provider you specified. Code is open source — verify it yourself.

**Q: Will I lose progress?**
A: Yes, if you clear browser cache / switch browsers / switch devices. **Make periodic "⬇ Export All Progress" your habit** and store the JSON in iCloud / Dropbox / Google Drive.

**Q: Why are my portraits all gone after closing and reopening the browser, when chat history / companions / progress are all preserved?**
A: Portrait cache is **shorter-lived** than other data — it lives in browser sessionStorage (`wc_poc_portraits_v1`), which is wiped on tab close. Scenario progress etc. live in localStorage and persist. This is because base64 images are large (~1.3 MB per 1024×1024), and we didn't want them to compete with scenario data for the shared 5 MB localStorage quota. The trade-off is that each new tab regenerates portraits. **Short-term workaround**: stay in one tab; **mid-term**: see section 6.1 — we're evaluating a migration to localStorage.

**Q: What if a chat times out?**
A: On Vercel Hobby plan, API routes time out at 10s and long LLM responses get cut. Upgrade to Vercel Pro ($20/mo) for 60s timeout. Or switch to a faster lane (Groq / local vLLM).

**Q: How do I change an NPC's portrait?**
A: Top nav → "立绘" (Portraits) tab → pick the NPC → choose / upload an image.

**Q: What does "Memory Consolidation" do?**
A: Long conversations eventually blow LLM context limits. Memory Consolidation compresses old dialog into a few key bullet points to free up room. The "记忆固化" tab lets you view / edit / delete these memory snippets.

**Q: How do I delete a Custom Lane I added?**
A: Model Routing tab → 🛠 Custom Lanes section → find the lane → delete button.

**Q: Do I have to go Plaza → Chat in order?**
A: Yes. Scenarios must be entered from the Plaza because entry randomizes initial relationships, companions, and progress.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| White screen on load | Bundle failed to load | Hard refresh (Cmd+Shift+R / Ctrl+F5), or try another browser |
| BYOK onboarding never appears | You dismissed it previously | Clear localStorage key `wc_poc_byok_onboarded` |
| "⚠️ LLM call failed" card in chat | Wrong key / out of credit / provider down | Read the card; click "Go to settings to enter key" to jump to Settings |
| Chat hangs with no response | Timeout (Hobby plan = 10s) | Switch to a faster lane, or upgrade to Pro plan |
| "⚠ N stores failed to write" banner | localStorage is full (~5 MB quota) | Open Storage Usage panel; see which keys are largest; export then clear old scenarios |
| Custom lane stays ❌ | Base URL malformed / has trailing `/v1` | Base URL must not include `/v1` or `/chat/completions` — the site appends the path |
| Cross-device progress doesn't match | You didn't export / import | See Section 6.4 |
| Portraits all gone after closing tab | Portrait cache is in sessionStorage (cleared on tab close) | Known behavior, see FAQ. Stay in one tab, or back up individual images from PortraitTab → upload as user_uploaded |

---

## 9. Advanced

### 9.1 Edit fallback chain

Model Routing tab → find the lane → edit fallback → reorder.

Use case: auto-failover from DeepSeek (sometimes unstable) to Codex API.

### 9.2 Multiple key pools

Each BYOK lane has its own key input — you can configure all 3 providers simultaneously.

### 9.3 Use a local LLM (advanced)

Run vLLM / LM Studio / Ollama locally in OpenAI-compatible mode → add a Custom Lane with Base URL `http://localhost:xxxx`.

Caveat: browsers block mixed-content (HTTPS site connecting to HTTP localhost). You'd need to allow mixed-content for the site.

The cleanest approach is to **run the site locally too** (`npm run dev`) — then both browser and LLM are on localhost, no CORS / mixed-content issues.

### 9.4 Edit custom scenarios

The scenario JSON schema is defined in `poc/lib/scenario-types.ts` (or similarly named). Load custom scenario JSON from the top-right of the Plaza.

---

## 10. About this project

This is a **non-commercial fan PoC**. Referenced IPs (Tang Twin Dragons / End of Yuan Dynasty / …) belong to their original authors; this site is purely a showcase of derivative work, charges nothing, sells nothing, and collects no user data.

For deployment / self-hosting / forking, see `DEPLOY.md` in the repo root.

Source code and developer docs: see the repository README.

---

**Last updated**: 2026-05-26

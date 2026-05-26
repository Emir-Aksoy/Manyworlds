# Manyworlds

> Browser-only AI roleplay runtime · **BYOK (Bring Your Own Key)** · Zero-knowledge proxy · Multi-lane LLM router with fallback chains · OpenAI Images API–compatible portrait generation · Next.js 14 / React 18 / TypeScript 5

A single-developer proof-of-concept that asks: **what does an AI roleplay sandbox look like if the platform holds no user data, no API keys, no database — and the player still gets a 30+ NPC scenario with auto-generated portraits, multi-emotion state, and a director-driven plot?**

This repo is the answer. It runs on Vercel Hobby (free tier), the server-side surface is a single zero-knowledge proxy lambda, and all gameplay state — including generated portraits — lives in the player's own browser.

**[🎮 Try the live demo →](https://manyworlds-three.vercel.app/)** (BYOK · bring your own LLM key) · [中文使用手册](./USER_GUIDE.zh-CN.md) · [English user guide](./USER_GUIDE.en.md) · [Deploy guide](./DEPLOY.md)

---

## Why it's interesting (technical highlights)

### 1. Zero-knowledge BYOK architecture
- API keys live exclusively in the player's `localStorage`. The server **never** persists, logs, or caches them.
- Every LLM / image call is a one-shot proxy hop: client attaches `Authorization: Bearer <key>` + `X-Wc-Base-Url: <user-chosen base>`, server forwards once, response is streamed back.
- Single shared proxy endpoint (`/api/openai-compat` for chat, `/api/image-compat` for portraits) — adding a new BYOK provider requires zero server-side changes.
- Means: **Vercel Hobby plan, no DB, no auth, no GDPR / data-retention surface area.**

### 2. Multi-lane LLM router with type-safe fallback chains
- 7 built-in lanes (Codex / Claude / DeepSeek / local Gemma / ...) + N user-defined custom lanes.
- 8 task tags (`director.beat`, `npc.core.dialogue`, `companion.banter`, `memory.consolidate`, ...) routed independently — you can put NPC dialogue on Claude and memory consolidation on DeepSeek.
- `FALLBACK_CHAIN: Record<BuiltinLaneId, LaneId[]>` — TypeScript enforces that adding a new built-in lane forces a fallback declaration (no silent gaps).
- Runtime mode detection (`isPublicMode()`): the public deployment automatically hides bridge lanes that require local processes; the same codebase boots in "dev" mode locally with the full lane set.

### 3. WC-EVENT structured-output protocol
- NPCs emit inline structured tags as part of their natural dialogue:
  - `<WC-STAT id="player.hp" delta="-5" reason="刀伤" />` — combat / stat changes
  - `<WC-TRUST delta="+10" archetype="cautious-warrior" />` — relationship deltas
  - `<WC-EVENT type="companion-died" />` — narrative events
  - `<WC-EVENT type="location-spawned" id="..." name="..." />` — dynamic location creation
- Parser (`lib/llm-events.ts`) extracts tags, applies validated deltas to game state, strips them from the dialogue shown to the user.
- Includes a parse-failure ring buffer + emotion-detect fallback so a malformed LLM output never silently desyncs game state.

### 4. BYOK portrait generation (OpenAI Images API compatible)
- Same architecture as the LLM lanes: users add a Custom Image Lane (OpenAI / Together FLUX / SiliconFlow / Alibaba DashScope / Azure / self-hosted), the framework proxies to it.
- 5 emotion-aware portraits per NPC (`neutral` / `happy` / `serious` / `concerned` / ...), auto-prompted from the NPC's `base_prompt`, tier-budgeted so passing NPCs don't blow your API budget.
- Server normalizes responses: providers returning `b64_json` get passed through, providers only returning `url` get fetched server-side and converted to data URLs — uniform `dataUrl` interface to the client regardless of upstream provider.

### 5. Tiered prompt segmentation + trust archetypes
- System prompts are built from 10 named segments (`identity`, `loreDigest`, `loreChunks`, `wcEventRules`, `trustMatrix`, `stats`, `currentLocation`, ...) — turning prompts on/off per NPC tier (`core` / `side` / `passing`) cut token usage ~40% with no perceived quality drop.
- 30+ NPCs each carry a `trust_archetype` (`cautious-warrior` / `flirtatious-charmer` / `stoic-mentor` / ...) — the WC-TRUST matrix is tailored per archetype rather than one-size-fits-all.

### 6. DLC-style scenario loading
- Scenarios are JSON files dropped into `public/dlc/` and registered in `manifest.json`. The framework validates schema, merges NPC rosters at runtime, supports cross-scenario companion persistence.
- Schema includes: world, factions, locations (with connections + scene state), NPCs (with appearance, persona, lore tags), beats (triggered events), artifacts, dynamic location spawning.

### 7. Vercel one-lambda deployment
- A prebuild script (`scripts/prebuild-exclude-dev-routes.mjs`) detects Vercel CI (`VERCEL=1`) and physically moves `/api/local-*` routes out of the Next.js tree before build — they don't get registered as lambdas.
- Result: deployed app has **1 lambda** (the `image-compat` proxy) instead of 5. Hobby plan's 12-lambda cap stays wide open for future features.
- Local `npm run dev` is unaffected (no `VERCEL=1`).

---

## Quick start

```bash
npm install
npm run dev
# open http://localhost:3000
```

First run pops a BYOK onboarding modal explaining the privacy model and linking to 3 LLM key providers. Add a key, pick a scenario (try **Star Mail** — most complete tutorial), start chatting.

Want online portrait generation? Settings → Model Routing → 🎨 Custom Image Lane → add one (OpenAI DALL-E 3 / Together FLUX / etc.).

---

## Stack

- **Next.js 14.2** (App Router, RSC where applicable)
- **React 18.3** (client components for the playable surface)
- **TypeScript 5.5** in strict mode
- **No backend** other than 1 zero-knowledge proxy route
- **No database**, no auth, no session middleware
- **No tracking / analytics**

Dependencies (production):
```
next  react  react-dom
```
That's it. The codebase has zero runtime npm deps beyond Next + React.

---

## Architecture (one-screen view)

```
┌───────────────────────────────────────────────────────────────┐
│                        Browser (localStorage)                 │
│                                                               │
│   plaza state ──┐    router config ──┐   custom-lanes ──┐    │
│                 ↓                    ↓                   ↓    │
│   ┌──────────────────────────────────────────────────────┐    │
│   │              page.tsx  (React UI)                    │    │
│   │  ┌────────────────┐    ┌────────────────────┐        │    │
│   │  │  ChatTab       │    │  ModelsTab          │        │    │
│   │  │  - NPC chat    │    │  - LLM lanes + matrix│       │    │
│   │  │  - WC-EVENT    │    │  - Image lanes (BYOK)│       │    │
│   │  │    parser      │    │  - Fallback chains   │       │    │
│   │  └───────┬────────┘    └─────────────────────┘        │    │
│   │          │                                             │    │
│   │  ┌───────▼─────────────────────────────────┐           │    │
│   │  │ Gateway (lib/gateway.ts):                │           │    │
│   │  │ - task → lane resolution                 │           │    │
│   │  │ - fallback chain executor                │           │    │
│   │  │ - LLM health probe                       │           │    │
│   │  └───────┬─────────────────────────────────┘           │    │
│   └──────────┼─────────────────────────────────────────────┘    │
│              │ fetch + Bearer + X-Wc-Base-Url                   │
└──────────────┼──────────────────────────────────────────────────┘
               ↓
┌──────────────────────────────────────────────────────────────┐
│      Vercel (single lambda) — zero-knowledge proxy           │
│                                                              │
│   /api/openai-compat   →  third-party LLM (forward once)     │
│   /api/image-compat    →  third-party image API (forward once)│
│                                                              │
│   No DB, no logs, no cache, no auth.                         │
└──────────────────────────────────────────────────────────────┘
                       ↓
              user's chosen LLM / image provider
        (OpenAI / Anthropic / DeepSeek / Together / fal / ...)
```

---

## Project layout

```
lib/
  gateway.ts              # callLLM, fallback chain executor, lane health
  router.ts               # task ↔ lane matrix, preset / override store
  runtime-mode.ts         # dev vs public detection + lane visibility
  models.ts               # LaneId types, LANES dict (single source of truth)
  custom-lanes.ts         # user-defined LLM lanes (localStorage CRUD)
  image-lanes.ts          # user-defined image lanes (parallel system)
  llm-events.ts           # WC-EVENT / WC-STAT / WC-TRUST parser
  characters.ts           # NPC system prompt builder (10-segment)
  director.ts             # narrative-advance prompt builder
  plaza.ts                # game state store (companions / inventory / progress)
  full-export.ts          # multi-store backup/restore
  store-write-helper.ts   # localStorage quota-exposure helper

app/
  page.tsx                # single-page UI (Plaza / Chat / Memory /
                          # Portrait / ModelsTab / SettingsTab)
  api/
    openai-compat/        # main LLM proxy (zero-knowledge)
    image-compat/         # main image-gen proxy (zero-knowledge)
    local-*/              # dev-only bridges (dev-only-guard + Vercel exclude)

public/dlc/
  manifest.json           # scenario registry
  starmail.json           # original scenarios (6 tracked in git)
  niannian.json
  zanhua.json
  shanghai-noir.json
  hui-guang.json
  yuanmo.json

scripts/
  prebuild-exclude-dev-routes.mjs   # Vercel one-lambda magic
```

---

## Writing your own scenario

Each scenario is a single JSON file conforming to the schema implied by `lib/scenario-types.ts` (validated at load time by `lib/scenario-validator.ts`). The file declares:

- `world` (overview + factions + locations + connections)
- `npcs[]` (identity, appearance, persona, trust_archetype, lore_tags)
- `loreDigest` (≤500 char world summary, injected into every NPC prompt)
- `loreChunks[]` (lore segments injected only into NPCs tagged with matching `lore_tags`)
- `beats[]` (triggered narrative events with conditions)

Look at `public/dlc/starmail.json` for a clean reference (~1100 lines, sci-fi space-mail setting). The other 5 tracked scenarios are useful comparison points — each has a different theme (period harem drama, modern crime, 1930s noir, etc.).

---

## What's *not* in this repo

This is a personal portfolio / learning project. The author's working tree contains additional scenarios that are derivative works of third-party IP (e.g. Huang Yi's *Tang Twin Dragons* novel series, Games Workshop's *Warhammer 40,000*). To avoid trademark and copyright complications, **those scenario data files and their build scripts are listed in `.gitignore` and not redistributed**. The framework code itself is fully MIT-licensed and supports loading any user-authored scenario JSON.

If you want a derivative scenario, write your own conforming to the schema and drop it in `public/dlc/`.

---

## License & disclaimer

**Framework code**: MIT (see [LICENSE](./LICENSE)).

**Disclaimer**: This is a personal, non-commercial proof-of-concept built for learning, portfolio, and technical demonstration. No commercial offering, no paid features, no user data collection, no third-party tracking. The framework provides a generic loader for scenario JSON — any specific scenario content is the responsibility of whoever authored / deployed it. Trademarks, character names, and worldbuilding elements of any referenced works remain the property of their respective rights holders.

---

## Acknowledgments

Built on the shoulders of:
- Next.js + React + Vercel (deployment platform)
- The BYOK SaaS pattern popularized by SillyTavern, t3.chat, librechat, et al.
- OpenAI for the chat-completions + images-generations API surface that became a de facto standard

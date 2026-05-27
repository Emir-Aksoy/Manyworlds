# Manyworlds 剧本作者 Brief — P4 World Tick

> **自包含写作规范.** 拿这一份 + GitHub repo URL,你即可独立完成一份大型 scenario JSON 交付.

---

## 0 · 项目速读

**Manyworlds** ([github.com/Emir-Aksoy/Manyworlds](https://github.com/Emir-Aksoy/Manyworlds) · [live demo](https://manyworlds-three.vercel.app/)) 是一个浏览器跑的 AI 角色扮演沙盒.

- **BYOK** (Bring Your Own Key) — 玩家自带 LLM API key
- **Zero-knowledge proxy** — 服务端不存任何用户数据
- **DLC 化剧本** — 每个剧本是一份 JSON 文件,放在 `public/dlc/<id>.json`,启动时 framework 自动加载

玩家进入剧本后,主要交互形态:跟剧本里的 NPC 对话、推进剧情节点 (beats / milestones)、收集队友、解锁多 ending. 所有 NPC 对话由 LLM 驱动 (通过 BYOK 走 zero-knowledge proxy).

**P4 World Tick** 是当前要做的引擎升级:给所有剧本加 *时间流逝感* + *NPC 自主作息* + *时间驱动的世界事件*. 让世界从"永恒当下"变成"自主演化". 详见 §4-§6.

---

## 1 · 你这次的任务

写一份 (或扩展) 一个**大型** scenario JSON,符合 P4 World Tick schema. 三个 P4 新字段是工作重点:

1. **`Scenario.eraTemplate`** — 剧本自定义时间渲染格式 (古风 / 现代 / 科幻 都行,详见 §4)
2. **`Scenario.worldEvents[]`** — 时间驱动的预设事件列表 (详见 §5)
3. **`CharacterSpec.schedule`** — NPC 一天作息表 (详见 §6)

规模目标 (详见 §7):

| 维度 | 推荐值 |
|---|---|
| In-game 时间跨度 | 60-120 天 |
| `worldEvents` 总数 | 40-60 个 |
| Locations | 8-15 个 |
| NPCs total | 18-28 (core 6-8 + side 8-12 + passing 4-8) |
| 实际游戏时长目标 | 40-60 小时 |

---

## 2 · 工作环境

```bash
git clone https://github.com/Emir-Aksoy/Manyworlds.git
cd Manyworlds
npm install   # 只用到 tsx + node, 不需要起 next dev

# 看现有公开剧本作风格参考
ls public/dlc/
#   starmail.json niannian.json zanhua.json shanghai-noir.json hui-guang.json yuanmo.json manifest.json

# 看 P4 example
cat docs/example-scenario-p4.json

# 写完你的 scenario 后跑 validator
npx tsx scripts/validate-scenario-p4.mts <你的 scenario.json>

# 类型检查 (确保你的 JSON 跟 TypeScript types 一致, 全 framework 没破)
npm run typecheck
```

---

## 3 · Scenario JSON 顶层结构

每份 scenario JSON 的 top-level keys 完整列表 (✅ 必填 · ⚪ 可选 · ⭐ P4 新增):

| 字段 | 状态 | 说明 |
|---|---|---|
| `id` | ✅ | kebab-case,全 framework 唯一 |
| `name` | ✅ | 显示名 (中文) |
| `shortName` | ✅ | 短名,UI 用 |
| `description` | ✅ | 一两句话介绍 (给玩家看,**不**直接进 LLM) |
| `openingNarration` | ✅ | 开场旁白 (玩家首次进入剧本时显示) |
| `defaultNpcId` | ✅ | 默认对话 NPC 的 character_id |
| `npcs` | ✅ | NPC 列表 (CharacterSpec[]) |
| `entryCost` | ✅ | 进入剧本花费的"原力"(0 = 免费) |
| `forceReward` | ✅ | `{min, max}` 完成度奖励范围 |
| `loreDigest` | ⚪ | ≤500 字世界观浓缩 (**强烈建议填**,大型剧本必填) |
| `loreChunks` | ⚪ | 按 NPC `lore_tags` 注入的分块 lore (大型剧本必填) |
| `locations` | ⚪ | 地点列表 (大型剧本必填) |
| `initialLocation` | ⚪ | 玩家起始 location id (locations 非空时必填) |
| `targetMilestones` | ⚪ | 完成度目标 milestone 数 |
| `factions` | ⚪ | 派系列表 (建议大型剧本写 3-5 个) |
| `dynamicLocations` | ⚪ | 允许 LLM 即兴造新地点 |
| `difficulty` | ⚪ | 'easy' / 'normal' / 'hard' |
| `playerSoulIdentity` | ⚪ | "灵魂进入"模式的预设主角 |
| `magicTags` | ⚪ | 剧本允许的魔法系统标签 |
| `llmConfig` | ⚪ | 自定义 LLM 调用参数 |
| `promptSegments` | ⚪ | 自定义 prompt 段补丁 |
| `scenes` / `startSceneId` | ⚪ | 玩家行动驱动的线性骨架 (大型剧本通常不用) |
| **`eraTemplate`** | ⭐ | **P4 — 时间渲染模板**,详见 §4 |
| **`worldEvents`** | ⭐ | **P4 — 时间驱动事件**,详见 §5 |

权威 type 定义见 [`lib/scenarios/index.ts:413`](https://github.com/Emir-Aksoy/Manyworlds/blob/main/lib/scenarios/index.ts) (`interface Scenario`).

---

## 4 · ⭐ P4 — `eraTemplate` (时间渲染)

每个剧本自己定义时间显示格式. `plaza.worldClock` 是数字三元组 `{era, year, month, day, hour}`,framework 按 template 字符串按需插值渲染.

### Schema

```ts
interface EraTemplate {
  template: string;
  initial: {
    era: string;     // 字面 era 名 (可空字符串)
    year: number;
    month: number;
    day: number;     // 从 0 起递增, 不归月
    hour: number;    // 0-23
  };
  dictionaries?: Record<string, Record<string, string>>;
}
```

### 插值规则

template 字符串里用 `{xxx}` 占位符. framework 渲染时:

- `{era}`, `{year}`, `{month}`, `{day}`, `{hour}` — 直接插 worldClock 当前值
- `{anything}` (其它名字) — 走 `dictionaries.anything[<key>]` 字典映射,未命中 fallback 到 raw 数字

### 例 1: 古风

```json
{
  "eraTemplate": {
    "template": "{era}{year}年{month}月{day}日 {hourName}",
    "initial": { "era": "永宁", "year": 21, "month": 3, "day": 12, "hour": 8 },
    "dictionaries": {
      "hourName": {
        "0": "子时", "2": "丑时", "4": "寅时", "6": "卯时",
        "8": "辰时", "10": "巳时", "12": "午时", "14": "未时",
        "16": "申时", "18": "酉时", "20": "戌时", "22": "亥时"
      }
    }
  }
}
```

渲染示例:`永宁21年3月12日 辰时`

### 例 2: 现代

```json
{
  "eraTemplate": {
    "template": "Day {day}, {hour}:00",
    "initial": { "era": "", "year": 0, "month": 0, "day": 0, "hour": 8 }
  }
}
```

渲染示例:`Day 0, 8:00`

### 例 3: 科幻

```json
{
  "eraTemplate": {
    "template": "M{era}.{day} · {hour}h",
    "initial": { "era": "41523", "year": 0, "month": 0, "day": 0, "hour": 8 }
  }
}
```

渲染示例:`M41523.0 · 8h`

### 缺省行为

不写 `eraTemplate` → framework 默认渲染 `第 {day} 天 第 {hour} 时`. 大型剧本**强烈建议**写专属 eraTemplate,这是世界观氛围的关键一笔.

---

## 5 · ⭐ P4 — `worldEvents` (时间驱动事件)

### Schema

```ts
interface WorldEvent {
  id: string;                       // kebab-case 唯一 (剧本内)
  when: {
    day_from: number;               // ≥ 0
    day_to: number;                 // ≥ day_from
    hour_from?: number;             // 可选, 0-23
    hour_to?: number;               // 可选, > hour_from, 1-24
  };
  requires_milestones?: string[];   // 必须已完成的 milestone / beat id
  short_summary: string;            // 15-30 字, UI 用
  description: string;              // 50-150 字, LLM 注入 NPC prompt 用
  visibility:                       // 谁会感知到
    | 'public'                      //   - 所有 NPC
    | `faction:${string}`           //   - 仅该 faction 成员
    | `location:${string}`;         //   - 仅当时在该 location 的 NPC
  affects?: {
    worldFlags?: Record<string, string>;  // 写入 plaza.worldFlags, 后续可读取
  };
  narrate?: boolean;                // P3 Narrator Lane 集成后启用, 现在先填 false / 省略
}
```

### 触发条件 — AND 全满足

1. 当前 `plaza.worldClock` 落在 `when` 区间 (若 hour_from/hour_to 有,hour 也命中)
2. `requires_milestones` 全部已完成 (缺省 = 无前置)
3. `plaza.worldEventsFired` 不含此 id (每个 event 只 fire 一次)

### 触发后效果

- 写入 `plaza.worldLog` (玩家可见的世界事件流, UI 一个 tab 渲染)
- 接下来命中 visibility 的 NPC 对话时,system prompt 注入"近期听说: {description}"
- `affects.worldFlags` 写入 `plaza.worldFlags`,后续 `Beat.trigger` / NPC prompt 可引用
- 此 event id 加入 `plaza.worldEventsFired` (后续不再触发)

### visibility 语义详解

- **`public`** — 全员知道. 用于:战争 / 王朝改元 / 公开惨案 / 自然灾害
- **`faction:imperial`** — 仅"imperial"派系 NPC 知道. 用于:派系内部决议 / 密令 / 调遣
- **`location:port-alpha`** — 仅当时在该 location 的 NPC 知道. 用于:本地小事件 / 现场目击

### 完整例子

```json
{
  "id": "evt-north-rebellion-day7",
  "when": { "day_from": 7, "day_to": 9, "hour_from": 18, "hour_to": 24 },
  "requires_milestones": ["ms-arrived-capital"],
  "short_summary": "北疆三州哗变,守将连夜出逃",
  "description": "入夜,北疆传来快马:三个边州守军同时哗变,主帅尉迟拓连夜带亲卫弃城出逃. 流民已开始南渡. 朝廷震动.",
  "visibility": "public",
  "affects": { "worldFlags": { "north-rebellion": "active" } }
}
```

---

## 6 · ⭐ P4 — `CharacterSpec.schedule` (NPC 作息)

### Schema

```ts
interface ScheduleEntry {
  days?: number[];           // 适用 in-game day 列表 (从 0 起); 缺省 = 每天
  hours: [number, number];   // [start, end); 跨日合法 [22, 4] (表示 22:00 到次日 04:00)
  locationId: string;        // 必须在 scenario.locations 白名单
  action: string;            // 给 LLM 看的状态描述, 如 "在书房读书 / 在酒馆喝酒 / 在港口巡视"
}

// 在 NPC 对象顶层
interface CharacterSpec {
  // ... 其它字段
  schedule?: ScheduleEntry[];
}
```

### 解析规则

给定 `(day, hour)`,从 `schedule[]` 找第一个命中 entry:

- **命中** = `(days 缺省 OR day ∈ days)` AND `hour ∈ [start, end)` (跨日时反向)
- **多 entry 重叠** → 取第一个命中 (写在前面的优先)
- **没命中任何 entry** → fallback 到 `NPC.locations[0]` (或剧本 defaultLocation), action = "无所事事"

### 例: 邮局柜员一天

```json
"schedule": [
  { "hours": [6, 9],   "locationId": "frank-port",     "action": "在邮局柜台分拣晨班信件" },
  { "hours": [9, 12],  "locationId": "frank-market",   "action": "去市集采购晚餐食材" },
  { "hours": [12, 14], "locationId": "frank-tavern",   "action": "在酒馆吃午饭" },
  { "hours": [14, 18], "locationId": "frank-port",     "action": "在邮局柜台处理下午班" },
  { "hours": [18, 22], "locationId": "frank-tavern",   "action": "在酒馆聊天" },
  { "hours": [22, 6],  "locationId": "frank-dorm",     "action": "睡觉" }
]
```

### 谁需要写 schedule?

| NPC 等级 | 需要 schedule? |
|---|---|
| **Core** (主线 NPC, 玩家会反复对话) | ✅ **必须**,设计 5-7 个 entry 覆盖全 24h |
| **Side** (配角, 玩家会找几次) | ✅ **必须**,5-7 个 entry |
| **Passing** (一次性过场角色) | ❌ **不要写**,passing NPC 不参与时间模拟 |

### Schedule 设计 tips

- 一天典型 4-6 个 entry,覆盖完整 24 小时
- 给"睡觉"留 6-8 小时 (夜深时段),时段内 NPC selector UI 会显示"现在不便打扰"
- 关键剧情 NPC 在特定 day 的特殊安排 → 用 `days: [12]` 写 override entry,放在数组前面
- `action` 字段是给 LLM 看的当前状态描述,直接进 prompt,要写得有画面感

---

## 7 · 大型剧本规模指引

Manyworlds 推荐的"大型"剧本配置 (你的目标):

| 维度 | 推荐值 | 说明 |
|---|---|---|
| In-game 时间跨度 | 60-120 天 | 主线弧线 |
| `worldEvents` 总数 | 40-60 个 | 平均每 3-5 in-game day 1 个 |
| 公开事件比例 | ~40% public, 30% faction, 30% location | visibility 分布建议 |
| Locations | 8-15 个 | 含连接 (`connections`) |
| NPCs (core) | 6-8 个 | 主线必有 schedule |
| NPCs (side) | 8-12 个 | 配角必有 schedule |
| NPCs (passing) | 4-8 个 | 一次性过场,无 schedule |
| 主要 NPC schedule 条目 | 5-7 条/NPC | 覆盖全 24h |
| loreDigest | ≤500 字 | 世界观速读 |
| loreChunks | 6-10 块 | 按主题切, NPC 按 `lore_tags` 看 |
| Factions | 3-5 个 | 派系定义 |
| 总文本字数 | 100-300k 字 | 含 NPC persona / location desc / events / chunks |
| 实际游戏时长 | 40-60 小时 | 跨多周目 |

### 时间节奏建议

把 worldEvents 散布在整个剧本时间跨度上,而不是堆在前几天.

**建议分布:**

| In-game 时段 | events 密度 | 用途 |
|---|---|---|
| Day 0-5 (开局) | 4-6 个 | 建立世界 + 玩家熟悉环境 |
| Day 5-30 (推进) | 15-20 个 | 主要剧情铺垫 |
| Day 30-60 (中段) | 12-18 个 | 矛盾激化 + 玩家选择影响 |
| Day 60-90 (转折) | 8-12 个 | 关键转折点 (visibility 多用 faction) |
| Day 90+ (收尾) | 5-8 个 | 大事件 (visibility 多用 public) |

### 设计原则

1. **events 跟 NPC schedule 互动** — 比如 `evt-tavern-fire-day20` (visibility: `location:tavern`),触发后那天还在酒馆作息的 NPC 都直接见证,情绪反应应该最激烈
2. **events 通过 worldFlags 影响 beats** — `affects.worldFlags: { war-broke-out: 'yes' }`,后续 beats 可在 trigger 里写 `requires_worldFlag: 'war-broke-out'`
3. **visibility 不要全是 public** — 大量 public events 会让所有 NPC 都念同一段台词. 多用 faction / location 让信息有差,推动玩家主动跨地点跨派系收集情报

---

## 8 · 完整 Working Example

完整可校验的小型 reference scenario 在 `docs/example-scenario-p4.json` (已 commit 进 repo).

- 5 天故事弧
- 3 locations (灯塔 / 渔村 / 礁石)
- 4 NPCs (3 有 schedule, 1 passing 无 schedule)
- 5 worldEvents (覆盖 public / faction / location 三种 visibility)
- 古风 + 现代混搭 eraTemplate

**这只是结构示例,你的剧本要大很多** (40+ events, 18+ NPCs). 但字段填法完全照搬即可.

直接跑校验:

```bash
npx tsx scripts/validate-scenario-p4.mts docs/example-scenario-p4.json
# 输出: [validate-p4] OK
```

---

## 9 · 校验流程

写完你的 scenario 后:

### 1. 跑 validator

```bash
npx tsx scripts/validate-scenario-p4.mts public/dlc/<your-scenario-id>.json
```

**退出码:**
- `0` = 无 error (可能有 warning,可选择是否修)
- `1` = 至少 1 个 error,**必须修**
- `2` = 用法错误 / 文件读不到 / JSON 解析失败

### 2. 跑 typecheck

```bash
npm run typecheck
```

应输出 `tsc --noEmit` 然后无任何错误.

### 3. 常见 error 速查

| Error 消息 | 怎么修 |
|---|---|
| `worldEvents[i].id 不是合法 kebab-case` | id 用 `evt-rebellion-day7`,不要 camelCase / 大写 / 中文 |
| `worldEvents[i].id "..." 重复` | 一个剧本内 event id 唯一 |
| `worldEvents[i].when.day_to 必须 ≥ day_from` | when 区间方向反了 |
| `worldEvents[i].visibility 引用 location "..." 不在 scenario.locations 白名单` | visibility 里的 location id 必须先在 `locations[]` 定义 |
| `npc[<id>].schedule[i].locationId "..." 不在 scenario.locations 白名单` | locationId 必须在 locations 白名单 |
| `npc[<id>].schedule[i].hours[0] 不能等于 hours[1]` | 0 时长 entry 无意义,改成 `[8, 12]` |

### 4. 常见 warning (可不修但建议看)

| Warning 消息 | 建议处理 |
|---|---|
| `eraTemplate 未声明` | 大型剧本必填,加 §4 例子模板 |
| `worldEvents 未声明` | 这是 P4 核心,必须填,看 §5 |
| `worldEvents[i].short_summary 超 80 字符` | 精简到 15-30 字 |
| `worldEvents[i].description 较短 (< 30 字)` | 扩到 50-150 字,增加 LLM 上下文 |
| `worldEvents[i].visibility 引用 faction "..." 未定义` | 加 faction 定义或换 public |

---

## 10 · 交付 Checklist

完成时确认这些都 ✅:

- [ ] 文件路径: `public/dlc/<id>.json`,`id` kebab-case
- [ ] `npx tsx scripts/validate-scenario-p4.mts <file>` 退出码 0
- [ ] `npm run typecheck` 无错
- [ ] **必填字段**全在: id / name / shortName / description / openingNarration / defaultNpcId / npcs / entryCost / forceReward
- [ ] **P4 字段**全在: eraTemplate / worldEvents
- [ ] **大型剧本字段**: loreDigest / loreChunks / locations / initialLocation / factions
- [ ] **schedule 覆盖率**: 所有 core / side NPC 都有 5+ 条 schedule entry
- [ ] **worldEvents 规模**: 40+ 个,分布在 60-120 in-game day 跨度
- [ ] **visibility 分布**: 不全是 public,40/30/30 推荐

**交付内容:**

1. **scenario JSON 文件** (路径 `public/dlc/<id>.json`)
2. **changelog 段** 说明:
   - 剧本主题 + 题材 + 主角设定 (中文 1-2 段)
   - NPC 简介 (15-25 个,每个 1-2 句)
   - 主线脉络 (5-10 个关键转折点)
   - 你做的特殊 design choices (如有)

---

## 11 · FAQ / 常见坑

**Q: id 跟 character_id 是什么关系?**
A: `Scenario.id` 是剧本 id; `CharacterSpec.character_id` 是 NPC id. 两者独立,但**建议** NPC id 用 scenario id 作前缀 (如 `frank-npc-elias`),避免跨剧本撞 id.

**Q: 一个 NPC 同时出现在多个 location?**
A: `CharacterSpec.locations: string[]` 列出 NPC 可能出现的所有 location; `schedule` 按时段决定当前在哪. UI selector 用 `plaza.currentLocation` 过滤.

**Q: visibility 是 `faction:X`,但剧本没 factions?**
A: factions 是可选的. 若没定义,validator 只给 warning 不报 error,运行时按 faction id 字面匹配 NPC.meta.faction. 但**强烈建议**大型剧本至少定义 3-5 个 factions.

**Q: 我能 mix 时间触发 + 玩家行动触发吗?**
A: 能. `worldEvents` 走时间,`beats` 走玩家行动,两个机制并存. 同一 milestone 可被两边引用 (例如 worldEvent 触发后 `affects.worldFlags`,beat 通过 trigger 读这个 flag).

**Q: schedule 跟 beat 冲突时怎么办?**
A: Schedule 是 NPC 默认行为 (吃饭 / 睡觉 / 工作); Beat 是剧情节点 (玩家做了 X,NPC 应当反应). Beat 优先 — 触发时 NPC 临时离开 schedule,beat 结束后回归.

**Q: 我能不写 schedule 吗?**
A: 能. `CharacterSpec.schedule` 是 optional. Passing NPC 通常不写. 但 core/side NPC **强烈建议**写,不写 = 玩家任何时候都能找到他们 = 时间感大幅下降.

**Q: worldEvents 里能引用 NPC 吗?**
A: 可以在 `description` 字段里用 NPC 名字 (那是给 LLM 看的文本). 但**不要**在 `requires_milestones` 里写 NPC id — 那个字段只接受 milestone / beat id.

**Q: `requires_milestones` 引用的 milestone 在哪定义?**
A: Milestones 来自两个来源:
   1. `beats[].id` (如果 beat 是 checkpoint 类型)
   2. LLM 通过 `<!-- WC-EVENT milestone-reached id="ms-xxx" -->` 标记动态产生
   你可以引用任何已存在的 id. 如果你想确保某 milestone 一定会出现,在 `beats[]` 里定义一个对应 checkpoint beat.

**Q: 一个 worldEvent 触发后我想让它影响 NPC trust?**
A: `affects.worldFlags` 写一个 flag (如 `betrayal-revealed: 'true'`),然后在相关 NPC 的 system prompt 里通过 `promptSegments` 注入这个 flag,LLM 看到后会自然在 WC-TRUST 标记里调整 trust. 当前 P4 不直接改 trust,只通过 flag + prompt 间接驱动.

**Q: 我想做的时间感比"按 day 推"更细 (比如按 hour),怎么办?**
A: schedule 已经支持 hour 粒度. worldEvents 也支持 `when.hour_from / hour_to`. 但 framework 的 "tick 一次 = in-game 1 hour",所以你设计时按整点思考即可,不需要分钟级.

**Q: 玩家可以拒绝 worldEvent 影响他吗?**
A: 不能. worldEvent 是 *世界*事件,会发生.玩家能做的是反应 (跟相关 NPC 对话, 改变后续走向) 而不是阻止. 若你想让玩家"阻止"某事件,设计成 *条件* 触发: 在 `requires_milestones` 里加 `ms-prevented-X-failed`,玩家如果完成了"成功阻止"的 milestone 就不会触发到这个 event.

---

## 附 A · TypeScript Types 权威 reference

如果文档跟代码冲突,**以 TypeScript 为准**:

| 类型 | 文件 |
|---|---|
| `Scenario` | [`lib/scenarios/index.ts:413`](https://github.com/Emir-Aksoy/Manyworlds/blob/main/lib/scenarios/index.ts) |
| `EraTemplate` | `lib/scenarios/index.ts` (`rollWishes` 之后) |
| `WorldEvent` | 同上 |
| `ScenarioLocation` | `lib/scenarios/index.ts:87` |
| `Beat` / `BeatTrigger` | `lib/scenarios/index.ts:34` / `:60` |
| `CharacterSpec` | [`lib/character-spec.ts:13`](https://github.com/Emir-Aksoy/Manyworlds/blob/main/lib/character-spec.ts) |
| `ScheduleEntry` | `lib/character-spec.ts` (`Memory` 之前) |
| `CorePersona` / `TrustArchetype` | `lib/character-spec.ts:67` / `:69` |
| `LoreChunk` | `lib/scenarios/index.ts:291` |

---

## 附 B · 参考其它公开剧本风格

repo 里 6 个公开剧本各有题材,可作风格参考:

| Scenario | 题材 | 规模 | 特色 |
|---|---|---|---|
| `starmail.json` | 星际邮政 SF | 8 NPC | 教程级,LoreDigest + LoreChunks 完整 |
| `niannian.json` | 现代都市都市言情 | 7 NPC | 多角色情感关系 |
| `zanhua.json` | 古代后宫宫斗 | 8 NPC | 多派系 + trust_archetype 用例丰富 |
| `shanghai-noir.json` | 1936 上海滩谍战 | 7 NPC | 时代背景紧凑 |
| `hui-guang.json` | 现代法医破案 | 7 NPC | 任务链结构 |
| `yuanmo.json` | 元末群雄 | 23 NPC | 最大规模,多 locations + factions |

**没有任何一个公开剧本目前写了 P4 字段** — 你做的可能是第一个. 这意味着:
1. 你的工作有 "first mover" 的发挥空间
2. 你的字段格式选择会成为后续剧本的非正式 reference,要写得规范
3. 跑 validator + typecheck 一定都通过,不要给后人留坑

---

## 附 C · 反馈渠道

写作过程中:
- 字段语义不明 → 直接读 `lib/scenarios/index.ts` 和 `lib/character-spec.ts` 的 JSDoc 注释 (写得相当详细)
- Validator 输出看不懂 → 把 error message 完整发回给项目方

完成交付后,项目方会:
1. 跑 `validate-scenario-p4.mts` + `npm run typecheck` 复核
2. 把 scenario 加进 `public/dlc/manifest.json`
3. 在浏览器实测进入剧本走 5 个 NPC 对话 + 推进时间观察 worldEvents 触发
4. 合并到 main + 部署到 [manyworlds-three.vercel.app](https://manyworlds-three.vercel.app/)

祝写得开心.

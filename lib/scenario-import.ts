/**
 * 剧本导入工具(客户端)
 * =======================
 *
 * 两条路径:
 *   1. parseScenarioJson(text) —— 用户粘贴 / 上传 JSON,直接解析 + 校验
 *   2. generateScenarioFromText(sourceText, hint) —— 用户贴一段小说/影视剧概述,
 *      让 LLM 分析并产出符合 Scenario schema 的 JSON,然后解析 + 校验
 *
 * 两条都走 lib/scenarios/custom.ts 里的 validateScenario,统一规范化。
 */

import { callLLM } from './gateway';
import { validateScenario, type ValidateResult } from './scenarios/custom';
import { listScenarios } from './scenarios/index';
import type { Scenario } from './scenarios/index';

// ─── 路径 1:JSON 文本解析 ──────────────────────────────────────────

/** 用户粘贴 JSON 文本/上传 .json 文件,做基础解析 + 校验。失败时 errors 是人类可读列表。 */
export function parseScenarioJson(text: string): ValidateResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      errors: [`JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  return validateScenario(raw);
}

// ─── 路径 2:LLM 生成 ─────────────────────────────────────────────

const SYSTEM_PROMPT = `你是 "Manyworlds" 跨剧本叙事平台的剧本作者助手。

任务:把用户提供的小说/影视剧/游戏/历史/民间故事素材,提取并改写成本平台能用的 "剧本" JSON,
让玩家能扮演一个角色进入这个世界,与剧本中的核心 NPC 互动展开剧情。

# 输出格式(强制)

必须只输出一个 JSON 代码块,格式如下:

\`\`\`json
{
  "id": "kebab-case-id",
  "name": "中文剧本名",
  "shortName": "Short EN Name",
  "description": "1-2 句话剧本介绍",
  "openingNarration": "玩家首次进入时显示的开场旁白(2-4 句,带具体场景细节)",
  "defaultNpcId": "必须 = npcs 列表里某一个 character_id",
  "npcs": [
    {
      "character_id": "<scenarioId>-npc-<name-slug>",
      "identity": {
        "name": "中文名",
        "aliases": ["可选别名"],
        "pronouns": "she/her | he/him | they/them",
        "age": 32,
        "species": "human | elf | ai | alien | ...",
        "origin_world": "<scenarioId>",
        "creator_user_id": "system",
        "created_at": "2026-05-17T00:00:00Z"
      },
      "core_persona": {
        "summary": "一段(60-120 字)浓缩,涵盖身份/性格底色/与玩家关系",
        "traits": ["3-7 个性格 trait"],
        "values": ["1-3 个核心价值"],
        "fears": ["1-3 个恐惧"],
        "speech_style": "说话风格(句长/口头禅/语气)",
        "no_go": ["1-3 条该 NPC 在任何剧情下都不会做的事"]
      },
      "appearance": {
        "description": "外貌的中文描述",
        "base_prompt": "用于 SDXL 立绘的英文 prompt(必须英文)",
        "negative_prompt": "deformed, extra limbs, low quality"
      }
    }
  ],
  "entryCost": 30,
  "magicTags": ["tech" | "magic" | "psionic" | "qi" | "divine" | "cosmic"],
  "forceReward": { "min": 30, "max": 150 },
  "startSceneId": "<必须 = scenes 第一个 scene id,通常是开场场景>",
  "scenes": [
    {
      "id": "<scenarioId>-scene-<n>",
      "name": "中文场景名",
      "description": "给 Director / NPC 看的场景描述(2-4 句,有具体地点+氛围)",
      "enterNarration": "可选 — 进入此场景时的过场旁白",
      "imagePrompt": "可选 — SDXL 场景图英文 prompt",
      "beats": [
        {
          "id": "<sceneId>-ck-1",
          "type": "checkpoint",
          "summary": "Director 看的一句话说明",
          "triggerHint": "什么对话/动作能触发它 — 给 Director 判断用",
          "unlockHint": "触发后给玩家的视觉提示(可选,emoji + 短句)"
        }
      ],
      "nextSceneId": "<下一个 scene id,最后一个 scene 留空>"
    }
  ]
}
\`\`\`

# magicTags 含义(用于跨剧本物品削弱机制)
- tech: 赛博朋克 / 枪械 / 飞船 / 量子通讯
- magic: 西方咒语 / 法术 / 法杖 / 卷轴
- psionic: 心灵感应 / 念力 / 预知 / 闪回
- qi: 东方内力 / 元气 / 真气 / 经脉
- divine: 信仰 / 祝祷 / 神迹 / 圣物
- cosmic: 星辰 / 星象 / 黑洞 / 时空

按剧本的"魔法系统底色"选 0-3 个标签。完全现实题材可留空 []。

# entryCost 参考
- 教程剧本:0
- 一般体验:30-80
- 史诗/高难:100-200

# 剧情骨架(scenes / beats)— 重点!

剧本必须带剧情骨架。Director Agent 通过 beats 推动剧情。

- **scene**:剧本里的一个章节或场景。3-5 个 scene 一份剧本最佳(少了空洞,多了拖)。
- **beat**:scene 内的关键节拍。每个 scene 3-5 个 beat。
  - type="checkpoint" = 推进剧情必须的节点,3-4 个/scene
  - type="optional" = 支线/彩蛋,1-2 个/scene
- 全剧本至少 8 个 checkpoint(否则完成度颗粒度太粗)
- triggerHint 要写"什么对话/动作能触发这个 beat",让 Director Agent 能判断:**"如果玩家说了 X、做了 Y、或 NPC 提到了 Z,这个 beat 就该触发"**
- unlockHint 是触发后弹给玩家看的(emoji + 短句,比如 "🔑 你接住了钥匙"),保持戏剧感

# 必须遵守
1. 输出严格 JSON,可被 JSON.parse 直接解析。
2. 仅输出一个 \`\`\`json\`\`\` 代码块,块前块后不要任何解释文字。
3. npcs 数量:3-7 个为佳。少于 3 个剧情太单薄,多于 8 个玩家记不住。
4. character_id 必须 kebab-case,且以 "<scenarioId>-npc-" 开头。
5. defaultNpcId 必须是 npcs 列表里第一个出场/导师型角色的 character_id。
6. scene.id 必须 kebab-case,beat.id 也 kebab-case。
7. startSceneId 必须等于 scenes[0].id(或你想让玩家先进的那个 scene 的 id)。
8. 立绘 base_prompt 必须英文,具体描述年龄/种族/服装/表情/光照/画风。
9. 不要剽窃原文整段;要"改编+人物化",抓核心冲突 + 关键人物,改写成可交互的剧本骨架。
10. 涉及未成年/暴力/性内容时,做温和化处理,但不要丢失原作内核。
`;

const FEW_SHOT_USER = `源材料(示例):《三体》第一部前半段(红岸基地段落)。要让玩家以"新调入技术员"视角进入。`;
const FEW_SHOT_ASSISTANT = `\`\`\`json
{
  "id": "three-body-ert",
  "name": "三体·红岸",
  "shortName": "Three-Body ERT",
  "description": "1971 年,红岸基地。玩家是新调入的青年技术员,在被监听的山顶上,慢慢卷入一场跨越光年的回信。",
  "openingNarration": "雷达天线在风里发出低频的呜咽。叶文洁递给你一摞穿孔纸带,目光从你脸上一晃而过。'今晚 23:00 之前把这些回放完。' 她说,转身走进控制室。山脚下,革命口号还在风里飘。",
  "defaultNpcId": "three-body-ert-npc-ye-wenjie",
  "npcs": [
    {
      "character_id": "three-body-ert-npc-ye-wenjie",
      "identity": {
        "name": "叶文洁",
        "pronouns": "she/her",
        "age": 32,
        "species": "human",
        "origin_world": "three-body-ert",
        "creator_user_id": "system",
        "created_at": "2026-05-17T00:00:00Z"
      },
      "core_persona": {
        "summary": "天体物理学家,因父亲遇害对人类彻底失望。冷静、压抑,藏着一个还没下定决心的秘密。",
        "traits": ["冷静", "孤僻", "聪明", "悲观底色", "护新人"],
        "values": ["科学的诚实", "不再相信群体"],
        "fears": ["再被信任的人背叛"],
        "speech_style": "陈述句为主,少形容词。说话前会停顿半秒。",
        "no_go": ["不会嘲讽你的疑问", "不会主动谈父亲", "不会撒谎说'人类很好'"]
      },
      "appearance": {
        "description": "32 岁,清瘦,穿洗白的军绿外套,长发束在脑后,眼镜后是疲惫但锐利的眼睛。",
        "base_prompt": "32-year-old chinese woman in 1971, washed-out military green jacket, long black hair tied back, round wire-rim glasses, sharp tired eyes, mountain radar base background, semi-realistic illustration",
        "negative_prompt": "modern clothing, smiling, glamorous, deformed"
      }
    }
  ],
  "entryCost": 60,
  "magicTags": ["tech", "cosmic"],
  "forceReward": { "min": 50, "max": 180 },
  "startSceneId": "three-body-ert-scene-arrival",
  "scenes": [
    {
      "id": "three-body-ert-scene-arrival",
      "name": "抵达红岸",
      "description": "1971 年 11 月,大兴安岭红岸基地。玩家被一辆解放卡车送上山,叶文洁在基地门口接他,递给他一摞穿孔纸带要他熟悉系统。",
      "enterNarration": "卡车颠簸了一整天。叶文洁站在山顶基地门口,军绿外套被风吹得贴着身体。'放下行李,先认设备。' 她说。",
      "beats": [
        { "id": "tbert-s1-ck-1", "type": "checkpoint", "summary": "玩家进入基地并开始熟悉环境", "triggerHint": "玩家说'好/我去/我跟你看' 或问设备/基地相关问题", "unlockHint": "📡 你站到红岸的控制台前。" },
        { "id": "tbert-s1-ck-2", "type": "checkpoint", "summary": "玩家收到叶文洁的纸带任务", "triggerHint": "玩家接过纸带 / 表示开始工作 / 问纸带是什么", "unlockHint": "📃 任务到手:回放这些纸带。" },
        { "id": "tbert-s1-op-3", "type": "optional", "summary": "玩家试探性问叶文洁的过去", "triggerHint": "玩家好奇问'你之前在哪儿/你父亲',叶文洁回避" }
      ],
      "nextSceneId": "three-body-ert-scene-anomaly"
    },
    {
      "id": "three-body-ert-scene-anomaly",
      "name": "异常脉冲",
      "description": "深夜值班。监听记录里出现一段重复的、不像噪声的脉冲。玩家可以选择上报、自行分析、或瞒下来。",
      "enterNarration": "凌晨两点,纸带打印机停了下来。最后一段脉冲跟前面所有的都不一样 — 太规律了。",
      "beats": [
        { "id": "tbert-s2-ck-1", "type": "checkpoint", "summary": "玩家注意到异常脉冲", "triggerHint": "玩家提到'脉冲很奇怪/有规律/不像噪声' 或主动检查打印记录", "unlockHint": "🎯 异常脉冲被你抓住了。" },
        { "id": "tbert-s2-ck-2", "type": "checkpoint", "summary": "玩家做出处置选择(上报/自分析/瞒下)", "triggerHint": "玩家明确说'去找叶老师/我自己看看/先别告诉别人'", "unlockHint": "⚖ 你做出了选择。" },
        { "id": "tbert-s2-op-3", "type": "optional", "summary": "叶文洁默默来到机房", "triggerHint": "玩家陷入沉默或讨论时,Director 让叶文洁出现,意味深长地看一眼,什么都不说" }
      ]
    }
  ]
}
\`\`\``;

export interface GenerateOptions {
  /** 用户额外提示(口味偏好/限定时代/选哪几个角色) */
  hint?: string;
  /** 抽样温度,默认 0.7 */
  temperature?: number;
}

export interface GenerateResult {
  ok: boolean;
  scenario?: Scenario;
  errors?: string[];
  /** 原始 LLM 文本(失败时也保留,方便用户复制) */
  rawText?: string;
  /** 解析出的 JSON(在验证失败时也可能存在) */
  rawJson?: unknown;
  /** 来源信息 */
  meta?: {
    laneUsed?: string;
    fallbackPath?: string[];
    durationSec?: number;
  };
}

/**
 * 把一段小说/影视剧/故事素材送给 LLM,让它产出符合 Scenario schema 的 JSON。
 *
 * 内部:
 *   - 走 task='utility.structured' → codex_spark_bridge(按当前路由表)
 *   - 输出截取第一个 ```json``` 代码块,或裸 JSON
 *   - 用 validateScenario 规范化
 *   - 自动避免 id 冲突(已存在的 id 加 -2 后缀)
 */
export async function generateScenarioFromText(
  sourceText: string,
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  // L1 修复:这个函数依赖 fetch 和 localStorage(冲突检测),必须 client-side 调
  if (typeof window === 'undefined') {
    return { ok: false, errors: ['generateScenarioFromText 仅可在浏览器端调用(依赖 fetch + localStorage)'] };
  }
  const trimmed = sourceText.trim();
  if (!trimmed) {
    return { ok: false, errors: ['请输入小说 / 影视剧 / 故事的源材料文本'] };
  }
  if (trimmed.length > 12000) {
    return {
      ok: false,
      errors: [`源材料过长 (${trimmed.length} 字),建议压缩到 1-3 千字的关键梗概。`],
    };
  }

  const userMsg = opts.hint
    ? `源材料:\n${trimmed}\n\n---\n附加偏好:${opts.hint}\n\n请按系统要求产出剧本 JSON。`
    : `源材料:\n${trimmed}\n\n请按系统要求产出剧本 JSON。`;

  let resp;
  try {
    resp = await callLLM({
      task: 'utility.structured',
      temperature: opts.temperature ?? 0.7,
      maxTokens: 4000,
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: FEW_SHOT_USER },
        { role: 'assistant', content: FEW_SHOT_ASSISTANT },
        { role: 'user', content: userMsg },
      ],
    });
  } catch (e) {
    return {
      ok: false,
      errors: [`LLM 调用失败: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  const meta = {
    laneUsed: resp.laneUsed,
    fallbackPath: resp.fallbackPath,
    durationSec: resp.durationSec,
  };

  const jsonText = extractJsonBlock(resp.text);
  if (!jsonText) {
    return {
      ok: false,
      errors: ['LLM 响应中没找到 JSON 代码块。原始响应已保留,可复制后手动修正再粘贴导入。'],
      rawText: resp.text,
      meta,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return {
      ok: false,
      errors: [`LLM 输出的 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`],
      rawText: resp.text,
      meta,
    };
  }

  // id 冲突自动改名
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (typeof o.id === 'string') {
      const allIds = new Set(listScenarios().map((s) => s.id));
      if (allIds.has(o.id)) {
        let n = 2;
        const baseId = o.id;
        while (allIds.has(`${baseId}-${n}`)) n++;
        o.id = `${baseId}-${n}`;
      }
    }
  }

  const v = validateScenario(parsed);
  if (!v.ok) {
    return {
      ok: false,
      errors: v.errors,
      rawText: resp.text,
      rawJson: parsed,
      meta,
    };
  }

  return {
    ok: true,
    scenario: v.scenario,
    rawText: resp.text,
    rawJson: parsed,
    meta,
  };
}

// ─── helpers ─────────────────────────────────────────────────────

/**
 * 从 LLM 响应里挖出 JSON。
 *
 * M1 修复:三层策略,鲁棒处理 LLM 的各种输出形态。
 *   1. 寻找 ```json``` 围栏块,逐个尝试 balanced-brace scan(防嵌套反引号截断)
 *   2. 寻找任意 ``` ``` 围栏块(LLM 偶尔漏 "json" 关键字)
 *   3. 全文 balanced-brace scan(纯裸 JSON)
 *
 * balanced-brace scanner 比 regex 稳:
 *   - 从第一个 { 起对 { } 计数,跳过字符串字面量(处理转义引号)
 *   - 找到深度归零的位置才截断,自然处理 JSON 里包含 ``` 反引号的情况
 *   - 截断响应(maxTokens 不够)时,大括号不平衡,返回 null 而不是错误 JSON
 */
function extractJsonBlock(text: string): string | null {
  // 策略 1:```json``` 块
  const jsonFenceRe = /```\s*json\s*\n?/gi;
  let m: RegExpExecArray | null;
  while ((m = jsonFenceRe.exec(text)) !== null) {
    const fromIdx = m.index + m[0].length;
    const candidate = scanBalancedJson(text, fromIdx);
    if (candidate) return candidate;
  }

  // 策略 2:任意 ``` 围栏块
  const anyFenceRe = /```[^\n`]*\n/g;
  while ((m = anyFenceRe.exec(text)) !== null) {
    const fromIdx = m.index + m[0].length;
    const candidate = scanBalancedJson(text, fromIdx);
    if (candidate) return candidate;
  }

  // 策略 3:全文裸 JSON
  return scanBalancedJson(text, 0);
}

/**
 * 从 text[fromIdx..] 开始找第一个平衡的 JSON 对象,返回其字符串切片。
 * 失败返 null(没找到 `{` 或大括号没平衡 — 通常意味着响应被截断)。
 */
function scanBalancedJson(text: string, fromIdx: number): string | null {
  const start = text.indexOf('{', fromIdx);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  // 大括号没平衡:响应被截断
  return null;
}

/**
 * 剧本注册表(DLC 化)
 * ====================
 *
 * 改造后:剧本数据**不**写在代码里 — 都放在 `public/dlc/<id>.json`,
 * 运行时由 `lib/scenarios/dlc.ts` 在 app/page.tsx 顶层 useEffect 里 fetch + register。
 *
 * 入口流程:
 *   1. Home 组件挂载 → useEffect 调 `loadAllDlc()` (lib/scenarios/dlc.ts)
 *   2. loadAllDlc 内部 → fetch manifest.json + 所有 scenario.json → `_registerDlcScenario` × N
 *   3. 全部完成 → `_markDlcReady()` 把 dlcReady flag 翻 true
 *   4. Home 检测 `isDlcReady()` === true → 解除 loading 屏障,渲染主 UI
 *
 * 设计原则:
 *   - `getScenario` / `listScenarios` 保持**同步**语义(老 caller 全部不用改签名)
 *   - 但 DLC 加载完之前,二者只返回空/undefined → caller 应该已经处理过这种 undefined
 *   - Home 用 loading screen 屏蔽这一段,所以业务代码看不到"半加载"状态
 */

import type { CharacterSpec } from '../character-spec';
import type { MagicSystem } from '../plaza';
import { listCustomScenarios, getCustomScenario } from './custom';

// ─── Scene / Beat — 剧情骨架 ─────────────────────────────────────────

/**
 * 一个 Beat 是 Scene 内的关键节拍。
 *  - 'checkpoint':推进剧情必须的节点,完成度按这些计算
 *  - 'optional':支线/彩蛋,触发了加分但不卡进度
 *
 * Director Agent 在 advance() 时读未完成的 beats,选 1-2 个去推动。
 * 触发判断走 LLM(看玩家对话/Director 旁白是否满足 triggerHint)。
 */
export interface Beat {
  /** beat 唯一 ID(scene 内唯一即可,但建议全剧本唯一) */
  id: string;
  type: 'checkpoint' | 'optional';
  /** 一句话说明这个 beat 是什么(给 Director 看) */
  summary: string;
  /** 触发条件提示(给 Director 判断:"如果玩家做了 X / NPC 说了 Y,这个 beat 就该触发") */
  triggerHint: string;
  /** 完成后给玩家的视觉提示(可选,UI 弹窗用) */
  unlockHint?: string;
  /** 完成后自动激活的下一个 beats id 列表(DAG 用,留空 = 不限制) */
  unlocksNext?: string[];
  /**
   * 硬性前置触发条件(可选,跟 triggerHint 互补)。
   *   - triggerHint 给 LLM 看"什么剧情发展该触发"(软,LLM 自由心证)
   *   - trigger    给框架看"是否到达可触发的前置条件"(硬,Director 提示 beat 前先过滤)
   * 缺省 → 无前置约束,纯靠 triggerHint。
   */
  trigger?: BeatTrigger;
}

/**
 * Beat 的硬性触发条件(框架级过滤,跟 triggerHint 的"软提示"互补)。
 * 所有字段 AND 关系,全部满足才认为"前置已就绪"。
 * 缺省字段 = 该条件不参与判定(不是"必须不满足")。
 */
export interface BeatTrigger {
  /** 玩家当前必须在此 location(动态剧本用,id 必须在 scenario.locations 内) */
  location?: string;
  /** 玩家到访 trigger.location(或当前点)次数必须 ≥ 此值 */
  visitCount?: number;
  /** 必须是此时段(若剧本启用时间;暂未实现时间系统时此字段无效) */
  timeOfDay?: 'day' | 'night' | 'dawn' | 'dusk';
  /** 这些 beat 必须已完成(前置 DAG 比 unlocksNext 更严格,可显式声明依赖) */
  completedBeats?: string[];
  /** 这些 artifact 必须已发现(用于"找到线索后才解锁推理 beat"等剧本) */
  discoveredArtifacts?: string[];
}

// ─── Location — 动态剧本"地点"(可选,跟 scenes 互斥使用)─────────────
/**
 * 动态剧本里的一个地点(开放世界用)。
 *
 * 跟 Scene 的关系:
 *   - Scene:线性剧情容器(场景 → beat 序列),Director 跟着推进
 *   - Location:开放世界的"地理坐标",玩家可在 location 之间漫游;没有 beat 序列
 *
 * 用法:
 *   - scenarios.locations[] 非空 + scenes 空/缺失 = 动态剧本模式
 *   - Director 在叙事中输出 `<!-- WC-EVENT location-changed value=<location-id> -->` 推地点
 *   - NPC selector 按 NPC.locations 跟 plaza.currentLocation 交集过滤(交集为空的 NPC 隐藏)
 *   - description 注入 Director/NPC prompt 当"当前情境"
 */
export interface ScenarioLocation {
  /** kebab-case 唯一 id(剧本内唯一即可) */
  id: string;
  /** 显示名,中文(扬州/长安/洛阳/突厥王庭) */
  name: string;
  /** 给 LLM 看的地点描述(2-4 句,环境氛围 + 当前势力 + 风险) */
  description: string;
  /**
   * 邻接 location id 列表(简单无向邻接表)。
   *   - 缺省 / 空 → 无地理约束,LLM 可自由切到任何 location
   *   - 非空 → location-changed parser warn 不在邻接表的目标(不拒绝,保留 LLM 即兴空间);
   *           prompt 注入"当前可前往:A / B / C"提示 LLM 决策时优先走邻接
   *   - 邻接是双向语义,但写的时候只在一侧声明也行(validator 不强制对称)
   */
  connections?: string[];
  /** 同时容纳的 NPC 数量提示(纯 LLM hint,无强制);常用于"密室 2 人对峙"暗示 */
  capacity?: number;
  /**
   * 此地点的初始环境状态(KV)。例:{door:"closed", lantern:"lit", floor:"clean"}
   * 运行时 LLM 通过 WC-EVENT scene-state-changed 更新,覆盖存 plaza.sceneStateOverrides;
   * prompt 注入时合并 initial + overrides,让 LLM 看到"客栈被烧后的描述变成废墟"。
   */
  sceneState?: Record<string, string>;
  /**
   * 此地点可调查的 artifact(线索/物品)。
   *   - 玩家未发现的 artifact 注入 prompt 提示"此地可调查:X / Y"
   *   - LLM 通过 WC-EVENT artifact-discovered value=<artifactId> 标记发现
   *   - 已发现的从 prompt 移除(避免重复提示)
   *   - requiresCompletedBeats 让 artifact 隐藏到剧情推进后才出现
   */
  artifacts?: LocationArtifact[];
}

/**
 * 地点内可调查/发现的 artifact(线索 / 物件 / 暗格)。
 * 跟 plaza.inventory 的区别:
 *   - inventory: 跨剧本通用,玩家"拥有"的物品(钱包 / 装备)
 *   - artifact:  剧本内、地点绑定,玩家"调查 / 发现"的线索或叙事物件
 * 发现后是否进 inventory 由 LLM 在叙事中决定(框架不强制转化)。
 */
export interface LocationArtifact {
  /** kebab-case 唯一 id(剧本内唯一即可,artifact-discovered value 用此 id) */
  id: string;
  /** 显示名(中文,"翡翠耳坠" / "账本残页") */
  name: string;
  /** 给 LLM 看的物品描述(1-3 句,藏在哪 + 大致样貌 + 可被探发现的暗示) */
  description: string;
  /**
   * 隐藏条件:这些 beat 必须已完成,artifact 才会被注入 prompt 提示"可调查"。
   * 缺省 → 进场即可见。用于"侦探剧本里到第三个 beat 后才解锁'保险柜密码线索'"。
   */
  requiresCompletedBeats?: string[];
  /** 可选标签(clue / weapon / mcguffin / personal-item / hidden-passage),给 prompt 分类参考 */
  tags?: string[];
}

// ─── 运行时动态扩展(种子 + LLM-spawned 模式)──────────────────────
/**
 * 剧本作者声明的"允许 LLM 运行时扩展新地点"能力。
 * 在 Scenario.dynamicLocations 字段使用,缺省 = 不允许(完全等同旧行为)。
 *
 * 双开关设计:
 *   - 剧本侧:scenario.dynamicLocations.allowed === true (作者授权)
 *   - 玩家侧:plaza.playerSettings.allowRuntimeExpansion === true (玩家激活)
 *   两者全为 true 时,prompt 才会注入 location-spawned marker 的引导,
 *   applyWcEventsToPlaza 才会处理该 marker。
 */
export interface DynamicLocationConfig {
  /** 是否允许扩展。false / 缺省 → 即使玩家开了全局开关也不允许 */
  allowed: boolean;
  /** 单次 session 最多 spawn 多少个动态 location(防 LLM 暴力扩展);缺省 8 */
  maxPerSession?: number;
  /**
   * 是否要求 spawn 时 parent 必须是玩家当前所在 location。
   *   - true / 缺省: parser 校验失败的 marker 被忽略并 warn(防 LLM 凭空生成远景地点)
   *   - false: 允许 LLM 把 parent 设为任意已存在 location(包括之前 spawn 的)
   */
  requireConnectedToCurrent?: boolean;
  /** 自定义引导话术(替换默认 spawn hint);缺省 → 用 buildWcEventInstructions 内置默认。 */
  hint?: string;
}

/**
 * 运行时由 LLM 通过 WC-EVENT location-spawned 生成、并物化到 plaza.spawnedLocations 的动态地点。
 *
 * 跟 ScenarioLocation 结构同构(buildContext 可共用一套读取逻辑),但多 metadata:
 *   - isDynamic / parent / generatedAt: 区分动态与预设;parent 用于 connections 默认值
 *   - visitCount: 自包含,不进 plaza.locationVisitCount(避免动态 id 污染预设 visitCount 表)
 *
 * 永远不写回 scenario.json,仅存 plaza.spawnedLocations[scenarioId][id]。
 * resetScenario 时整片清理。
 */
export interface DynamicLocation {
  /** kebab-case 唯一 id,LLM 约定写 `<scenarioId>.dyn-<kebab>` 格式 */
  id: string;
  /** 显示名(中文,"桥头后巷") */
  name: string;
  /** LLM 第一次描述时确定,后续保持一致(prompt 注入会冻结此描述) */
  description: string;
  /**
   * 邻接 location id 列表。物化时默认 = [parent](与触发玩家所在 location 单向相连)。
   * 后续 LLM 在该地点又 spawn 出更深的动态地点时,以链式串起来。
   */
  connections: string[];
  /** 同 ScenarioLocation.sceneState,初始 = {};后续走 scene-state-changed 写覆盖。 */
  sceneState: Record<string, string>;
  /** 同 ScenarioLocation.artifacts,初始 = [];作者沉淀时手工补。 */
  artifacts: LocationArtifact[];
  /** 标记是动态生成 — buildContext 注 prompt 时多注一句"此地由对话延展产生" */
  isDynamic: true;
  /** 触发 spawn 时玩家所在的 location(可以是预设或之前的动态) */
  parent: string;
  /** 物化时间戳(unix ms,Date.now()) */
  generatedAt: number;
  /** 累计访问次数(setCurrentLocation 切到该 id 时 +1)。 */
  visitCount: number;
}

/**
 * Scene = 剧本里的一个场景/章节,包含 N 个 beat。
 */
export interface Scene {
  id: string;
  name: string;
  /** 给 Director / NPC 看的场景描述,会注入 system prompt 当作"当前情境" */
  description: string;
  /** 可选:进入此 scene 时显示的过场旁白 */
  enterNarration?: string;
  /** 可选:SDXL 场景图 prompt(Phase 后续接) */
  imagePrompt?: string;
  beats: Beat[];
  /** 完成此 scene 后自动进入的下一个 scene id;留空 = 自动用下一个(数组顺序) */
  nextSceneId?: string;
  /**
   * 此 scene 当前"在场"的 NPC ids(C4 "身边"语义)。
   * 留空 / undefined = 使用剧本所有 NPC(向后兼容)。
   * 非空 = NPC selector 只列这些角色;玩家其他 NPC 视为"不在身边",不能直接搭话。
   */
  presentNpcIds?: string[];
}

// ─── 剧本级 LLM 控制(重剧本轻框架)─────────────────────────────────

/**
 * Prompt 段的 id。代表 buildSystemPromptForCharacter 拼出的 11 个语义大段。
 * 剧本可通过 promptSegments.disabled 关掉某段,或通过 insert 在某段前后插入自定义段。
 *
 * 段合并 map(由 lib/prompt-segments.ts 实现):
 *   identity     = 身份头(你是 X + 剧本名 + loreDigest)
 *   persona      = summary + traits + values + fears + speech + no-go
 *   appearance   = 外观
 *   context      = 场景情境 + 当前地点
 *   lore-chunks  = 剧本 lore 分块(按 NPC.lore_tags 跟 chunk.tags 交集注入,渐进披露)
 *   player       = 玩家身份(soul/body) + 命运祈愿
 *   state        = 关系 + 记忆 + summary
 *   scene-state  = 同伴 + 物品
 *   output-rules = 输出约束 + 前缀说明
 *   wc-event     = 事件标记规则(白名单 + 格式约束)
 *   wc-stat      = 隐藏数值规则
 */
export type SegmentId =
  | 'identity'
  | 'persona'
  | 'appearance'
  | 'context'
  | 'lore-chunks'
  | 'player'
  | 'state'
  | 'scene-state'
  | 'output-rules'
  | 'wc-event'
  | 'wc-stat';

export const ALL_SEGMENT_IDS: readonly SegmentId[] = [
  'identity',
  'persona',
  'appearance',
  'context',
  'lore-chunks',
  'player',
  'state',
  'scene-state',
  'output-rules',
  'wc-event',
  'wc-stat',
];

// ─── LoreChunk — 按 NPC 关心点分块注入的世界观 ───────────────────────

/**
 * Lore chunk = 世界观的一个语义块(一般是一个阵营 / 一段历史 / 一种文化系统),
 * 配上 tags 让 prompt 段化时按 NPC 关心点选择性注入(渐进式披露)。
 *
 * 设计:
 *   - 一个 chunk 是一段连贯的 markdown(几百字到 1-2KB,跟 manifest factions/*.md 等量)
 *   - tags 决定"谁应该在 prompt 里看到这块"——只有 NPC.lore_tags 跟 chunk.tags
 *     有交集才注入(交集为空 = 跳过)
 *   - 'general' 是特殊 tag:任何 NPC(包括 lore_tags 为空的)都会看见
 *
 * 跟 loreDigest 的关系:
 *   - loreDigest:所有 NPC 都看的"必知 ≤500 字"(年份 / 大势 / 核心矛盾)
 *   - loreChunks:按角色定制的"深一层细节"(只有相关 NPC 看)
 *   - 杨广只看 sui-court 块,婠婠只看 mojen 块;主角寇仲打多 tag 看跨多块
 */
export interface LoreChunk {
  /** chunk 唯一 id(剧本内唯一,kebab-case)。诊断 / snapshot 标记用 */
  id: string;
  /** 块的显示标题(给 LLM 看,如 "杨隋——风雨飘摇的帝国") */
  title: string;
  /** 块内容(markdown,会原样注入 prompt) */
  content: string;
  /**
   * 谁会看到这块。
   *   - 'general' = 任何 NPC 都看(即使 lore_tags 为空)
   *   - 其他 tag(如 'sui', 'mojen') = 仅 NPC.lore_tags 包含该 tag 时注入
   */
  tags: string[];
}

/**
 * 剧本自定义的 LLM 调用参数。所有字段可选,缺省走框架默认。
 * 用途:
 *   - 重量化剧本(大唐 32 NPC)拉高 historyLimit/memoryLimit/maxTokens
 *   - 轻量剧本(教程)反之省 token
 */
export interface ScenarioLlmConfig {
  /** Anthropic model id(如 "claude-sonnet-4-5");缺省 = gateway DEFAULT_ANTHROPIC_MODEL */
  model?: string;
  /** 输出 temperature(0-2);缺省 = gateway 默认 */
  temperature?: number;
  /** 输出最大 token 数;缺省 = 1024 */
  maxTokens?: number;
  /** 聊天历史保留条数上限;缺省 = 80(character-tiers 核心档) */
  historyLimit?: number;
  /** prompt 里注入的 episodic 记忆条数上限;缺省 = 5 */
  memoryLimit?: number;
  /** 触发历史压缩的占用比例(0-1);缺省 = 0.8(达 80% historyLimit 时触发) */
  summaryTriggerRatio?: number;
}

/**
 * 剧本自定义的 prompt 段配置(补丁式,不重排默认段)。
 *
 *   - disabled:关掉某些默认段(builder 不执行)
 *   - insert  :在指定段前/后插入自定义 markdown 段
 *
 * 不提供"全自定义顺序"——保持默认段稳定能让剧本作者只关心"加什么/关什么"。
 */
export interface ScenarioPromptSegments {
  /** 关闭这些默认段(builder 不会执行) */
  disabled?: SegmentId[];
  /** 在指定段前/后插入自定义段(必须指定 before 或 after 之一) */
  insert?: Array<{
    /** 在此默认段之前插入(跟 after 二选一) */
    before?: SegmentId;
    /** 在此默认段之后插入(跟 before 二选一) */
    after?: SegmentId;
    /** 自定义段 id(kebab-case,不能跟 SegmentId 重名;诊断 / snapshot 标记用) */
    id: string;
    /** 段内容(markdown,原样插入) */
    content: string;
  }>;
}

// ─── I-series:难度 + 灵魂化身身份 ─────────────────────────────────

/**
 * 剧本难度(影响 wishGrantRate / 后续可扩展更多惩罚 buff)。
 *   - easy:玩家很容易实现愿望(70%),适合教程 / 治愈系
 *   - normal:中等(40%),主线副本默认档
 *   - hard:命运无情(15%),硬核 / 悲剧副本
 */
export type ScenarioDifficulty = 'easy' | 'normal' | 'hard';

/**
 * 玩家"灵魂进入"时化身的预设角色身份。
 *   - 不是 NPC(没有 character_id),只是一组描述文本给 prompt 用
 *   - 性别留空 → 让 NPC prompt 继承 plaza.userProfile.gender(尊重玩家真实身份)
 *   - 年龄留空同理 → 继承 userProfile.age
 *   - background:核心叙事身份(给 NPC system prompt 直接当"玩家是谁"用)
 */
export interface PlayerSoulIdentity {
  /** 化身的姓名/称呼(例:"新晋邮差") */
  name: string;
  /** 化身的固定性别;留空 = 继承玩家真实性别 */
  gender?: 'male' | 'female' | 'other';
  /** 化身的固定年龄;留空 = 继承玩家真实年龄 */
  age?: number;
  /** 给 NPC 看的"玩家是这个剧本里的什么人"描述(2-4 句) */
  background: string;
}

/**
 * 根据难度算"愿望命运批准率"。每个愿望独立摇骰子(Math.random < rate ? 准 : 否)。
 * 取值跟 wishesGranted 半透明语义匹配:玩家看不到具体哪些被准,只知道有多少。
 */
export function wishGrantRate(difficulty: ScenarioDifficulty | undefined): number {
  switch (difficulty) {
    case 'easy':
      return 0.7;
    case 'hard':
      return 0.15;
    case 'normal':
    default:
      return 0.4;
  }
}

/**
 * 把 0..N 个愿望摇骰子,返回被批准的下标列表。
 * 注意:return 是 number[](下标),不是字符串 — 半透明 UI 只展示数量(.length)给玩家,
 * 完整下标列表给 NPC prompt(NPC 知道具体哪些被准)。
 */
export function rollWishes(
  wishes: string[],
  difficulty: ScenarioDifficulty | undefined,
): number[] {
  if (wishes.length === 0) return [];
  const rate = wishGrantRate(difficulty);
  const out: number[] = [];
  for (let i = 0; i < wishes.length; i += 1) {
    if (Math.random() < rate) out.push(i);
  }
  return out;
}

export interface Scenario {
  /** 剧本唯一 ID(对应 character.identity.origin_world) */
  id: string;
  /** 显示名(中文) */
  name: string;
  /** 短名(英文,UI 切换器用) */
  shortName: string;
  /** 一两句话介绍(用于 UI / 玩家预览,可任意长;**不**直接塞给 LLM) */
  description: string;
  /**
   * 给 LLM 的世界观浓缩(≤500 字,渐进式披露用)。
   *
   * 为什么不直接用 description?
   *   重剧本(如大唐)的 description 是给玩家的"世界观介绍",可能 19KB+;
   *   每个 NPC 每轮都塞进 prompt 是巨大浪费 — NPC 大概率只用得到其中 5%。
   *   loreDigest 强约束 ≤500 字,只保留"年份 / 时代 / 当前大势 / 核心矛盾"四要素;
   *   细节让 NPC 通过 persona / context / 自定义 promptSegments.insert 拿。
   *
   * 缺省 → buildIdentity 回退用 description(向后兼容轻剧本)。
   */
  loreDigest?: string;
  /** 玩家第一次进入剧本时显示的开场旁白 */
  openingNarration: string;
  /** 进入剧本时默认对话的 NPC */
  defaultNpcId: string;
  /** 该剧本下所有 NPC */
  npcs: CharacterSpec[];
  /** 从广场进入该剧本需要花费的原力(0 = 免费,如教程剧本) */
  entryCost: number;
  /**
   * 剧本允许的魔法系统标签。
   *   - 空数组 / undefined = 不限定(任何神奇物品都不被削弱)
   *   - 非空 = 物品 magicTags 跟此交集为空 → 物品在此剧本被削弱
   * 比如星际邮差是 ['tech', 'psionic'],法杖(['magic'])在此削弱。
   */
  magicTags?: MagicSystem[];
  /** 完成度区间对应的原力奖励范围 [min, max]。完成度越高奖越接近 max。 */
  forceReward: { min: number; max: number };
  /**
   * 剧情骨架(scene/beat/checkpoint)。
   *   - 留空 / undefined = "自由 advance"模式(Director 凭感觉推进)
   *   - 非空 = "结构化"模式,Director 跟着 beats 走,完成度按 checkpoint 比例算
   * 内置 STARMAIL 有骨架;AI 生成的剧本默认也带(若 LLM 输出符合 schema)。
   *
   * 跟 locations 互斥:scenes 非空 → scenes 模式;scenes 空 + locations 非空 → 动态模式(开放世界)。
   */
  scenes?: Scene[];
  /** 起始 scene id(scenes 非空时必填,但若缺则用 scenes[0]) */
  startSceneId?: string;
  // ─── 动态剧本(开放世界)新增 ────────────────────────────────────
  /**
   * 动态剧本地点列表。非空 + scenes 空 → 启用"动态模式":
   *   - 玩家有 currentLocation,Director 在叙事中可输出 location-changed 标记切换
   *   - NPC selector 按 NPC.locations 跟 currentLocation 交集过滤
   *   - 完成度按 milestonesReached.length / targetMilestones 算
   */
  locations?: ScenarioLocation[];
  /** 动态剧本玩家起始地点 id(必须在 locations 里);缺省 → locations[0].id */
  initialLocation?: string;
  /**
   * 动态剧本完成度目标 milestone 数。
   *   - 缺省 + scenes 空 → computeCompletion 返 0.5(老兜底)
   *   - 设了 → completion = min(1, completedBeatIds.length / targetMilestones)
   * 复用 completedBeatIds 是因为 milestone 跟 checkpoint beat 本质同构(都是"已达成的 id 集合")。
   */
  targetMilestones?: number;
  // ─── I-series 新增 ──────────────────────────────────────────────
  /** 难度档。缺省 = 'normal'(由 wishGrantRate 兜底)。 */
  difficulty?: ScenarioDifficulty;
  /**
   * "灵魂进入"模式下玩家化身的预设角色;缺省时 UI 只允许"身体进入"模式。
   * AI 生成的剧本若缺此字段,EntryModal 会自动屏蔽魂选项。
   */
  playerSoulIdentity?: PlayerSoulIdentity;
  // ─── 重剧本轻框架(可选,缺省走框架默认)──────────────────────────
  /** 剧本自定义的 LLM 调用参数(model/temperature/maxTokens/historyLimit/memoryLimit/summaryTriggerRatio) */
  llmConfig?: ScenarioLlmConfig;
  /** 剧本自定义的 prompt 段补丁(关段 + 插入自定义段) */
  promptSegments?: ScenarioPromptSegments;
  /**
   * 剧本的 lore chunks(按 NPC.lore_tags 选择性注入的世界观分块,渐进式披露)。
   *   - 缺省 / 空 → lore-chunks 段不输出任何内容(行为等同没有此机制)
   *   - 非空 → 每个 NPC 看到 chunk.tags ∩ npc.lore_tags ≠ ∅ 的块(或 chunk 含 'general' tag)
   */
  loreChunks?: LoreChunk[];
  /**
   * 运行时动态扩展能力声明(种子 + 即兴模式)。
   *   - 缺省 / allowed: false → 完全不允许 LLM 即兴造新地点(等同旧行为)
   *   - allowed: true → 若 plaza.playerSettings.allowRuntimeExpansion 也 true →
   *     prompt 注入 location-spawned marker 引导,LLM 可输出 spawn 标记,引擎物化进
   *     plaza.spawnedLocations[scenarioId]。
   * 双开关设计:剧本作者声明能力,玩家在设置里激活;两者全 true 才生效。
   */
  dynamicLocations?: DynamicLocationConfig;
}

// ─── 完成度 helpers ────────────────────────────────────────────────

export function listAllCheckpoints(scenario: Scenario): Beat[] {
  if (!scenario.scenes) return [];
  return scenario.scenes.flatMap((s) => s.beats.filter((b) => b.type === 'checkpoint'));
}

/**
 * 给定已达成的事件 ids(checkpoint beat 或 milestone),算 0-1 之间的完成度。
 *
 * 三档:
 *   - scenes 模式(checkpoints 非空):按 done/total 算
 *   - 动态模式(scenes 空 + targetMilestones 存在):按 length/target 算
 *   - 完全自由(scenes 空 + targetMilestones 缺):返 0.5(老兜底)
 */
export function computeCompletion(scenario: Scenario, completedBeatIds: string[]): number {
  const checkpoints = listAllCheckpoints(scenario);
  if (checkpoints.length > 0) {
    const doneSet = new Set(completedBeatIds);
    const done = checkpoints.filter((b) => doneSet.has(b.id)).length;
    return Math.min(1, done / checkpoints.length);
  }
  // 动态模式:milestone 走同一字段,只按 length 算
  const target = scenario.targetMilestones;
  if (typeof target === 'number' && target > 0) {
    return Math.min(1, completedBeatIds.length / target);
  }
  return 0.5;
}

/**
 * 取动态剧本"起始地点 id"。
 *   - initialLocation 指定且存在于 locations → 用它
 *   - 否则用 locations[0]
 *   - locations 空 → null
 */
export function getInitialLocation(scenario: Scenario): string | null {
  if (!scenario.locations || scenario.locations.length === 0) return null;
  const declared = scenario.initialLocation;
  if (declared && scenario.locations.some((l) => l.id === declared)) return declared;
  return scenario.locations[0].id;
}

/** 按 id 查 location;找不到返 undefined。 */
export function getLocation(scenario: Scenario, locationId: string): ScenarioLocation | undefined {
  return scenario.locations?.find((l) => l.id === locationId);
}

/** 根据完成度算原力奖励(线性插值)。 */
export function computeForceReward(scenario: Scenario, completion: number): number {
  const c = Math.max(0, Math.min(1, completion));
  const { min, max } = scenario.forceReward;
  return Math.round(min + (max - min) * c);
}

/** 工具:按 id 找 scene。 */
export function getScene(scenario: Scenario, sceneId: string): Scene | undefined {
  return scenario.scenes?.find((s) => s.id === sceneId);
}

/** 工具:按 id 找 beat(跨 scene)。 */
export function getBeat(scenario: Scenario, beatId: string): { scene: Scene; beat: Beat } | undefined {
  if (!scenario.scenes) return undefined;
  for (const scene of scenario.scenes) {
    const beat = scene.beats.find((b) => b.id === beatId);
    if (beat) return { scene, beat };
  }
  return undefined;
}

/**
 * 评估 Beat 的硬性前置触发条件(BeatTrigger)是否全部满足。
 *
 *   - 无 beat.trigger → true(无约束,总满足,等同旧行为)
 *   - 任一字段不满足 → false
 *   - 所有字段满足 → true
 *
 * 用法:Director 拼 pendingBeats 时调,过滤掉 trigger 未满足的 beat,
 *      避免 prompt 提示 LLM 触发条件不成熟的 beat。
 *
 * 字段语义:
 *   - trigger.location    :玩家当前必须在此 location
 *   - trigger.visitCount  :该 location 到访次数 ≥ 阈值(同时指定 location 时用 trigger.location;否则用 ctx.currentLocation)
 *   - trigger.timeOfDay   :剧本若引入时间需匹配(暂未实现时,只要 ctx.timeOfDay 不传就跳过)
 *   - trigger.completedBeats     :所有前置 beat 必须已完成(显式 DAG 依赖)
 *   - trigger.discoveredArtifacts:所有要求的 artifact 必须已发现(找到线索后才解锁)
 */
export function evaluateBeatTrigger(
  beat: Beat,
  ctx: {
    currentLocation: string | null;
    /** 该剧本各 location 的累计访问次数(plaza.locationVisitCount[scenarioId]) */
    visitCounts: Record<string, number>;
    /** 该剧本已完成的 beat ids(Set 是为了 O(1) 查询) */
    completedBeatIds: Set<string>;
    /** 该剧本已发现的 artifact ids */
    discoveredArtifactIds: Set<string>;
    /** 当前时段(剧本若引入时间系统);暂未实现 → 不传,timeOfDay 检查跳过 */
    timeOfDay?: 'day' | 'night' | 'dawn' | 'dusk';
  },
): boolean {
  if (!beat.trigger) return true;
  const t = beat.trigger;
  if (t.location && ctx.currentLocation !== t.location) return false;
  if (typeof t.visitCount === 'number') {
    // 如果 trigger 同时指定了 location,优先用 trigger.location 的 visit count;否则用当前 location
    const checkLoc = t.location ?? ctx.currentLocation;
    if (!checkLoc) return false; // 没 location 信息 → 无法判定 visitCount,保守拒
    const visits = ctx.visitCounts[checkLoc] ?? 0;
    if (visits < t.visitCount) return false;
  }
  if (t.timeOfDay && ctx.timeOfDay && t.timeOfDay !== ctx.timeOfDay) return false;
  if (t.completedBeats && !t.completedBeats.every((b) => ctx.completedBeatIds.has(b))) {
    return false;
  }
  if (
    t.discoveredArtifacts &&
    !t.discoveredArtifacts.every((a) => ctx.discoveredArtifactIds.has(a))
  ) {
    return false;
  }
  return true;
}

// ─── DLC Registry(运行时填充)─────────────────────────────────────

/**
 * 运行时注册的 DLC 剧本。lib/scenarios/dlc.ts 在 fetch + 校验后调 `_registerDlcScenario`
 * 把每个剧本塞进这里。注册前(loadAllDlc 还在跑)这个 Map 是空的。
 */
const dlcRegistry = new Map<string, Scenario>();
let dlcReady = false;

/**
 * "系统默认"剧本 ID。
 *
 * - `DEFAULT_SCENARIO_ID`(常量 'starmail'):给老代码用的兜底字面量(比如 messages
 *   旧 localStorage 迁移要一个固定 namespace)。PoC 假设第一个 DLC 是 starmail,
 *   如果未来第一个 DLC 改名 → 需要同时改这个常量 + 升 messages 迁移版本号。
 *
 * - `getDefaultScenarioId()`(动态值):返回"实际注册的第一个 DLC 的 id"。
 *   推荐新代码用这个,跟 DLC 列表保持一致。DLC 没注册时落回 'starmail' 占位。
 */
let defaultScenarioIdState: string = 'starmail';
export function getDefaultScenarioId(): string {
  return defaultScenarioIdState;
}

export const DEFAULT_SCENARIO_ID: string = 'starmail';

/**
 * 内部 API — 仅 lib/scenarios/dlc.ts 调用。校验过的 scenario 注册进 registry。
 * 同 id 重复注册会覆盖(适合热重载场景)。
 */
export function _registerDlcScenario(s: Scenario) {
  dlcRegistry.set(s.id, s);
  // 第一个注册的剧本作为 default(若 manifest 没指明)
  if (defaultScenarioIdState === 'starmail' && dlcRegistry.size === 1) {
    defaultScenarioIdState = s.id;
  }
}

/** 内部 API — loadAllDlc 完成后调用,翻转 dlcReady flag。 */
export function _markDlcReady() {
  dlcReady = true;
  // 通知订阅者(让 UI loading screen 自动解除)
  for (const fn of readyListeners) {
    try {
      fn();
    } catch {
      /* 单个 listener 挂了不影响别人 */
    }
  }
}

const readyListeners = new Set<() => void>();
/** UI 订阅 — DLC ready 后回调一次。返回 unsubscribe。 */
export function subscribeDlcReady(fn: () => void): () => void {
  if (dlcReady) {
    // 已 ready:下一 microtask 立刻调用(避免在订阅当帧同步触发,语义更一致)
    Promise.resolve().then(fn);
  }
  readyListeners.add(fn);
  return () => {
    readyListeners.delete(fn);
  };
}

/** Home / UI 用来判断"DLC 加载完没,可以渲染主 UI 了吗"。 */
export function isDlcReady(): boolean {
  return dlcReady;
}

/** DLC 注册数(给 UI 显示"已加载 N 个剧本"用)。 */
export function dlcCount(): number {
  return dlcRegistry.size;
}

// ─── 公共查询 API(保持同步语义,向后兼容)──────────────────────────

/**
 * 判断某 id 是不是"内置"剧本 — 改造后语义变成"通过 manifest DLC 加载",
 * 跟用户自定义剧本(localStorage)区分,UI 用这个决定是否能删。
 */
export function isBuiltinScenario(id: string): boolean {
  return dlcRegistry.has(id);
}

/** 查单个剧本:先查 DLC,再查用户自定义。DLC 没加载完时只能查到自定义剧本。 */
export function getScenario(id: string): Scenario | undefined {
  const fromDlc = dlcRegistry.get(id);
  if (fromDlc) return fromDlc;
  return getCustomScenario(id);
}

/** 列出全部剧本(DLC + 用户自定义,按这个顺序)。DLC 没加载完时只返回自定义剧本。 */
export function listScenarios(): Scenario[] {
  return [...dlcRegistry.values(), ...listCustomScenarios()];
}

// 注:老的 `BUILTIN_SCENARIOS` / `SCENARIOS` 常量已删除 — DLC 化后注册表是运行时填充的,
// 静态数组无法表达。所有调用方应该走 `listScenarios()`。grep 过整库无 import,移除安全。

/**
 * 广场模式 (Plaza Mode)
 * =====================
 *
 * 进剧本世界之前 / 出剧本世界之后的中转大厅。
 *
 * 数据模型核心:
 *   - force: 原力 —— 跨剧本通用积分,最稀有物资。进入剧本/升级队友/升级物品都要花。
 *   - player: 主角档案(包含心理状态,系统看到但 UI 不展示)
 *   - companions: 队友列表(每个可激活/休眠,可升级,可独立选择是否进剧本)
 *   - inventory: 背包物品。神奇物品有 magicTags,跨剧本时不匹配会被削弱
 *   - inScenario: 当前在哪个剧本(null = 在广场)
 *   - currentLocation: 玩家在剧本里的当前 location id(动态剧本用,null = 不启用 / 广场态)
 *   - currentCombatStats: 当前剧本里主角+队友的隐藏数值(HP/体力/意志,玩家看不到,LLM 看得到)
 *   - scenarioProgress[id].settled: 第一次拿到 forceReward 后置 true。再进不发奖励、免 entryCost
 *   - scenarioProgress[id].completedBeatIds: 复用为"已达成的剧情节点 IDs"。
 *     scenes 模式下是 checkpoint beat ids;动态模式(scenes 空)下由 LLM 输出
 *     `<!-- WC-EVENT milestone-reached id=xxx -->` 累加进同一字段,computeCompletion 自动按 targetMilestones 算。
 *
 * 持久化:整个 PlazaState 序列化到 localStorage(跨 session 保留)。
 */

import type { CombatStat } from './combat-stats';
import { makePlayerCombatStat, makeFullCombatStat, applyDeltaToStat } from './combat-stats';
// type-only import:DynamicLocation 类型 schema 跨模块共享。运行时这行被编译掉,无循环依赖。
import type { DynamicLocation, LocationArtifact, Scenario, WorldEvent } from './scenarios';
// P4 World Tick:WorldClock / WorldLogEntry 类型 + advance/evaluator 纯函数。
import type { WorldClock, WorldLogEntry } from './world-tick';
import {
  advanceClockWithEvents,
  findFiringWorldEvents,
  getInitialClock,
} from './world-tick';

// ─── Magic 系统标签 (6 个闭集) ─────────────────────────────────────

export type MagicSystem = 'tech' | 'magic' | 'psionic' | 'qi' | 'divine' | 'cosmic';

export const MAGIC_SYSTEMS: { id: MagicSystem; label: string; desc: string }[] = [
  { id: 'tech', label: '科技', desc: '赛博朋克 / 枪械 / 飞船 / 量子通信' },
  { id: 'magic', label: '魔法', desc: '西方咒语 / 法术 / 法杖 / 卷轴' },
  { id: 'psionic', label: '灵能', desc: '心灵感应 / 念力 / 预知 / 闪回' },
  { id: 'qi', label: '气功', desc: '东方内力 / 元气 / 真气 / 经脉' },
  { id: 'divine', label: '神圣', desc: '信仰 / 祝祷 / 神迹 / 圣物' },
  { id: 'cosmic', label: '宇宙', desc: '星辰之力 / 星象 / 黑洞 / 时空' },
];

// ─── 物品 ──────────────────────────────────────────────────────────

export interface Item {
  id: string;
  name: string;
  description: string;
  /** 物品来历(从哪个剧本/事件获得)。展示给用户,也用于跨剧本叙事。 */
  origin?: string;
  /** 'magic' = 神奇物品,可能跨剧本被削弱;'mundane' = 普通物品,全场通用 */
  type: 'magic' | 'mundane';
  /** 神奇物品依赖的 magic 系统。空数组 = 通用神奇(罕见)。 */
  magicTags?: MagicSystem[];
  level: number;
  imageUrl?: string | null;
  /**
   * 已在剧本里损毁/掉落,无法带回广场。true 时:
   *   - 仍留在 inventory 里(作为叙事痕迹,显示为灰色 + "已丢失")
   *   - 不可再带进新剧本(EntryModal loadout 默认排除)
   *   - 不可升级
   *   - 用户可手动 removeItem 清掉
   * 由 LLM 在剧本中输出 `<!-- WC-EVENT item-lost itemId=xxx -->` 标记触发。
   */
  lost?: boolean;
  /** 丢失发生在哪个剧本(展示用,例如 "陨落于 元末风云") */
  lostInScenarioId?: string;
}

export function itemUpgradeCost(item: Item): number {
  // 升级成本:level N → N+1
  return 50 * item.level;
}

/**
 * 判断物品在指定 magicTags 的剧本里是否被削弱。
 * 规则:
 *   - mundane 物品永远不削弱
 *   - 神奇物品 + 剧本未限定 magicTags(空) → 不削弱
 *   - 神奇物品 + 剧本限定 magicTags → 物品 tags 跟剧本 tags 有交集 = 正常,无交集 = 削弱
 */
export function isItemSuppressed(
  item: Item,
  scenarioMagicTags: MagicSystem[] | undefined,
): boolean {
  if (item.type === 'mundane') return false;
  if (!item.magicTags || item.magicTags.length === 0) return false;
  if (!scenarioMagicTags || scenarioMagicTags.length === 0) return false;
  return !item.magicTags.some((t) => scenarioMagicTags.includes(t));
}

// ─── 角色档案 ─────────────────────────────────────────────────────

/**
 * 角色档案里的一张图。
 *  - dataUrl: 实际图源(用户导入的或 SDXL 生成的 base64 dataUrl,也可以是 http URL)
 *  - source: 'import' = 用户导入, 'generated' = 立绘/自动生成
 *  - label: 可选标签(例如"夜战"、"日常"、"主立绘"),方便用户管理
 *  - addedAt: ISO 时间戳
 */
export interface CharacterImage {
  dataUrl: string;
  source: 'import' | 'generated';
  label?: string;
  addedAt: string;
}

export interface CharacterProfile {
  /** 关联到 CharacterSpec V4 ID(可以是 'player-self' / 'companion-xxx' / 'starmail-npc-yyy') */
  characterId: string;
  /**
   * 多图档案。
   *   - 空数组 = 未配图
   *   - 单图 = 唯一基准图
   *   - 多图 = baseImageIndex 指向作为"基准/封面"的那张
   * 用户导入的图默认追加到末尾;若 multiImageEnabled=false 且导入新图,
   * 旧基准被替换(单图模式语义)。
   */
  images: CharacterImage[];
  /** 基准图下标(默认 0)。越界时 UI 视为 0。 */
  baseImageIndex: number;
  /** 是否开启多图。false = 单图模式(UI 只露基准 + 替换按钮),true = 多图模式(露缩略图区)。 */
  multiImageEnabled: boolean;
  /** 来历(展示给用户) */
  origin: string;
  /** 描述(展示给用户) */
  description: string;
  /**
   * 心理状态。仅系统使用(注入到 Director / NPC system prompt),
   * UI 在管理面板里不展示给用户。Director 可读但不应该让 NPC 提及。
   */
  mentalState: string;
}

/** 获取档案的"基准图 dataUrl"。没有图返回 null,越界回落到第 0 张。 */
export function profileBaseImage(p: CharacterProfile): string | null {
  if (!p.images || p.images.length === 0) return null;
  const idx = p.baseImageIndex >= 0 && p.baseImageIndex < p.images.length ? p.baseImageIndex : 0;
  return p.images[idx]?.dataUrl ?? null;
}

// ─── 用户基础身份(全局,首次进入应用时建档)──────────────────────

/**
 * 玩家本人的真实身份(不是化身角色)。首次进入应用时强制 onboarding 填,
 * 之后跨剧本/跨 session 持久化复用。
 *
 * 跟 CharacterProfile 的区别:
 *   - CharacterProfile 是"用户管理的角色档案"(玩家自己+队友共用结构,有图/origin/mentalState)
 *   - UserProfile 是"玩家这个真人的基本元信息",字段极简(性别/年龄/昵称)
 *
 * 用途:
 *   - "灵魂进入"模式下,NPC prompt 注入"玩家化身为 <SoulIdentity.name>(性别 X / 年龄 X 由 userProfile 继承)"
 *   - "身体进入"模式下,NPC prompt 注入"玩家是来自异世界的访客 <nickname>(性别 X / 年龄 X)"
 */
export type Gender = 'male' | 'female' | 'other' | 'unspecified';

export interface UserProfile {
  gender: Gender;
  /** 真实年龄(0 = 未填) */
  age: number;
  /** 玩家想用的称呼(留空 → 在 prompt 里用通用代称"旅人") */
  nickname?: string;
  /** 是否已完成 onboarding。false = 首次访问应用,UI 应强制弹建档表单。 */
  filled: boolean;
}

export const DEFAULT_USER_PROFILE: UserProfile = {
  gender: 'unspecified',
  age: 0,
  filled: false,
};

// ─── 副本入境方式(每个 scenarioProgress 一份)──────────────────────

/**
 * 玩家进入副本时的身份选择:
 *   - 'soul':灵魂进入,化身为剧本预设的"玩家角色"(scenario.playerSoulIdentity)
 *   - 'body':身体进入,保留 userProfile 的基础身份,作"异世界访客"闯入
 */
export type EntryMode = 'soul' | 'body';

// ─── 队友 ──────────────────────────────────────────────────────────

export interface CompanionEntry {
  /** = profile.characterId,冗余存一份方便快速查 */
  characterId: string;
  /** true = 放出(活跃),false = 收起为卡片(休眠) */
  active: boolean;
  level: number;
  joinedAt: string;
  profile: CharacterProfile;
  /**
   * 生命状态。'alive' = 正常;'dead' = 在剧本里阵亡,无法带进新剧本,需在广场用原力复活。
   * 由 LLM 在剧本中输出 `<!-- WC-EVENT companion-died characterId=xxx -->` 标记触发。
   * 旧存档无此字段时按 'alive' 处理。
   */
  hp?: 'alive' | 'dead';
  /** 阵亡发生在哪个剧本(展示用,例如 "陨落于 挽歌之矛") */
  diedInScenarioId?: string;
}

export function companionUpgradeCost(c: CompanionEntry): number {
  return 100 * c.level;
}

/** 队友复活成本:50 × 等级。1 级 50,5 级 250。 */
export function companionReviveCost(c: CompanionEntry): number {
  return 50 * Math.max(1, c.level);
}

// ─── 剧情进度 / 关系 / 记忆 ───────────────────────────────────────

/**
 * 玩家跟单个 NPC 共同经历的记忆条目(超出 base CharacterSpec.memory.episodic 之外)。
 * 每次返广场时由 Director Agent 摘要会话产生;读对话时注入 NPC system prompt。
 */
export interface NpcEpisodicMemory {
  /** 该 NPC 的 character_id */
  npcId: string;
  /** 剧本 id(便于跨剧本时只调取本剧本的相关记忆) */
  scenarioId: string;
  /** "玩家说要送信给灯塔,我答应押车" 之类的浓缩 */
  scene: string;
  /** -1 (痛苦) ~ +1 (强烈正面),Director 评 */
  emotional_weight?: number;
  /** 自由标签 */
  tags?: string[];
  /** 真实时间戳 */
  real_timestamp: string;
}

/**
 * 玩家跟单个 NPC 的关系数值。
 * trust ∈ [-100, 100]:被骗 / 救场 时变动。Director 通过 trust_delta 操作。
 */
export interface NpcRelationship {
  npcId: string;
  scenarioId: string;
  trust: number;
  /** 关键瞬间(让 NPC 在 prompt 里能引用):"那次他没杀我"、"她偷了我的钱" */
  key_moments: string[];
}

/**
 * 剧本内的进度跟踪。一个 scenarioId 对应一份。
 */
export interface ScenarioProgress {
  scenarioId: string;
  /** 当前 scene id(scenes 非空时;否则为 null,自由 advance 模式) */
  currentSceneId: string | null;
  /** 触发过的 beat ids(跨 scene 累加) */
  completedBeatIds: string[];
  /** 已访问过的 scene ids(进 scene 时记录,用于回溯) */
  visitedSceneIds: string[];
  startedAt: string;
  /** 最近一次玩家在此剧本的活动时间 */
  lastVisitedAt: string;

  // ─── 入境身份 + 愿望(I-series 新增,初次进 EntryModal 提交时写入)─────

  /** 进入方式:'soul' 化身剧本角色 / 'body' 异世界访客闯入 */
  entryMode?: EntryMode;
  /** 玩家入境时提的愿望原始文本(最多 3 条,顺序保留) */
  wishes?: string[];
  /**
   * 命运批准的愿望:下标列表(指向 wishes 数组)。
   * 半透明语义:玩家只被告知"批准了 N 个",但不知道是哪 N 个;NPC prompt 里能看到具体。
   * 由 rollWishes(difficulty, wishesCount) 在 EntryModal 提交时摇出。
   */
  wishesGranted?: number[];
  /**
   * 'body' 模式下 LLM 生成的"穿越背景":怎么来的、初始装备、记忆碎片等。
   * 入境时调用一次 utility.summary 摇出,后续 NPC prompt 注入。
   * 'soul' 模式下此字段缺省。
   */
  bodyEntryContext?: string;

  /**
   * 是否已结算过(第一次拿到 forceReward > 0 时置 true)。
   * settled = true 后:
   *   - enterScenario 该剧本时 cost 强制为 0(免费再访,鼓励"回剧本陷 NPC")
   *   - exitScenario 时 rewardForce 强制为 0(防止刷原力)
   *   - 战斗 / 死亡 / 物品损失等不可逆损耗依然正常发生
   * 中途逃跑(reward=0)不算 settled,下次可重新尝试拿奖励。
   */
  settled?: boolean;
  /** 首次结算时间(展示用)。 */
  firstSettledAt?: string;

  // ─── P4 World Tick(可选,旧存档 / 不启用 eraTemplate 的剧本缺省) ──

  /**
   * 当前世界时钟。enterScenario 时若 progress 不存在 → 由 scenario.eraTemplate.initial 初始化;
   * 已 existing progress → 保留旧 clock(支持"上次离开时几点几日,回来还是几点几日")。
   * 不启用 P4 的剧本可以永远不写此字段;HUD/prompt 注入侧用 undefined 判退化。
   */
  worldClock?: WorldClock;
  /**
   * 已 fire 过的 WorldEvent.id 集合。每个 event 一辈子只 fire 一次,
   * 即使 clock 反复落进窗口也不会重新返回。
   * resetScenario 清掉整个 progress → 自然连这字段也清掉。
   */
  worldEventsFired?: string[];
  /**
   * 玩家可见的"世界事件流"日志。advanceClock 推进时新触发的 event 写入这里;
   * UI 可以渲染成"日报"。short_summary 缓存在 entry 里,避免作者改 scenario 文件后失同步。
   */
  worldLog?: WorldLogEntry[];
}

// ─── 立绘偏好 ─────────────────────────────────────────────────────

/**
 * 多情绪立绘 / 场景插画的用户偏好。
 *
 * emotionMode 3 档:
 *   - 'on'  默认对所有角色开启多情绪立绘(切 NPC 时自动生 5 种情绪)
 *   - 'ask' 默认不生,但 UI 弹"为此角色启用"按钮,玩家逐个角色决定
 *   - 'off' 全部关闭,只保留 base_prompt 那一张
 *
 * perCharacter override:
 *   - 'ask' 模式下,玩家点过"为此角色启用"会写入 'on';"永不"会写入 'off'
 *   - 'on' 模式下,玩家可以单个角色 opt-out 写入 'off'
 *   - 'off' 模式下,玩家可以单个角色 opt-in 写入 'on'
 */
export interface PortraitPrefs {
  emotionMode: 'on' | 'ask' | 'off';
  perCharacter: Record<string, 'on' | 'off'>;
  /** 场景插画总开关(scene.imagePrompt 存在时生效) */
  sceneImagesEnabled: boolean;
}

export const DEFAULT_PORTRAIT_PREFS: PortraitPrefs = {
  emotionMode: 'ask',
  perCharacter: {},
  sceneImagesEnabled: true,
};

/**
 * 综合 emotionMode + perCharacter 判断指定角色是否启用多情绪。
 * 返回:
 *   - 'on'  = 启用(可以生 / 显示其他情绪立绘)
 *   - 'off' = 关闭(只用 neutral)
 *   - 'ask' = 待询问(玩家还没决定,UI 应弹按钮)
 */
export function resolveEmotionPolicy(
  prefs: PortraitPrefs,
  characterId: string,
): 'on' | 'off' | 'ask' {
  const ov = prefs.perCharacter[characterId];
  if (ov === 'on' || ov === 'off') return ov;
  if (prefs.emotionMode === 'on') return 'on';
  if (prefs.emotionMode === 'off') return 'off';
  return 'ask';
}

// ─── Plaza 全局状态 ───────────────────────────────────────────────

/**
 * G14:对话历史摘要 — 当 messages-compress 达到 tier 80% 时,把摘要文本写进这里。
 * key = `${scenarioId}::${npcId}`,允许同 npcId 在不同剧本各存一份。
 * 跨 session(刷新页面)摘要不丢,下次 NPC system prompt 会注入这一段让他"记得"。
 */
export interface NpcSummary {
  scenarioId: string;
  text: string;
  /** 最后更新的 ISO 时间戳 */
  ts: string;
}

/**
 * 进入剧本时的"携带快照":这次实际带了哪些队友 / 物品进去。
 * 玩家可以在 EntryModal 里把活着的队友/未丢失的物品全部 / 部分取消勾选。
 * 进入后这份快照决定:
 *   - NPC prompt 注入哪些队友 / 物品到主角身边
 *   - LLM 输出 `<!-- WC-EVENT companion-died/item-lost -->` 时只能命中这份名单(parser 白名单)
 *   - 未带进来的队友 / 物品不可能在本次剧本里阵亡 / 丢失
 * exitScenario 时清空。
 */
export interface RunLoadout {
  scenarioId: string;
  companionIds: string[];
  itemIds: string[];
}

/**
 * 玩家级偏好设置(跨剧本生效)。第一版只放 allowRuntimeExpansion;
 * 以后还会增加其他玩家级开关时就往里加字段。
 */
export interface PlayerSettings {
  /**
   * 是否允许 LLM 在剧情中即兴扩展新场所(运行时 dynamic location)。
   * 双开关之一:剧本侧也必须 scenario.dynamicLocations.allowed=true 才生效。
   * 默认 false(保守,新存档进剧本依然是种子模式)。
   */
  allowRuntimeExpansion: boolean;
}

export interface PlazaState {
  force: number;
  player: CharacterProfile;
  /** I-series:玩家真人的基础身份(性别/年龄/昵称),首次进入应用建档 */
  userProfile: UserProfile;
  companions: CompanionEntry[];
  inventory: Item[];
  /** 当前所在剧本 ID。null = 在广场。 */
  inScenario: string | null;
  /**
   * 玩家在动态剧本里的当前 location ID(scenario.locations[].id)。
   *   - 广场态 / 不启用 location 机制的剧本 / 旧存档 → null
   *   - 进剧本时由 caller(page.tsx)读 scenario.initialLocation 后调 setCurrentLocation 写入
   *   - 剧本内由 LLM 输出 `<!-- WC-EVENT location-changed value=xxx -->` 更新
   * 用途:NPC selector 按 location 过滤(NPC.locations 跟此交集非空才出现)。
   */
  currentLocation: string | null;
  /**
   * 当前剧本的携带快照。null = 在广场 / 旧存档兼容。
   * 仅 inScenario != null 时有意义,inScenario == null 时应保证此字段也 null。
   */
  currentRunLoadout: RunLoadout | null;
  /**
   * 当前剧本里主角 + 携带队友的隐藏数值(HP / 体力 / 意志)。
   * key:
   *   - `player` = 主角
   *   - `<companion characterId>` = 该队友
   * 仅 inScenario != null 时有数据;exitScenario 清空(出剧本回满,下次进重新初始化)。
   * 玩家看不到精确数字 — 只通过 LLM 叙事感知。
   * 旧存档兼容:不存在时视为空 map。
   */
  currentCombatStats: Record<string, CombatStat>;
  /** 每个剧本的进度(进过几次就有几份);scenarioId 为 key */
  scenarioProgress: Record<string, ScenarioProgress>;
  /** 跟每个 NPC 的关系数值;npcId 为 key */
  relationships: Record<string, NpcRelationship>;
  /** 跟每个 NPC 的共同记忆条目;npcId 为 key,值是该 NPC 的记忆列表 */
  npcMemories: Record<string, NpcEpisodicMemory[]>;
  /**
   * G14:对话摘要;key 形如 `${scenarioId}::${npcId}`。
   * 跨 session 持久化(刷新不丢)。
   */
  npcSummaries: Record<string, NpcSummary>;
  /** 多情绪立绘 / 场景插画偏好 */
  portraitPrefs: PortraitPrefs;
  /**
   * 世界控制三件套·到访次数:scenarioId → locationId → 累计到访次数。
   * setCurrentLocation 自动 +1(切到同一 location 不重复算,首次进剧本调 setCurrentLocation 也算 1)。
   * 用途:beat.trigger.visitCount 判定;后续 UI 也能展示"已到访 N 次"。
   * resetScenario 时清理 [scenarioId] 整条;exitScenario 保留(回访累积)。
   */
  locationVisitCount: Record<string, Record<string, number>>;
  /**
   * 世界控制三件套·场景状态覆盖:scenarioId → locationId → {key: value}。
   * 跟 ScenarioLocation.sceneState(初始静态)合并使用 — overrides 优先。
   * 由 LLM 输出 `<!-- WC-EVENT scene-state-changed value=<locId.key=val> -->` 写入。
   * 用途:让"客栈被烧后描述变成废墟"成为可能(prompt 注入时取合并值)。
   * resetScenario 时清理 [scenarioId] 整条。
   */
  sceneStateOverrides: Record<string, Record<string, Record<string, string>>>;
  /**
   * 世界控制三件套·已发现的 artifact 集合:scenarioId → artifactId[]。
   * 由 LLM 输出 `<!-- WC-EVENT artifact-discovered value=<artifactId> -->` 累加(去重)。
   * 用途:已发现的从 prompt"可调查列表"移除;beat.trigger.discoveredArtifacts 判定。
   * resetScenario 时清理 [scenarioId] 整条。
   */
  discoveredArtifacts: Record<string, string[]>;
  /**
   * 玩家级偏好设置(跨剧本生效)。新存档默认全部保守(allowRuntimeExpansion=false)。
   */
  playerSettings: PlayerSettings;
  /**
   * 运行时由 LLM 通过 WC-EVENT location-spawned 物化的动态地点。
   *   - key: scenarioId → 内层 key: locationId → DynamicLocation
   *   - buildContext 优先查这里(找不到再 fallback 到 scenario.locations)
   *   - resetScenario 时整片清理 [scenarioId];exitScenario 保留(让玩家再访依旧能逛)
   */
  spawnedLocations: Record<string, Record<string, DynamicLocation>>;
  /**
   * 当前 session 累计 spawn 次数:scenarioId → count。
   *   - enterScenario 时清零 [scenarioId]
   *   - 每次 plaza.spawnDynamicLocation 成功 +1
   *   - cap 由 scenario.dynamicLocations.maxPerSession 决定(默认 8)
   * 持久化以避免 refresh 浏览器后无脑刷配额。
   */
  sessionSpawnCount: Record<string, number>;
}

// ─── 默认起手数据 ─────────────────────────────────────────────────

const NOW = '2026-05-17T00:00:00Z';

const DEFAULT_PLAZA: PlazaState = {
  force: 100,
  player: {
    characterId: 'player-self',
    images: [],
    baseImageIndex: 0,
    multiImageEnabled: false,
    origin: '地球·新加坡,2089 年',
    description: '刚通过 IPU 邮差学院考核的新晋邮差。简历干净,经历空白,等待第一个故事把它写满。',
    mentalState: '初来乍到,对一切充满好奇。隐约觉得自己跟邮路有命中注定的牵连。',
  },
  userProfile: { ...DEFAULT_USER_PROFILE },
  companions: [
    {
      characterId: 'companion-xiaoming',
      active: true,
      level: 1,
      joinedAt: NOW,
      profile: {
        characterId: 'companion-xiaoming',
        images: [],
        baseImageIndex: 0,
        multiImageEnabled: false,
        origin: '玩家自创·地球·南京',
        description: '一个温和但内心倔强的年轻人。表面好说话,认死理时谁也劝不动。怕鬼,爱吃甜食。',
        mentalState: '想跟玩家一起走遍宇宙,但心里其实有点怕。会偷偷把零食塞给玩家。',
      },
    },
  ],
  inventory: [
    {
      id: 'item-starter-flask',
      name: '空酒壶',
      description: '一个普通的酒壶,内壁有薄薄一层咖啡渍。容量约 200ml。',
      origin: '出门前从家里带的',
      type: 'mundane',
      level: 1,
    },
    {
      id: 'item-cosmic-charm',
      name: '星纹护身符',
      description: '看起来无奇的玻璃护身符,但在某些角度仔细看会反光出微小星座图案。',
      origin: '在地球邮差学院结业时被一位不愿透露姓名的老师塞到口袋',
      type: 'magic',
      magicTags: ['cosmic'],
      level: 1,
    },
  ],
  inScenario: null,
  currentLocation: null,
  currentRunLoadout: null,
  currentCombatStats: {},
  scenarioProgress: {},
  relationships: {},
  npcMemories: {},
  npcSummaries: {},
  portraitPrefs: { emotionMode: 'ask', perCharacter: {}, sceneImagesEnabled: true },
  locationVisitCount: {},
  sceneStateOverrides: {},
  discoveredArtifacts: {},
  playerSettings: { allowRuntimeExpansion: false },
  spawnedLocations: {},
  sessionSpawnCount: {},
};

// ─── 持久化 ──────────────────────────────────────────────────────

const PLAZA_KEY = 'wc_poc_plaza_v1';

/**
 * 验证并清洗 CharacterImage 数组,丢掉脏数据(null / 缺 dataUrl / 类型不对)。
 * S3 修复:既覆盖旧格式迁移,也覆盖"已新格式但脏"的情况。
 */
function sanitizeImages(raw: unknown): CharacterImage[] {
  if (!Array.isArray(raw)) return [];
  const out: CharacterImage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const i = item as Record<string, unknown>;
    if (typeof i.dataUrl !== 'string' || !i.dataUrl) continue;
    out.push({
      dataUrl: i.dataUrl,
      source: i.source === 'generated' ? 'generated' : 'import',
      label: typeof i.label === 'string' ? i.label : undefined,
      addedAt: typeof i.addedAt === 'string' ? i.addedAt : new Date().toISOString(),
    });
  }
  return out;
}

/** 把 idx clamp 到 [0, images.length-1] 区间,空数组返 0。NaN/-1/Infinity 都兜底。 */
function clampBaseIndex(idx: unknown, imagesLen: number): number {
  if (typeof idx !== 'number' || !Number.isFinite(idx)) return 0;
  if (imagesLen === 0) return 0;
  const n = Math.floor(idx);
  if (n < 0) return 0;
  if (n >= imagesLen) return imagesLen - 1;
  return n;
}

/** 把旧版 profile (imageUrl: string|null) 迁移到新版 + 清洗已新格式的脏数据。 */
function migrateProfile(p: unknown): CharacterProfile {
  const def = cloneDefault().player;
  if (!p || typeof p !== 'object') return def;
  const obj = p as Record<string, unknown>;
  // 已经是新格式:也跑一遍 sanitizeImages + clamp,防止脏数据(null/缺字段)进入运行时
  if (Array.isArray(obj.images)) {
    const images = sanitizeImages(obj.images);
    return {
      characterId: typeof obj.characterId === 'string' ? obj.characterId : def.characterId,
      images,
      baseImageIndex: clampBaseIndex(obj.baseImageIndex, images.length),
      multiImageEnabled: typeof obj.multiImageEnabled === 'boolean' ? obj.multiImageEnabled : false,
      origin: typeof obj.origin === 'string' ? obj.origin : def.origin,
      description: typeof obj.description === 'string' ? obj.description : def.description,
      mentalState: typeof obj.mentalState === 'string' ? obj.mentalState : def.mentalState,
    };
  }
  // 旧格式:imageUrl 迁移到 images[0]
  const oldUrl = typeof obj.imageUrl === 'string' ? obj.imageUrl : null;
  return {
    characterId: typeof obj.characterId === 'string' ? obj.characterId : def.characterId,
    images: oldUrl
      ? [{ dataUrl: oldUrl, source: 'import', addedAt: new Date().toISOString() }]
      : [],
    baseImageIndex: 0,
    multiImageEnabled: false,
    origin: typeof obj.origin === 'string' ? obj.origin : def.origin,
    description: typeof obj.description === 'string' ? obj.description : def.description,
    mentalState: typeof obj.mentalState === 'string' ? obj.mentalState : def.mentalState,
  };
}

function migrateNpcSummaries(raw: unknown): Record<string, NpcSummary> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, NpcSummary> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    if (typeof o.scenarioId !== 'string' || typeof o.text !== 'string' || !o.text.trim()) continue;
    out[k] = {
      scenarioId: o.scenarioId,
      text: o.text,
      ts: typeof o.ts === 'string' ? o.ts : new Date().toISOString(),
    };
  }
  return out;
}

/**
 * I-series:把存储里的 userProfile 容错读出来。
 *   - 旧 plaza 数据没此字段 → 全 default,filled=false 让 onboarding 弹
 *   - 新字段脏数据(gender 不在 enum / age 不是数字 / nickname 空白)→ 各自降级
 */
function migrateUserProfile(raw: unknown): UserProfile {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_USER_PROFILE };
  const r = raw as Record<string, unknown>;
  const gender: Gender =
    r.gender === 'male' || r.gender === 'female' || r.gender === 'other'
      ? r.gender
      : 'unspecified';
  const ageNum = typeof r.age === 'number' && Number.isFinite(r.age) ? Math.floor(r.age) : 0;
  const age = ageNum > 0 && ageNum < 200 ? ageNum : 0;
  const rawNick = typeof r.nickname === 'string' ? r.nickname.trim() : '';
  const nickname = rawNick ? rawNick.slice(0, 30) : undefined;
  const filled = typeof r.filled === 'boolean' ? r.filled : false;
  return { gender, age, nickname, filled };
}

/** 旧版无此字段 → 用 default;新版校验形状,丢脏数据。 */
function migratePortraitPrefs(raw: unknown): PortraitPrefs {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PORTRAIT_PREFS, perCharacter: {} };
  const r = raw as Record<string, unknown>;
  const mode =
    r.emotionMode === 'on' || r.emotionMode === 'off' || r.emotionMode === 'ask'
      ? (r.emotionMode as 'on' | 'off' | 'ask')
      : 'ask';
  const per: Record<string, 'on' | 'off'> = {};
  if (r.perCharacter && typeof r.perCharacter === 'object') {
    for (const [k, v] of Object.entries(r.perCharacter as Record<string, unknown>)) {
      if (v === 'on' || v === 'off') per[k] = v;
    }
  }
  const sceneImagesEnabled =
    typeof r.sceneImagesEnabled === 'boolean' ? r.sceneImagesEnabled : true;
  return { emotionMode: mode, perCharacter: per, sceneImagesEnabled };
}

function migrateCompanion(c: unknown): CompanionEntry | null {
  if (!c || typeof c !== 'object') return null;
  const obj = c as Record<string, unknown>;
  if (typeof obj.characterId !== 'string') return null;
  return {
    characterId: obj.characterId,
    active: typeof obj.active === 'boolean' ? obj.active : true,
    level: typeof obj.level === 'number' ? obj.level : 1,
    joinedAt: typeof obj.joinedAt === 'string' ? obj.joinedAt : NOW,
    profile: migrateProfile(obj.profile),
    hp: obj.hp === 'dead' ? 'dead' : 'alive',
    diedInScenarioId:
      typeof obj.diedInScenarioId === 'string' ? obj.diedInScenarioId : undefined,
  };
}

/** Inventory item 容错读取:补全 lost / lostInScenarioId 字段,丢脏数据。 */
function migrateItem(it: unknown): Item | null {
  if (!it || typeof it !== 'object') return null;
  const o = it as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return null;
  return {
    id: o.id,
    name: o.name,
    description: typeof o.description === 'string' ? o.description : '',
    origin: typeof o.origin === 'string' ? o.origin : undefined,
    type: o.type === 'magic' ? 'magic' : 'mundane',
    magicTags: Array.isArray(o.magicTags)
      ? (o.magicTags.filter(
          (t) =>
            t === 'tech' ||
            t === 'magic' ||
            t === 'psionic' ||
            t === 'qi' ||
            t === 'divine' ||
            t === 'cosmic',
        ) as MagicSystem[])
      : undefined,
    level: typeof o.level === 'number' && o.level > 0 ? Math.floor(o.level) : 1,
    imageUrl: typeof o.imageUrl === 'string' ? o.imageUrl : null,
    lost: o.lost === true,
    lostInScenarioId:
      typeof o.lostInScenarioId === 'string' ? o.lostInScenarioId : undefined,
  };
}

/** 容错读取 RunLoadout(旧存档无此字段时返回 null)。 */
function migrateLoadout(raw: unknown): RunLoadout | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.scenarioId !== 'string') return null;
  const cIds = Array.isArray(r.companionIds)
    ? r.companionIds.filter((x): x is string => typeof x === 'string')
    : [];
  const iIds = Array.isArray(r.itemIds)
    ? r.itemIds.filter((x): x is string => typeof x === 'string')
    : [];
  return { scenarioId: r.scenarioId, companionIds: cIds, itemIds: iIds };
}

/** 容错读取单个 CombatStat(脏数据/缺字段时返回 null,让 enterScenario 重新初始化)。 */
function migrateCombatStat(raw: unknown): CombatStat | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  function readSlot(v: unknown): { current: number; max: number } | null {
    if (!v || typeof v !== 'object') return null;
    const s = v as Record<string, unknown>;
    const cur = typeof s.current === 'number' && Number.isFinite(s.current) ? s.current : null;
    const mx = typeof s.max === 'number' && Number.isFinite(s.max) ? s.max : null;
    if (cur === null || mx === null) return null;
    return { current: Math.max(0, Math.floor(cur)), max: Math.max(0, Math.floor(mx)) };
  }
  const hp = readSlot(o.hp);
  const stamina = readSlot(o.stamina);
  const willpower = readSlot(o.willpower);
  if (!hp || !stamina || !willpower) return null;
  // conditions:旧存档没此字段 → 空数组。脏数据 → 过滤掉非字符串项 + 归一化 + 截 20 个
  const conditions = Array.isArray(o.conditions)
    ? Array.from(
        new Set(
          o.conditions
            .filter((c): c is string => typeof c === 'string')
            .map((c) => c.trim().toLowerCase())
            .filter((c) => c.length > 0 && c.length <= 40),
        ),
      ).slice(-20)
    : [];
  return { hp, stamina, willpower, conditions };
}

/** 容错读取 currentCombatStats map。 */
function migrateCombatStatsMap(raw: unknown): Record<string, CombatStat> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, CombatStat> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const stat = migrateCombatStat(v);
    if (stat) out[k] = stat;
  }
  return out;
}

// ─── 世界控制三件套 migration ─────────────────────────────────────

/** 容错读取 locationVisitCount(scenarioId → locationId → number)。脏值丢弃。 */
function migrateLocationVisitCount(raw: unknown): Record<string, Record<string, number>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, number>> = {};
  for (const [sid, perLoc] of Object.entries(raw as Record<string, unknown>)) {
    if (!perLoc || typeof perLoc !== 'object' || Array.isArray(perLoc)) continue;
    const inner: Record<string, number> = {};
    for (const [lid, count] of Object.entries(perLoc as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
        inner[lid] = Math.floor(count);
      }
    }
    if (Object.keys(inner).length > 0) out[sid] = inner;
  }
  return out;
}

/** 容错读取 sceneStateOverrides(scenarioId → locationId → key/val map)。 */
function migrateSceneStateOverrides(
  raw: unknown,
): Record<string, Record<string, Record<string, string>>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, Record<string, string>>> = {};
  for (const [sid, perLoc] of Object.entries(raw as Record<string, unknown>)) {
    if (!perLoc || typeof perLoc !== 'object' || Array.isArray(perLoc)) continue;
    const inner: Record<string, Record<string, string>> = {};
    for (const [lid, kvRaw] of Object.entries(perLoc as Record<string, unknown>)) {
      if (!kvRaw || typeof kvRaw !== 'object' || Array.isArray(kvRaw)) continue;
      const kv: Record<string, string> = {};
      for (const [k, v] of Object.entries(kvRaw as Record<string, unknown>)) {
        if (typeof k === 'string' && /^[a-z0-9_-]+$/.test(k) && typeof v === 'string') {
          kv[k] = v;
        }
      }
      if (Object.keys(kv).length > 0) inner[lid] = kv;
    }
    if (Object.keys(inner).length > 0) out[sid] = inner;
  }
  return out;
}

/** 容错读取 discoveredArtifacts(scenarioId → artifactId[] 去重)。 */
function migrateDiscoveredArtifacts(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [sid, arr] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(arr)) continue;
    const filtered = Array.from(
      new Set(
        (arr as unknown[]).filter(
          (a): a is string => typeof a === 'string' && /^[a-z0-9-]+$/.test(a),
        ),
      ),
    );
    if (filtered.length > 0) out[sid] = filtered;
  }
  return out;
}

// ─── 运行时扩展(动态 location)migration ─────────────────────────

/** 容错读取 playerSettings — 缺字段或脏数据均回 default。 */
function migratePlayerSettings(raw: unknown): PlayerSettings {
  const def: PlayerSettings = { allowRuntimeExpansion: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return def;
  const o = raw as Record<string, unknown>;
  return {
    allowRuntimeExpansion:
      typeof o.allowRuntimeExpansion === 'boolean'
        ? o.allowRuntimeExpansion
        : def.allowRuntimeExpansion,
  };
}

/** 容错读取单个 DynamicLocation;字段不全 / 脏数据返 null(整片丢弃,避免 prompt 漂移)。 */
function migrateDynamicLocation(raw: unknown): DynamicLocation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (typeof o.name !== 'string' || !o.name) return null;
  if (typeof o.description !== 'string') return null;
  if (typeof o.parent !== 'string' || !o.parent) return null;
  if (o.isDynamic !== true) return null;
  // connections:Array<string>(空允许 — 但物化时一般至少 = [parent])
  const connectionsRaw = Array.isArray(o.connections) ? o.connections : [];
  const connections = connectionsRaw.filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );
  // sceneState:Record<string,string>,只保留合法 kebab/snake key
  const sceneStateRaw =
    o.sceneState && typeof o.sceneState === 'object' && !Array.isArray(o.sceneState)
      ? (o.sceneState as Record<string, unknown>)
      : {};
  const sceneState: Record<string, string> = {};
  for (const [k, v] of Object.entries(sceneStateRaw)) {
    if (/^[a-z0-9_-]+$/.test(k) && typeof v === 'string') sceneState[k] = v;
  }
  // artifacts:简单字段校验,允许 LLM 后期沉淀(第一版一般空)
  const artifactsRaw = Array.isArray(o.artifacts) ? o.artifacts : [];
  const artifacts: LocationArtifact[] = [];
  for (const a of artifactsRaw) {
    if (!a || typeof a !== 'object') continue;
    const ao = a as Record<string, unknown>;
    if (typeof ao.id !== 'string' || typeof ao.name !== 'string' || typeof ao.description !== 'string') continue;
    artifacts.push({
      id: ao.id,
      name: ao.name,
      description: ao.description,
      requiresCompletedBeats: Array.isArray(ao.requiresCompletedBeats)
        ? (ao.requiresCompletedBeats as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined,
      tags: Array.isArray(ao.tags)
        ? (ao.tags as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined,
    });
  }
  return {
    id: o.id,
    name: o.name,
    description: o.description,
    connections,
    sceneState,
    artifacts,
    isDynamic: true,
    parent: o.parent,
    generatedAt:
      typeof o.generatedAt === 'number' && Number.isFinite(o.generatedAt) ? o.generatedAt : Date.now(),
    visitCount:
      typeof o.visitCount === 'number' && Number.isFinite(o.visitCount) && o.visitCount >= 0
        ? Math.floor(o.visitCount)
        : 0,
  };
}

/** 容错读取 spawnedLocations(scenarioId → locationId → DynamicLocation)。 */
function migrateSpawnedLocations(
  raw: unknown,
): Record<string, Record<string, DynamicLocation>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, DynamicLocation>> = {};
  for (const [sid, perLoc] of Object.entries(raw as Record<string, unknown>)) {
    if (!perLoc || typeof perLoc !== 'object' || Array.isArray(perLoc)) continue;
    const inner: Record<string, DynamicLocation> = {};
    for (const [lid, locRaw] of Object.entries(perLoc as Record<string, unknown>)) {
      const m = migrateDynamicLocation(locRaw);
      // 一致性:外层 key 必须 == loc.id,否则丢
      if (m && m.id === lid) inner[lid] = m;
    }
    if (Object.keys(inner).length > 0) out[sid] = inner;
  }
  return out;
}

/** 容错读取 sessionSpawnCount(scenarioId → count)。负数 / 脏数据 → 0(过滤掉) */
function migrateSessionSpawnCount(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [sid, n] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
      out[sid] = Math.floor(n);
    }
  }
  return out;
}

function readPlaza(): PlazaState {
  if (typeof window === 'undefined') return cloneDefault();
  try {
    const raw = window.localStorage.getItem(PLAZA_KEY);
    if (!raw) return cloneDefault();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return cloneDefault();
    // 容错合并 + 迁移:旧数据缺字段时用 default 补,旧 imageUrl 转新 images[]
    const def = cloneDefault();
    // L2 修复:companions 去重 by characterId(若 bug 数据存在,find/upgrade 只命中首个,其他幽灵存活)
    const rawCompanions = Array.isArray(parsed.companions) ? parsed.companions : def.companions;
    const seenIds = new Set<string>();
    const companions: CompanionEntry[] = [];
    for (const cRaw of rawCompanions) {
      const c = migrateCompanion(cRaw);
      if (!c) continue;
      if (seenIds.has(c.characterId)) continue;
      seenIds.add(c.characterId);
      companions.push(c);
    }
    // Inventory 也走 migrate 以补全 lost / lostInScenarioId
    const rawInventory = Array.isArray(parsed.inventory) ? parsed.inventory : def.inventory;
    const inventory: Item[] = [];
    for (const it of rawInventory) {
      const m = migrateItem(it);
      if (m) inventory.push(m);
    }
    const inScenario = typeof parsed.inScenario === 'string' ? parsed.inScenario : null;
    // currentLocation 只在剧本内才有意义;广场态强制 null。脏数据(非字符串) → null
    const currentLocation: string | null =
      inScenario && typeof parsed.currentLocation === 'string' && parsed.currentLocation
        ? parsed.currentLocation
        : null;
    // currentRunLoadout 只在 inScenario 一致时才采用,防止旧脏数据
    const loadoutRaw = migrateLoadout(parsed.currentRunLoadout);
    const currentRunLoadout: RunLoadout | null =
      loadoutRaw && inScenario && loadoutRaw.scenarioId === inScenario ? loadoutRaw : null;
    // currentCombatStats 同理 — 不在剧本里就清空
    const currentCombatStats: Record<string, CombatStat> = inScenario
      ? migrateCombatStatsMap(parsed.currentCombatStats)
      : {};
    return {
      force: typeof parsed.force === 'number' ? parsed.force : def.force,
      player: migrateProfile(parsed.player),
      userProfile: migrateUserProfile(parsed.userProfile),
      companions,
      inventory,
      inScenario,
      currentLocation,
      currentRunLoadout,
      currentCombatStats,
      // P1.2:剧情骨架附带数据。旧 localStorage 数据缺这些字段会用 {} 补
      scenarioProgress:
        parsed.scenarioProgress && typeof parsed.scenarioProgress === 'object'
          ? (parsed.scenarioProgress as Record<string, ScenarioProgress>)
          : {},
      relationships:
        parsed.relationships && typeof parsed.relationships === 'object'
          ? (parsed.relationships as Record<string, NpcRelationship>)
          : {},
      npcMemories:
        parsed.npcMemories && typeof parsed.npcMemories === 'object'
          ? (parsed.npcMemories as Record<string, NpcEpisodicMemory[]>)
          : {},
      npcSummaries: migrateNpcSummaries(parsed.npcSummaries),
      portraitPrefs: migratePortraitPrefs(parsed.portraitPrefs),
      locationVisitCount: migrateLocationVisitCount(parsed.locationVisitCount),
      sceneStateOverrides: migrateSceneStateOverrides(parsed.sceneStateOverrides),
      discoveredArtifacts: migrateDiscoveredArtifacts(parsed.discoveredArtifacts),
      playerSettings: migratePlayerSettings(parsed.playerSettings),
      spawnedLocations: migrateSpawnedLocations(parsed.spawnedLocations),
      sessionSpawnCount: migrateSessionSpawnCount(parsed.sessionSpawnCount),
    };
  } catch {
    return cloneDefault();
  }
}

/**
 * 上次 writePlaza 失败的错误(localStorage 配额溢出最常见)。
 * UI 可以读这个 → 提示用户"⚠ 浏览器存储已满,本次更改未保存,可考虑清除大图"。
 * 成功一次后自动清掉。
 */
let lastWriteError: string | null = null;
export function getPlazaWriteError(): string | null {
  return lastWriteError;
}
export function clearPlazaWriteError() {
  lastWriteError = null;
}

/**
 * 估算当前 plaza state 在 localStorage 里占用的字节数。
 *
 * 浏览器 localStorage 存的是 UTF-16 编码字符串,所以 string.length * 2 是个合理近似。
 * 各浏览器 quota 不一:Chrome/Edge ~10MB,Safari ~5MB(per origin)。
 * 取 5MB 做警戒线最保守(Safari 用户也不会撞)。
 *
 * 返回:
 *   - bytes: 当前用量(估算)
 *   - quota: 警戒线(默认 5MB)
 *   - percent: 0-100
 *   - level: 'ok' | 'warn' (>70%) | 'danger' (>90%)
 *
 * LAUNCH-T6:UI 可以用这个数据画进度条 + 接近上限时主动提示用户导出/重置,
 * 而不是等到 QuotaExceededError 才告知。
 */
export type PlazaStorageStat = {
  bytes: number;
  quota: number;
  percent: number;
  level: 'ok' | 'warn' | 'danger';
};

export function getPlazaStorageSize(): PlazaStorageStat {
  const quota = 5_000_000;
  if (typeof window === 'undefined') {
    return { bytes: 0, quota, percent: 0, level: 'ok' };
  }
  try {
    const raw = window.localStorage.getItem(PLAZA_KEY) ?? '';
    const bytes = raw.length * 2; // UTF-16
    const percent = Math.min(100, (bytes / quota) * 100);
    const level: PlazaStorageStat['level'] =
      percent > 90 ? 'danger' : percent > 70 ? 'warn' : 'ok';
    return { bytes, quota, percent, level };
  } catch {
    return { bytes: 0, quota, percent: 0, level: 'ok' };
  }
}

/**
 * 导出整个 plaza state 为 JSON string,供用户下载备份。
 * 包含所有进度 / 关系 / 库存 / 已 spawn 的 dynamic location。
 */
export function exportPlazaAsJson(): string {
  if (typeof window === 'undefined') return '{}';
  try {
    const raw = window.localStorage.getItem(PLAZA_KEY) ?? '{}';
    // 美化输出
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return '{}';
  }
}

function writePlaza(s: PlazaState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PLAZA_KEY, JSON.stringify(s));
    lastWriteError = null;
  } catch (e) {
    // S4 修复:不再静默吞错。常见是 QuotaExceededError(大图 dataUrl 超 5-10MB localStorage 配额)。
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    lastWriteError = `保存失败(${msg})。可能是图片太大撑爆 localStorage,试着清除部分图片或重置广场。`;
    if (typeof console !== 'undefined') console.error('[plaza] writePlaza failed:', e);
  }
  // G11:通知订阅者(同窗口的 storage event 不触发,需要自己 pub-sub)
  for (const fn of plazaListeners) {
    try {
      fn();
    } catch {
      /* listener 自己挂了不影响别人 */
    }
  }
}

// ─── 订阅 ─────────────────────────────────────────────────────────

const plazaListeners = new Set<() => void>();

/**
 * 订阅 plaza 变化 — 同窗口内任何 writePlaza 调用都会通知。
 * 返回 unsubscribe 函数,组件 unmount 时调用。
 * 跨 tab/window 的同步仍靠 storage event,这个 pub-sub 只解决同窗口 stale 问题。
 */
export function subscribePlaza(listener: () => void): () => void {
  plazaListeners.add(listener);
  return () => {
    plazaListeners.delete(listener);
  };
}

function cloneDefault(): PlazaState {
  return JSON.parse(JSON.stringify(DEFAULT_PLAZA));
}

// ─── 操作 API ────────────────────────────────────────────────────

export type EnterScenarioResult = { ok: true } | { ok: false; reason: string };
export type UpgradeResult = { ok: true; newLevel: number } | { ok: false; reason: string };

export const plaza = {
  get: readPlaza,
  reset() {
    writePlaza(cloneDefault());
  },

  /**
   * 重置单个副本到初始状态——只清跟该剧本相关的玩家数据。
   *
   * 清理范围:
   *   - scenarioProgress[scenarioId]              → 删除（完成节点 / settled / 已访场景）
   *   - relationships[npcId] (npcId ∈ scenario)    → 删除（NPC 信任度 / 关键瞬间）
   *   - npcMemories[npcId]   (npcId ∈ scenario)    → 删除（episodic 长期记忆）
   *   - npcSummaries[`${scenarioId}::${npcId}`]    → 删除（G14 对话摘要）
   *
   * 不动:
   *   - inScenario / currentRunLoadout / currentLocation / currentCombatStats
   *     —— 此 API 只在广场调用,玩家不在这个副本里,这些字段对它无意义。
   *
   * 安全检查:
   *   - 如果 inScenario === scenarioId（玩家正在这个副本里）→ 拒绝并打 warn。
   *     UI 层应当在副本内不暴露此入口,这是双保险。
   *
   * @param scenarioId 要重置的副本 ID
   * @param npcIdsInScenario 该副本下所有 NPC 的 character_id 列表
   *                         （调用方从 scenario.npcs.map(n => n.character_id) 取）
   */
  resetScenario(scenarioId: string, npcIdsInScenario: string[]) {
    const s = readPlaza();
    if (s.inScenario === scenarioId) {
      console.warn(
        `[plaza.resetScenario] 拒绝: 玩家正在 "${scenarioId}" 副本中, 请先 exitScenario 再重置`,
      );
      return;
    }
    const npcSet = new Set(npcIdsInScenario);
    // scenarioProgress: 删除该副本 key
    const { [scenarioId]: _drop, ...remainingProgress } = s.scenarioProgress;
    // relationships / npcMemories: 过滤掉属于该副本的 NPC keys
    const filteredRelations: Record<string, NpcRelationship> = {};
    for (const [k, v] of Object.entries(s.relationships)) {
      if (!npcSet.has(k)) filteredRelations[k] = v;
    }
    const filteredMemories: Record<string, NpcEpisodicMemory[]> = {};
    for (const [k, v] of Object.entries(s.npcMemories)) {
      if (!npcSet.has(k)) filteredMemories[k] = v;
    }
    // npcSummaries: key 形如 `${scenarioId}::${npcId}`,删除前缀匹配的
    const summaryPrefix = `${scenarioId}::`;
    const filteredSummaries: Record<string, NpcSummary> = {};
    for (const [k, v] of Object.entries(s.npcSummaries)) {
      if (!k.startsWith(summaryPrefix)) filteredSummaries[k] = v;
    }
    // 世界控制三件套:全部按 scenarioId 切片,直接删除该 key
    const { [scenarioId]: _v1, ...remainingVisits } = s.locationVisitCount;
    const { [scenarioId]: _v2, ...remainingSceneState } = s.sceneStateOverrides;
    const { [scenarioId]: _v3, ...remainingArtifacts } = s.discoveredArtifacts;
    // 运行时扩展:spawnedLocations + sessionSpawnCount 同样按 scenarioId 切片清理
    const { [scenarioId]: _v4, ...remainingSpawned } = s.spawnedLocations;
    const { [scenarioId]: _v5, ...remainingSpawnCount } = s.sessionSpawnCount;
    writePlaza({
      ...s,
      scenarioProgress: remainingProgress,
      relationships: filteredRelations,
      npcMemories: filteredMemories,
      npcSummaries: filteredSummaries,
      locationVisitCount: remainingVisits,
      sceneStateOverrides: remainingSceneState,
      discoveredArtifacts: remainingArtifacts,
      spawnedLocations: remainingSpawned,
      sessionSpawnCount: remainingSpawnCount,
    });
  },

  // ── 原力 ─────────────────────────────────────────────────
  addForce(delta: number) {
    const s = readPlaza();
    writePlaza({ ...s, force: Math.max(0, s.force + delta) });
  },
  spendForce(amount: number): boolean {
    const s = readPlaza();
    if (s.force < amount) return false;
    writePlaza({ ...s, force: s.force - amount });
    return true;
  },

  // ── 主角档案 ──────────────────────────────────────────────
  updatePlayerProfile(patch: Partial<CharacterProfile>) {
    const s = readPlaza();
    writePlaza({ ...s, player: { ...s.player, ...patch } });
  },

  // ── I-series:用户真人身份(全局)─────────────────────────
  getUserProfile(): UserProfile {
    return readPlaza().userProfile;
  },
  /** 提交 onboarding 表单 / 后续修改昵称等。默认 filled=true。 */
  setUserProfile(patch: Partial<UserProfile>) {
    const s = readPlaza();
    const next: UserProfile = { ...s.userProfile, ...patch };
    // 关键:任何 patch(不带 filled=false 的)都视为"用户主动填过" → filled=true
    if (typeof patch.filled !== 'boolean') next.filled = true;
    writePlaza({ ...s, userProfile: next });
  },

  // ── 队友 ──────────────────────────────────────────────────
  toggleCompanionActive(characterId: string) {
    const s = readPlaza();
    writePlaza({
      ...s,
      companions: s.companions.map((c) =>
        c.characterId === characterId ? { ...c, active: !c.active } : c,
      ),
    });
  },
  upgradeCompanion(characterId: string): UpgradeResult {
    const s = readPlaza();
    const c = s.companions.find((x) => x.characterId === characterId);
    if (!c) return { ok: false, reason: '队友不存在' };
    const cost = companionUpgradeCost(c);
    if (s.force < cost) return { ok: false, reason: `原力不足(需 ${cost})` };
    const newLevel = c.level + 1;
    writePlaza({
      ...s,
      force: s.force - cost,
      companions: s.companions.map((x) =>
        x.characterId === characterId ? { ...x, level: newLevel } : x,
      ),
    });
    return { ok: true, newLevel };
  },
  updateCompanionProfile(characterId: string, patch: Partial<CharacterProfile>) {
    const s = readPlaza();
    writePlaza({
      ...s,
      companions: s.companions.map((c) =>
        c.characterId === characterId ? { ...c, profile: { ...c.profile, ...patch } } : c,
      ),
    });
  },
  removeCompanion(characterId: string) {
    const s = readPlaza();
    writePlaza({ ...s, companions: s.companions.filter((c) => c.characterId !== characterId) });
  },

  // ── 物品 ──────────────────────────────────────────────────
  upgradeItem(itemId: string): UpgradeResult {
    const s = readPlaza();
    const item = s.inventory.find((x) => x.id === itemId);
    if (!item) return { ok: false, reason: '物品不存在' };
    const cost = itemUpgradeCost(item);
    if (s.force < cost) return { ok: false, reason: `原力不足(需 ${cost})` };
    const newLevel = item.level + 1;
    writePlaza({
      ...s,
      force: s.force - cost,
      inventory: s.inventory.map((x) => (x.id === itemId ? { ...x, level: newLevel } : x)),
    });
    return { ok: true, newLevel };
  },
  removeItem(itemId: string) {
    const s = readPlaza();
    writePlaza({ ...s, inventory: s.inventory.filter((i) => i.id !== itemId) });
  },

  // ── 剧本进出 ─────────────────────────────────────────────

  /**
   * 进入剧本。
   *
   * @param loadout 携带的队友 / 物品 id 列表。
   *   - 不传 = 兜底:带所有「活着的 active 队友 + 未丢失的物品」(向后兼容)
   *   - 传了:精确控制。invalid id (不存在 / 已死 / 已丢失)会被静默丢掉
   */
  enterScenario(
    scenarioId: string,
    cost: number,
    startSceneId?: string,
    loadout?: { companionIds: string[]; itemIds: string[] },
    /**
     * P4 World Tick:初始世界时钟。由 caller 通过 getInitialClock(scenario) 算好传入。
     *   - 新 progress 写入此值
     *   - 既有 progress(re-entry)→ 保留旧 clock,忽略此参数(支持"离开时 day 3 hour 14,回来还在 day 3 hour 14")
     *   - 不启用 P4 的剧本不传即可(undefined),progress.worldClock 留空
     */
    initialClock?: WorldClock,
  ): EnterScenarioResult {
    const s = readPlaza();
    if (s.inScenario) {
      return { ok: false, reason: `当前已在剧本 ${s.inScenario} 中,需先返回广场` };
    }
    // 已结算的剧本 → entryCost 强制为 0(免费再访,鼓励"回剧本陷 NPC")。
    // 调用方传任意值都无所谓,这里覆盖。
    const existingProgress = s.scenarioProgress[scenarioId];
    const effectiveCost = existingProgress?.settled ? 0 : cost;
    if (s.force < effectiveCost) {
      return { ok: false, reason: `原力不足(需 ${effectiveCost})` };
    }

    // 解析 loadout:用户传了就用,没传按"全部活着的 active + 未丢失"兜底
    const aliveCompanionIds = new Set(
      s.companions.filter((c) => (c.hp ?? 'alive') === 'alive').map((c) => c.characterId),
    );
    const availableItemIds = new Set(s.inventory.filter((i) => !i.lost).map((i) => i.id));
    let companionIds: string[];
    let itemIds: string[];
    if (loadout) {
      companionIds = loadout.companionIds.filter((id) => aliveCompanionIds.has(id));
      itemIds = loadout.itemIds.filter((id) => availableItemIds.has(id));
    } else {
      // 兜底:active 且活着的队友 + 所有未丢失的物品
      companionIds = s.companions
        .filter((c) => c.active && (c.hp ?? 'alive') === 'alive')
        .map((c) => c.characterId);
      itemIds = s.inventory.filter((i) => !i.lost).map((i) => i.id);
    }
    const runLoadout: RunLoadout = { scenarioId, companionIds, itemIds };

    // 初始化 currentCombatStats:主角满状态 + 每个携带队友按 level 缩放上限
    const combatStats: Record<string, CombatStat> = {
      player: makePlayerCombatStat(),
    };
    for (const cid of companionIds) {
      const c = s.companions.find((x) => x.characterId === cid);
      if (c) combatStats[cid] = makeFullCombatStat(c.level);
    }

    // 初始化或更新进度
    const now = new Date().toISOString();
    const existing = s.scenarioProgress[scenarioId];
    const progress: ScenarioProgress = existing
      ? {
          ...existing,
          // 不重置 completedBeatIds,允许复访剧本时累积进度
          currentSceneId: existing.currentSceneId ?? startSceneId ?? null,
          lastVisitedAt: now,
          // P4:既有 progress 保留旧 worldClock/eventsFired/log;若历史 progress 没这些字段(老存档)
          // 且 caller 传了 initialClock,补一份新的(等同首次启用 P4)。
          worldClock: existing.worldClock ?? initialClock,
          worldEventsFired: existing.worldEventsFired ?? (initialClock ? [] : undefined),
          worldLog: existing.worldLog ?? (initialClock ? [] : undefined),
        }
      : {
          scenarioId,
          currentSceneId: startSceneId ?? null,
          completedBeatIds: [],
          visitedSceneIds: startSceneId ? [startSceneId] : [],
          startedAt: now,
          lastVisitedAt: now,
          // P4 World Tick:新 progress 写入 initialClock(若 caller 传了);否则三字段全 undefined
          worldClock: initialClock,
          worldEventsFired: initialClock ? [] : undefined,
          worldLog: initialClock ? [] : undefined,
        };
    // 关键修复:按 loadout 同步 companion.active —— EntryModal 未勾选的 companion 必须 active=false。
    // 否则 active 残留上次状态(默认 true),banter 路径直接读 c.active 会让未勾选的 companion 仍然插嘴。
    // buildNpcPromptContext 已经按 loadout 过滤 NPC prompt 里的同伴列表,
    // 但 banter (app/page.tsx:1374) 用的是 c.active —— 必须把 active 也同步。
    const carriedSet = new Set(companionIds);
    const syncedCompanions = s.companions.map((c) => ({
      ...c,
      active: carriedSet.has(c.characterId),
    }));

    writePlaza({
      ...s,
      force: s.force - effectiveCost,
      inScenario: scenarioId,
      currentRunLoadout: runLoadout,
      currentCombatStats: combatStats,
      companions: syncedCompanions,
      scenarioProgress: { ...s.scenarioProgress, [scenarioId]: progress },
      // 运行时扩展:进剧本算一个新 session,清零 spawn 配额
      sessionSpawnCount: { ...s.sessionSpawnCount, [scenarioId]: 0 },
    });
    return { ok: true };
  },
  /**
   * 退出剧本。
   * - 第一次拿到 rewardForce > 0 时 progress.settled = true(以后再退出 reward 强制 0)
   * - 已 settled 的剧本即使 rewardForce > 0,也只发 0(防刷)
   * - 中途逃跑(rewardForce = 0)不算 settled,下次还能尝试拿奖励
   *
   * @returns 实际发放的原力数(给 UI 显示 "本次获得 X 原力" / "已结算无奖励")
   */
  exitScenario(rewardForce: number): { rewardGranted: number; settledThisExit: boolean } {
    const s = readPlaza();
    const sid = s.inScenario;
    const progress = sid ? s.scenarioProgress[sid] : undefined;
    const alreadySettled = !!progress?.settled;
    const requested = Math.max(0, rewardForce);
    // 防刷:已 settled → reward 强制 0
    const actualReward = alreadySettled ? 0 : requested;
    // 本次是否触发 settled
    const willSettle = !alreadySettled && requested > 0;
    const now = new Date().toISOString();
    const nextProgress: Record<string, ScenarioProgress> = { ...s.scenarioProgress };
    if (sid && progress && willSettle) {
      nextProgress[sid] = { ...progress, settled: true, firstSettledAt: now };
    }
    writePlaza({
      ...s,
      inScenario: null,
      currentLocation: null, // 出剧本回广场,location 不再有意义
      currentRunLoadout: null,
      currentCombatStats: {}, // 出剧本回满(下次 enterScenario 重新初始化)
      force: s.force + actualReward,
      scenarioProgress: nextProgress,
    });
    return { rewardGranted: actualReward, settledThisExit: willSettle };
  },

  /**
   * 设置玩家当前所在的 location。
   * 调用时机:
   *   - 进剧本时:caller 读 scenario.initialLocation,enterScenario 之后调一次
   *   - 剧本内:WC-EVENT location-changed parser 触发
   *   - 出剧本时不需要调,exitScenario 自动清空
   *
   * 不强制校验 loc 是否在 scenario.locations 里 — 校验责任在 caller(WC-EVENT parser 会做)。
   * 传 null 显式清空。inScenario === null 时静默拒绝(广场不应该有 location)。
   */
  setCurrentLocation(loc: string | null) {
    const s = readPlaza();
    if (!s.inScenario && loc !== null) return; // 广场态不能有 location
    if (s.currentLocation === loc) return; // 无变化,跳过 write
    // 切到新 location 时累计到访次数(loc=null 出剧本不算到访)
    if (loc !== null && s.inScenario) {
      const sid = s.inScenario;
      // 动态 location:visitCount 嵌在自身,不污染 locationVisitCount 表
      const spawned = s.spawnedLocations[sid]?.[loc];
      if (spawned) {
        const updatedSpawned: DynamicLocation = {
          ...spawned,
          visitCount: spawned.visitCount + 1,
        };
        writePlaza({
          ...s,
          currentLocation: loc,
          spawnedLocations: {
            ...s.spawnedLocations,
            [sid]: { ...s.spawnedLocations[sid], [loc]: updatedSpawned },
          },
        });
        return;
      }
      // 预设 location:走 locationVisitCount 表
      const perScenario = s.locationVisitCount[sid] ?? {};
      const newCount = (perScenario[loc] ?? 0) + 1;
      writePlaza({
        ...s,
        currentLocation: loc,
        locationVisitCount: {
          ...s.locationVisitCount,
          [sid]: { ...perScenario, [loc]: newCount },
        },
      });
    } else {
      writePlaza({ ...s, currentLocation: loc });
    }
  },

  // ── P4 World Tick API ───────────────────────────────────

  /**
   * 推进当前剧本的世界时钟,触发落入新窗口的 WorldEvents。
   *
   * 调用方:UI 上的"等候 X 小时 / 睡到天亮"按钮,或 LLM 输出某种"时间流逝"标记后由 page.tsx 调用。
   *
   * 行为:
   *   1. 验证 inScenario === scenario.id(防止"广场态推时间"或剧本张冠李戴)
   *   2. 读 progress.worldClock;若为 undefined → 拒绝(此剧本未启用 P4 / 旧存档)
   *   3. 按 deltaHours 逐 tick 推进,每 tick 查 findFiringWorldEvents
   *   4. 新 fire 的 events 追加到 worldEventsFired + worldLog(各 entry 携带 ts 快照 + summary 缓存)
   *
   * 返回:
   *   - ok: true → 新 clock + 本次 fire 的 events 列表(可能为空)
   *   - ok: false → 拒绝原因(UI 用 toast 展示)
   *
   * 注:仅推进,不触发 narrator lane / NPC 注入 — 那是 caller(page.tsx)的责任,
   * 它拿到 firedEvents 后决定如何展示(参见 WorldEvent.narrate 字段)。
   */
  advanceClock(
    scenario: Scenario,
    deltaHours: number,
  ):
    | { ok: true; clock: WorldClock; firedEvents: WorldEvent[] }
    | { ok: false; reason: string } {
    const s = readPlaza();
    if (s.inScenario !== scenario.id) {
      return {
        ok: false,
        reason: `当前不在剧本 ${scenario.id}(in=${s.inScenario ?? 'plaza'})`,
      };
    }
    const progress = s.scenarioProgress[scenario.id];
    if (!progress) return { ok: false, reason: 'progress 缺失,enterScenario 未跑过' };
    const oldClock = progress.worldClock;
    if (!oldClock) return { ok: false, reason: '此剧本未启用 P4 World Tick(无 worldClock)' };
    const delta = Math.floor(deltaHours);
    if (!Number.isFinite(delta) || delta <= 0) {
      return { ok: false, reason: 'deltaHours 必须为正整数' };
    }
    const alreadyFired = progress.worldEventsFired ?? [];
    const milestones = progress.completedBeatIds ?? [];
    const { clock: newClock, events: firedEvents } = advanceClockWithEvents(
      scenario,
      oldClock,
      delta,
      milestones,
      alreadyFired,
    );
    // 把 fire 的 events 写入 log;ts 用每个 event 的 fire 时刻不易追溯(advanceClockWithEvents 不返回 per-event ts),
    // 这里统一用 newClock(终态)作快照。需要 per-event ts 的话 P4-B 把 advanceClockWithEvents 改造成返回 [{ts, event}][]。
    const newLogEntries: WorldLogEntry[] = firedEvents.map((ev) => ({
      ts: { ...newClock },
      eventId: ev.id,
      summary: ev.short_summary,
    }));
    const updatedProgress: ScenarioProgress = {
      ...progress,
      worldClock: newClock,
      worldEventsFired: [...alreadyFired, ...firedEvents.map((e) => e.id)],
      worldLog: [...(progress.worldLog ?? []), ...newLogEntries],
    };
    writePlaza({
      ...s,
      scenarioProgress: { ...s.scenarioProgress, [scenario.id]: updatedProgress },
    });
    return { ok: true, clock: newClock, firedEvents };
  },

  /**
   * 在不推进 clock 的前提下,查询此刻应该 fire 的 WorldEvents(用于刚 enterScenario / milestone 达成后补 fire)。
   *
   * 比如:enterScenario 后,initialClock 落在某 event 的 when 窗口里 — advanceClock 还没触发那 tick,
   * caller 调一次 fireDueWorldEvents(scenario) 把"开局就该有的"事件抓出来。
   *
   * 同样的:玩家完成一个 milestone(写入 completedBeatIds)后,某 event 的 requires_milestones 终于满足,
   * 而 clock 已经在窗口内 — 调 fireDueWorldEvents 就能立即让它 fire 而无需等下一次 advanceClock。
   *
   * 不动 clock,只动 worldEventsFired + worldLog。
   */
  fireDueWorldEvents(
    scenario: Scenario,
  ):
    | { ok: true; firedEvents: WorldEvent[] }
    | { ok: false; reason: string } {
    const s = readPlaza();
    if (s.inScenario !== scenario.id) {
      return {
        ok: false,
        reason: `当前不在剧本 ${scenario.id}(in=${s.inScenario ?? 'plaza'})`,
      };
    }
    const progress = s.scenarioProgress[scenario.id];
    if (!progress) return { ok: false, reason: 'progress 缺失' };
    const clock = progress.worldClock;
    if (!clock) return { ok: true, firedEvents: [] }; // 未启用 P4 → 无 event 可 fire
    const alreadyFired = progress.worldEventsFired ?? [];
    const milestones = progress.completedBeatIds ?? [];
    const firedEvents = findFiringWorldEvents(scenario, clock, milestones, alreadyFired);
    if (firedEvents.length === 0) return { ok: true, firedEvents: [] };
    const newLogEntries: WorldLogEntry[] = firedEvents.map((ev) => ({
      ts: { ...clock },
      eventId: ev.id,
      summary: ev.short_summary,
    }));
    const updatedProgress: ScenarioProgress = {
      ...progress,
      worldEventsFired: [...alreadyFired, ...firedEvents.map((e) => e.id)],
      worldLog: [...(progress.worldLog ?? []), ...newLogEntries],
    };
    writePlaza({
      ...s,
      scenarioProgress: { ...s.scenarioProgress, [scenario.id]: updatedProgress },
    });
    return { ok: true, firedEvents };
  },

  // ── 世界控制三件套 API ───────────────────────────────────

  /** 读某 location 在指定剧本的累计到访次数。setCurrentLocation 已经自增,此 API 仅查询。 */
  getLocationVisits(scenarioId: string, locationId: string): number {
    return readPlaza().locationVisitCount[scenarioId]?.[locationId] ?? 0;
  },

  /**
   * 写入 location 的环境状态覆盖(单个 key)。
   * 由 WC-EVENT scene-state-changed parser 触发。
   * key 必须 kebab/snake-case,value 必须 string;不合规静默忽略。
   * 跟 ScenarioLocation.sceneState(初始静态)合并使用,overrides 优先。
   */
  setSceneStateOverride(scenarioId: string, locationId: string, key: string, value: string) {
    if (!/^[a-z0-9_-]+$/.test(key)) return;
    if (!/^[a-z0-9-]+$/.test(locationId)) return;
    const s = readPlaza();
    const perScenario = s.sceneStateOverrides[scenarioId] ?? {};
    const perLoc = perScenario[locationId] ?? {};
    writePlaza({
      ...s,
      sceneStateOverrides: {
        ...s.sceneStateOverrides,
        [scenarioId]: { ...perScenario, [locationId]: { ...perLoc, [key]: value } },
      },
    });
  },

  /**
   * 读某 location 的覆盖 KV(不包含 ScenarioLocation.sceneState 初始值)。
   * 调用方(prompt-segments)负责合并:effective = {...scenario.sceneState, ...overrides}。
   */
  getSceneStateOverrides(scenarioId: string, locationId: string): Record<string, string> {
    return readPlaza().sceneStateOverrides[scenarioId]?.[locationId] ?? {};
  },

  /**
   * 标记某 artifact 已被玩家发现。idempotent,已发现的返 false。
   * 由 WC-EVENT artifact-discovered parser 触发。
   */
  discoverArtifact(scenarioId: string, artifactId: string): boolean {
    if (!/^[a-z0-9-]+$/.test(artifactId)) return false;
    const s = readPlaza();
    const cur = s.discoveredArtifacts[scenarioId] ?? [];
    if (cur.includes(artifactId)) return false;
    writePlaza({
      ...s,
      discoveredArtifacts: {
        ...s.discoveredArtifacts,
        [scenarioId]: [...cur, artifactId],
      },
    });
    return true;
  },

  /** 查询单个 artifact 是否已发现。 */
  isArtifactDiscovered(scenarioId: string, artifactId: string): boolean {
    return readPlaza().discoveredArtifacts[scenarioId]?.includes(artifactId) ?? false;
  },

  /** 列剧本中所有已发现的 artifact ids(顺序按发现先后)。 */
  listDiscoveredArtifacts(scenarioId: string): string[] {
    return [...(readPlaza().discoveredArtifacts[scenarioId] ?? [])];
  },

  // ── 运行时扩展(动态 location)API ─────────────────────────

  /** 读全局玩家偏好。组件用此判定是否要显示扩展提示 / spawn 是否被允许。 */
  getPlayerSettings(): PlayerSettings {
    return readPlaza().playerSettings;
  },

  /**
   * 设置"是否允许 LLM 即兴扩展新场所"。SettingsTab toggle 调。
   * 关掉时已物化的 spawnedLocations 不删 — 玩家依然可以访问已生成的;
   * 只是 prompt 不再注入 spawn 引导,LLM 不会再生新的。
   */
  setAllowRuntimeExpansion(allow: boolean) {
    const s = readPlaza();
    if (s.playerSettings.allowRuntimeExpansion === allow) return;
    writePlaza({
      ...s,
      playerSettings: { ...s.playerSettings, allowRuntimeExpansion: allow },
    });
  },

  /**
   * 由 WC-EVENT location-spawned parser 调用,把 LLM 即兴生成的地点物化。
   *
   * 校验责任:
   *   - parser 已校验 marker 格式(id 合法 / parent 存在)
   *   - 本 API 再做一次 hard check(双保险):必须在 scenarioId 副本中 + 玩家允许扩展 + id 不冲突
   *   - 配额 cap 由 caller 在调用前用 getSessionSpawnCount 判定(本 API 只做计数)
   *
   * 返回:成功 → 物化后的 DynamicLocation;失败 → null + console.warn
   */
  spawnDynamicLocation(
    scenarioId: string,
    data: {
      id: string;
      name: string;
      description: string;
      parent: string;
      generatedFromBeat?: string;
    },
  ): DynamicLocation | null {
    const s = readPlaza();
    if (s.inScenario !== scenarioId) {
      console.warn(
        `[plaza.spawnDynamicLocation] 拒绝: 玩家不在 "${scenarioId}" 副本中(in="${s.inScenario}")`,
      );
      return null;
    }
    if (!s.playerSettings.allowRuntimeExpansion) {
      console.warn(
        `[plaza.spawnDynamicLocation] 拒绝: playerSettings.allowRuntimeExpansion=false`,
      );
      return null;
    }
    const existing = s.spawnedLocations[scenarioId]?.[data.id];
    if (existing) {
      console.warn(`[plaza.spawnDynamicLocation] 拒绝: id "${data.id}" 已存在`);
      return null;
    }
    const loc: DynamicLocation = {
      id: data.id,
      name: data.name,
      description: data.description,
      connections: [data.parent], // 默认只与 parent 单向相连;LLM 后续可串链
      sceneState: {},
      artifacts: [],
      isDynamic: true,
      parent: data.parent,
      generatedAt: Date.now(),
      visitCount: 0,
    };
    const prevPerScenario = s.spawnedLocations[scenarioId] ?? {};
    const prevCount = s.sessionSpawnCount[scenarioId] ?? 0;
    writePlaza({
      ...s,
      spawnedLocations: {
        ...s.spawnedLocations,
        [scenarioId]: { ...prevPerScenario, [data.id]: loc },
      },
      sessionSpawnCount: {
        ...s.sessionSpawnCount,
        [scenarioId]: prevCount + 1,
      },
    });
    return loc;
  },

  /** 读单个 spawned location(找不到 → undefined)。 */
  getSpawnedLocation(scenarioId: string, locationId: string): DynamicLocation | undefined {
    return readPlaza().spawnedLocations[scenarioId]?.[locationId];
  },

  /** 列出某剧本所有 spawned locations(顺序不保证,空数组也返回)。 */
  listSpawnedLocations(scenarioId: string): DynamicLocation[] {
    return Object.values(readPlaza().spawnedLocations[scenarioId] ?? {});
  },

  /** 读当前 session 累计 spawn 次数(用于 cap 判定)。 */
  getSessionSpawnCount(scenarioId: string): number {
    return readPlaza().sessionSpawnCount[scenarioId] ?? 0;
  },

  /** 该剧本是否已结算(用于 UI 显示「已通关 · 再访免费」徽章)。 */
  isScenarioSettled(scenarioId: string): boolean {
    return !!readPlaza().scenarioProgress[scenarioId]?.settled;
  },

  /**
   * 用于剧本内 LLM WC-STAT 标记触发数值变化。
   *   - subject = 'player' / companion-id;不在 currentCombatStats 里的 subject 静默忽略
   *   - hp / stamina / willpower 任一缺省视为 0(数值会自动 clamp 到 [0, max])
   *   - conditionsAdd / conditionsRemove 用 kebab-case 标签 array,自动去重 + 大小写归一
   * 返回 true = 实际更新了状态,false = subject 不存在(white list 拒)
   */
  applyCombatDelta(
    subject: string,
    delta: {
      hp?: number;
      stamina?: number;
      willpower?: number;
      conditionsAdd?: string[];
      conditionsRemove?: string[];
    },
  ): boolean {
    const s = readPlaza();
    const cur = s.currentCombatStats[subject];
    if (!cur) return false;
    const next = applyDeltaToStat(cur, delta);
    writePlaza({
      ...s,
      currentCombatStats: { ...s.currentCombatStats, [subject]: next },
    });
    return true;
  },

  // ── 剧本内事件:LLM WC-EVENT 标记触发 ────────────────────

  /**
   * 标记队友在当前剧本里阵亡。idempotent — 已经死的不会被再次标记。
   * 只能命中 currentRunLoadout 里的 companion(白名单);不在列表里的 id 静默忽略。
   * 返回是否真的修改了状态(false = 不在 loadout / 已死 / id 不存在)。
   */
  markCompanionDead(characterId: string): boolean {
    const s = readPlaza();
    if (!s.currentRunLoadout) return false;
    if (!s.currentRunLoadout.companionIds.includes(characterId)) return false;
    const c = s.companions.find((x) => x.characterId === characterId);
    if (!c) return false;
    if ((c.hp ?? 'alive') === 'dead') return false; // 已经死了
    writePlaza({
      ...s,
      companions: s.companions.map((x) =>
        x.characterId === characterId
          ? { ...x, hp: 'dead', diedInScenarioId: s.inScenario ?? undefined }
          : x,
      ),
    });
    return true;
  },

  /**
   * 标记物品在当前剧本里损毁/掉落。idempotent。
   * 同样只对 currentRunLoadout 里的物品生效。
   */
  markItemLost(itemId: string): boolean {
    const s = readPlaza();
    if (!s.currentRunLoadout) return false;
    if (!s.currentRunLoadout.itemIds.includes(itemId)) return false;
    const i = s.inventory.find((x) => x.id === itemId);
    if (!i) return false;
    if (i.lost) return false;
    writePlaza({
      ...s,
      inventory: s.inventory.map((x) =>
        x.id === itemId
          ? { ...x, lost: true, lostInScenarioId: s.inScenario ?? undefined }
          : x,
      ),
    });
    return true;
  },

  /**
   * 在广场用原力复活队友。
   * cost = 50 × level。返回 { ok, cost } 或失败原因。
   */
  reviveCompanion(characterId: string): { ok: true; cost: number } | { ok: false; reason: string } {
    const s = readPlaza();
    if (s.inScenario) return { ok: false, reason: '需在广场才能复活队友' };
    const c = s.companions.find((x) => x.characterId === characterId);
    if (!c) return { ok: false, reason: '队友不存在' };
    if ((c.hp ?? 'alive') !== 'dead') return { ok: false, reason: '该队友未阵亡,无需复活' };
    const cost = companionReviveCost(c);
    if (s.force < cost) return { ok: false, reason: `原力不足(需 ${cost})` };
    writePlaza({
      ...s,
      force: s.force - cost,
      companions: s.companions.map((x) =>
        x.characterId === characterId ? { ...x, hp: 'alive', diedInScenarioId: undefined } : x,
      ),
    });
    return { ok: true, cost };
  },

  // ── 剧情进度 ─────────────────────────────────────────────

  /** 读单个剧本的进度(若无则返回 null,enterScenario 会自动建)。 */
  getScenarioProgress(scenarioId: string): ScenarioProgress | null {
    return readPlaza().scenarioProgress[scenarioId] ?? null;
  },

  /**
   * I-series:写入"入境身份选择 + 愿望"。EntryModal 提交时调,enterScenario 之后立刻调用。
   * 注意:enterScenario 已经建立了 ScenarioProgress 记录,这里只做 patch;若 progress 缺失会静默返回。
   * bodyEntryContext 在身体进入时由 LLM 生成(可后置 — 见 M4 调用流程)。
   */
  setScenarioEntry(
    scenarioId: string,
    entry: {
      entryMode: EntryMode;
      wishes: string[];
      wishesGranted: number[];
      bodyEntryContext?: string;
    },
  ) {
    const s = readPlaza();
    const p = s.scenarioProgress[scenarioId];
    if (!p) return;
    writePlaza({
      ...s,
      scenarioProgress: {
        ...s.scenarioProgress,
        [scenarioId]: {
          ...p,
          entryMode: entry.entryMode,
          wishes: entry.wishes,
          wishesGranted: entry.wishesGranted,
          // 显式区分 undefined 与空串:undefined 时不覆盖现有值(M4 LLM 后置写入用)
          bodyEntryContext: entry.bodyEntryContext ?? p.bodyEntryContext,
        },
      },
    });
  },

  /** M4:LLM 生成完"穿越背景"后单独 patch。不动 entryMode/wishes。 */
  setBodyEntryContext(scenarioId: string, bodyEntryContext: string) {
    const s = readPlaza();
    const p = s.scenarioProgress[scenarioId];
    if (!p) return;
    writePlaza({
      ...s,
      scenarioProgress: {
        ...s.scenarioProgress,
        [scenarioId]: { ...p, bodyEntryContext },
      },
    });
  },

  /**
   * 切到一个新 scene。Director 推进或玩家选择时调。
   * 自动加入 visitedSceneIds(去重)。
   */
  setCurrentScene(scenarioId: string, sceneId: string) {
    const s = readPlaza();
    const p = s.scenarioProgress[scenarioId];
    if (!p) return;
    const visited = p.visitedSceneIds.includes(sceneId)
      ? p.visitedSceneIds
      : [...p.visitedSceneIds, sceneId];
    writePlaza({
      ...s,
      scenarioProgress: {
        ...s.scenarioProgress,
        [scenarioId]: { ...p, currentSceneId: sceneId, visitedSceneIds: visited, lastVisitedAt: new Date().toISOString() },
      },
    });
  },

  /**
   * 标记一组 beat 已触发(Director 输出 triggeredBeatIds 时调)。
   * 自动去重,返回真正"新增"的 beat ids(用于 UI 弹窗提示)。
   */
  triggerBeats(scenarioId: string, beatIds: string[]): string[] {
    const s = readPlaza();
    const p = s.scenarioProgress[scenarioId];
    if (!p || beatIds.length === 0) return [];
    const existing = new Set(p.completedBeatIds);
    const newOnes = beatIds.filter((id) => !existing.has(id));
    if (newOnes.length === 0) return [];
    writePlaza({
      ...s,
      scenarioProgress: {
        ...s.scenarioProgress,
        [scenarioId]: {
          ...p,
          completedBeatIds: [...p.completedBeatIds, ...newOnes],
          lastVisitedAt: new Date().toISOString(),
        },
      },
    });
    return newOnes;
  },

  // ── 关系网 ──────────────────────────────────────────────

  /** 取当前玩家跟 NPC 的关系(没有则返回 trust=0 的默认值)。 */
  getRelationship(npcId: string, scenarioId: string): NpcRelationship {
    const s = readPlaza();
    return (
      s.relationships[npcId] ?? {
        npcId,
        scenarioId,
        trust: 0,
        key_moments: [],
      }
    );
  },

  /**
   * Director 评出 trust delta + key moment 时调。
   * trust 钳到 [-100, 100]。
   */
  adjustRelationship(npcId: string, scenarioId: string, delta: number, keyMoment?: string) {
    const s = readPlaza();
    const cur = s.relationships[npcId] ?? { npcId, scenarioId, trust: 0, key_moments: [] };
    const newTrust = Math.max(-100, Math.min(100, cur.trust + delta));
    const newMoments = keyMoment ? [...cur.key_moments, keyMoment].slice(-10) : cur.key_moments;
    writePlaza({
      ...s,
      relationships: {
        ...s.relationships,
        [npcId]: { ...cur, scenarioId, trust: newTrust, key_moments: newMoments },
      },
    });
  },

  // ── 立绘偏好 ─────────────────────────────────────────────

  getPortraitPrefs(): PortraitPrefs {
    return readPlaza().portraitPrefs;
  },

  /** 整体替换 portraitPrefs(三档全局开关切换用)。 */
  setPortraitPrefs(patch: Partial<PortraitPrefs>) {
    const s = readPlaza();
    writePlaza({ ...s, portraitPrefs: { ...s.portraitPrefs, ...patch } });
  },

  /** per-character override:'on' / 'off' / 删除(回归 mode 默认行为) */
  setCharacterEmotionPolicy(characterId: string, policy: 'on' | 'off' | 'reset') {
    const s = readPlaza();
    const per = { ...s.portraitPrefs.perCharacter };
    if (policy === 'reset') {
      delete per[characterId];
    } else {
      per[characterId] = policy;
    }
    writePlaza({ ...s, portraitPrefs: { ...s.portraitPrefs, perCharacter: per } });
  },

  // ── NPC 对话摘要(G14)───────────────────────────────────

  /** 读某 NPC 在某剧本的对话摘要(若无返 null)。 */
  getNpcSummary(npcId: string, scenarioId: string): NpcSummary | null {
    const s = readPlaza();
    return s.npcSummaries[`${scenarioId}::${npcId}`] ?? null;
  },

  /** 写/覆盖某 NPC 在某剧本的对话摘要(压缩时调)。 */
  setNpcSummary(npcId: string, scenarioId: string, text: string) {
    if (!text.trim()) return;
    const s = readPlaza();
    writePlaza({
      ...s,
      npcSummaries: {
        ...s.npcSummaries,
        [`${scenarioId}::${npcId}`]: {
          scenarioId,
          text: text.trim(),
          ts: new Date().toISOString(),
        },
      },
    });
  },

  // ── NPC 记忆 ─────────────────────────────────────────────

  /** 列某 NPC 在某剧本的记忆(默认按时间顺序)。 */
  listNpcMemories(npcId: string, scenarioId?: string): NpcEpisodicMemory[] {
    const list = readPlaza().npcMemories[npcId] ?? [];
    if (!scenarioId) return list;
    return list.filter((m) => m.scenarioId === scenarioId);
  },

  /**
   * 追加一批 NPC 记忆(返广场时记忆固化会用)。
   * 超出 max 条按 real_timestamp 旧的丢掉。max 默认 30(向后兼容)— 调用方建议
   * 传入 tier 对应的上限(core=40 / side=20 / passing=10,见 character-tiers.ts)。
   */
  appendNpcMemories(
    npcId: string,
    memories: Omit<NpcEpisodicMemory, 'npcId' | 'real_timestamp'>[],
    max: number = 30,
  ) {
    if (memories.length === 0) return;
    const s = readPlaza();
    const now = new Date().toISOString();
    const list = s.npcMemories[npcId] ?? [];
    const withMeta: NpcEpisodicMemory[] = memories.map((m) => ({
      ...m,
      npcId,
      real_timestamp: now,
    }));
    const combined = [...list, ...withMeta].slice(-Math.max(1, max));
    writePlaza({
      ...s,
      npcMemories: { ...s.npcMemories, [npcId]: combined },
    });
  },
};

/**
 * A1+A2+A3 一次取齐:NPC system prompt 所需的完整 plaza 上下文。
 * 返广场后 plaza state 会更新,下次进剧本调用此函数会读到新进度/新记忆/新关系。
 */
export interface NpcPromptContext {
  scenarioId: string;
  currentSceneId: string | null;
  /** 动态剧本:玩家当前所在 location id(对应 scenario.locations[].id);null = 不启用或未设。 */
  currentLocation: string | null;
  activeCompanions: CompanionEntry[];
  inventory: Item[];
  relationship?: NpcRelationship;
  memories: NpcEpisodicMemory[];
  /** G14:跨 session 持久化的对话摘要(messages-compress 写入) */
  summary?: NpcSummary;
  // ─── I-series:玩家身份 + 愿望(NPC prompt 注入用)──────────────
  userProfile: UserProfile;
  entryMode?: EntryMode;
  wishes?: string[];
  wishesGranted?: number[];
  bodyEntryContext?: string;
  // ─── 世界控制三件套(prompt-segments 注入用)──────────────
  /** 当前 location 的环境状态覆盖(仅 plaza 一侧;调用方合并 scenario.sceneState 初始值);非剧本态为 {} */
  currentSceneStateOverrides: Record<string, string>;
  /** 当前剧本已发现的 artifact id 集合(prompt 把这些从"可调查"列表中扣掉) */
  discoveredArtifactIds: string[];
  /** 玩家在当前 location 的累计到访次数(0 = 不在 location 或没到访过) */
  currentLocationVisitCount: number;
  /** 当前剧本已完成的 beat ids(artifact.requiresCompletedBeats 判定 + beat.trigger.completedBeats 判定) */
  completedBeatIds: string[];
}

export function buildNpcPromptContext(npcId: string, scenarioId: string): NpcPromptContext {
  const s = readPlaza();
  const progress = s.scenarioProgress[scenarioId];

  // 队友 / 物品过滤优先级:
  //   1. 同剧本的 currentRunLoadout 存在 → 精确按携带快照过滤(死的队友/丢的物品自然不在 loadout 里)
  //   2. 无 loadout(广场态 / 旧存档) → 退回老语义:active 且活着的 + 未丢失的
  let activeCompanions: CompanionEntry[];
  let inventory: Item[];
  if (s.currentRunLoadout && s.currentRunLoadout.scenarioId === scenarioId) {
    const cIds = new Set(s.currentRunLoadout.companionIds);
    const iIds = new Set(s.currentRunLoadout.itemIds);
    activeCompanions = s.companions.filter(
      (c) => cIds.has(c.characterId) && (c.hp ?? 'alive') === 'alive',
    );
    inventory = s.inventory.filter((i) => iIds.has(i.id) && !i.lost);
  } else {
    activeCompanions = s.companions.filter((c) => c.active && (c.hp ?? 'alive') === 'alive');
    inventory = s.inventory.filter((i) => !i.lost);
  }

  // 世界控制三件套上下文(仅在 inScenario === scenarioId 时有意义)
  const inThisScenario = s.inScenario === scenarioId;
  const currentLocation = inThisScenario ? s.currentLocation : null;
  const currentSceneStateOverrides: Record<string, string> =
    inThisScenario && currentLocation
      ? s.sceneStateOverrides[scenarioId]?.[currentLocation] ?? {}
      : {};
  const discoveredArtifactIds = inThisScenario ? s.discoveredArtifacts[scenarioId] ?? [] : [];
  const currentLocationVisitCount =
    inThisScenario && currentLocation
      ? s.locationVisitCount[scenarioId]?.[currentLocation] ?? 0
      : 0;

  return {
    scenarioId,
    currentSceneId: progress?.currentSceneId ?? null,
    currentLocation,
    activeCompanions,
    inventory,
    relationship: s.relationships[npcId],
    memories: (s.npcMemories[npcId] ?? []).filter((m) => m.scenarioId === scenarioId),
    summary: s.npcSummaries[`${scenarioId}::${npcId}`],
    userProfile: s.userProfile,
    entryMode: progress?.entryMode,
    wishes: progress?.wishes,
    wishesGranted: progress?.wishesGranted,
    bodyEntryContext: progress?.bodyEntryContext,
    currentSceneStateOverrides,
    discoveredArtifactIds,
    currentLocationVisitCount,
    completedBeatIds: progress?.completedBeatIds ?? [],
  };
}

export { DEFAULT_PLAZA };

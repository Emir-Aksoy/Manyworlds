/**
 * LLM 输出事件解析 (WC-EVENT)
 * ============================
 *
 * 让 NPC / Director 在剧情中产生「队友阵亡 / 物品损毁 / 玩家移动 / 达成里程碑」之类的
 * 世界状态变更。
 *
 * LLM 输出格式约定(详见 NPC system prompt 里的提示):
 *
 *   <!-- WC-EVENT companion-died characterId=warhammer40k-npc-vorel -->
 *   <!-- WC-EVENT item-lost itemId=item-cosmic-charm -->
 *   <!-- WC-EVENT location-changed value=changan reason="跟随商队北上" -->
 *   <!-- WC-EVENT milestone-reached id=obtained-changsheng-jue reason="找到长生诀残卷" -->
 *
 * 选 HTML 注释做载体的理由:
 *   - 用户在聊天 UI 里看不见(渲染 markdown 时注释被剥)
 *   - LLM 生成不破坏正常对话流(注释插哪都行)
 *   - 解析简单(单行正则,无嵌套)
 *
 * 安全性:
 *   - 由 parseWcEvents 返回的事件**未经白名单校验**。调用方必须在
 *     plaza.markCompanionDead / markItemLost 这一层用 currentRunLoadout
 *     白名单过滤,避免 LLM 写错 id 或越权杀掉广场上没带进来的队友。
 *   - location-changed 在有 locations 白名单的剧本里必须命中预设或已 spawn 地点;
 *     即兴造新地点只能先走 location-spawned,通过双开关和配额后再切过去。
 *   - milestone-reached 通过 plaza.triggerBeats 去重,重复触发同一 id 不会双倍计入完成度。
 *   - parser 限定每条消息最多 16 个事件,防 LLM 失控刷屏。
 */

export type WcEventKind =
  | 'companion-died'
  | 'item-lost'
  | 'location-changed'
  | 'milestone-reached'
  | 'artifact-discovered';

/**
 * WC-STAT 数值变化事件。LLM 在战斗 / 心理战 / 受伤 / 恢复时输出。
 * subject:
 *   - "player" = 主角
 *   - "<companion characterId>" = 该队友(必须在 currentRunLoadout 里)
 *   - 不能用于敌方 NPC(敌方数值由 LLM 自己脑内 track,不持久化)
 */
export interface WcStatEvent {
  subject: string;
  hp?: number;
  stamina?: number;
  willpower?: number;
  /**
   * 要追加的 condition 标签(持续负面状态,kebab-case)。
   * LLM 用 `conditions+=broken-left-arm,soul-tainted` 语法,多标签逗号分隔。
   */
  conditionsAdd?: string[];
  /** 要移除的 condition 标签;LLM 用 `conditions-=xxx` 语法。 */
  conditionsRemove?: string[];
  reason?: string;
  start: number;
  end: number;
}

export interface WcEvent {
  kind: WcEventKind;
  /**
   * companion-died → characterId;item-lost → itemId;
   * location-changed → location id;milestone-reached → milestone id
   */
  id: string;
  /** 可选附注(reason="..." 之类),不强制 */
  reason?: string;
  /** 在源文本里的字符区间,便于剥离 */
  start: number;
  end: number;
}

/**
 * WC-TRUST:NPC 自评跟玩家的关系变化。
 * NPC 在回复末尾输出 `<!-- WC-TRUST delta=+4 reason="..." -->`,引擎读取后调
 * plaza.adjustRelationship(currentNpcId, scenarioId, delta, reason)。
 *
 * 设计:
 *   - 不带 subject —— caller 用当前对话的 NPC id(自评)
 *   - delta clamp 到 ±TRUST_DELTA_MAX = ±10(防爆数);archetype 在 prompt 层指导 LLM 自调典型幅度(±1~±7 不等)
 *   - reason 必填(作为 key_moments 留痕)
 *   - 一轮 NPC 回复允许多个 WC-TRUST,parser 合并 delta 累加 + reason 拼接(见 parseWcTrustEvents)
 */
export interface WcTrustEvent {
  delta: number;
  reason: string;
  start: number;
  end: number;
}

export interface ApplyWcEventsOptions {
  /**
   * companion-died / item-lost 属于不可逆事件。默认拒绝,UI 可在人工确认后显式打开。
   */
  allowDestructiveEvents?: boolean;
}

// HTML 注释格式: <!-- WC-EVENT <kind> <key>=<value> [reason="..."] -->
//   - 容忍多空白
//   - 每种 kind 对应一个 key 名(防止 LLM 用错 key 误标记):
//       companion-died    ↔ characterId
//       item-lost         ↔ itemId
//       location-changed  ↔ value
//       milestone-reached ↔ id
//   - value 字符集: [a-zA-Z0-9_-];A3 放宽:允许可选双/单引号包裹("xxx" / 'xxx' / xxx 都接受)
//   - reason 允许带引号(到下一个引号结束)
const WC_EVENT_RE =
  /<!--\s*WC-EVENT\s+(companion-died|item-lost|location-changed|milestone-reached|artifact-discovered)\s+(characterId|itemId|value|id)\s*=\s*["']?([a-zA-Z0-9_-]+)["']?(?:\s+reason\s*=\s*"([^"]*)")?\s*-->/g;

/** 每种 kind 对应的合法 key 名。parser 用来校验配对正确。 */
const WC_EVENT_KIND_KEY: Record<WcEventKind, string> = {
  'companion-died': 'characterId',
  'item-lost': 'itemId',
  'location-changed': 'value',
  'milestone-reached': 'id',
  'artifact-discovered': 'value',
};

// ─── WC-EVENT scene-state-changed(独立事件,3 个键)──────────────
//
// 因为 scene-state-changed 有 3 个键(location/key/value)而非通用的 1 个,
// 不复用 WC_EVENT_RE,单独 regex + parse 函数。kind 不进 WcEventKind 联合。
// 格式: <!-- WC-EVENT scene-state-changed location=<locId> key=<key> value="<新状态>" reason="一句话" -->
//   - value 必须双引号包裹(允许中文/空格/标点)
//   - location id 必须 kebab-case;key 必须 kebab/snake-case
const WC_SCENE_STATE_RE =
  /<!--\s*WC-EVENT\s+scene-state-changed\s+location\s*=\s*["']?([a-z0-9-]+)["']?\s+key\s*=\s*["']?([a-z0-9_-]+)["']?\s+value\s*=\s*"([^"]+)"(?:\s+reason\s*=\s*"([^"]*)")?\s*-->/g;

// ─── WC-EVENT location-spawned(独立事件,5 个键,运行时扩展专用)──────
//
// 跟通用 WC_EVENT_RE 不兼容(5 个 attrs),也跟 scene-state-changed 不同(attr 顺序灵活)。
// 解析策略:先抓整段 attr 串,再用 ATTR_RE 解析每个键值对(允许顺序乱、可选 reason)。
// 格式:<!-- WC-EVENT location-spawned id="..." name="..." parent="..." description="..." reason="..." -->
//   - id 必须 [a-z0-9.-]+,引号必填(LLM 约定写 `<scenarioId>.dyn-<kebab>` 格式)
//   - name 中文显示名,双引号
//   - parent 必须 [a-z0-9.-]+,引号必填(指向已存在的预设或动态 location)
//   - description 一句话场景描述,双引号
//   - reason 可选,debug 用
const WC_LOCATION_SPAWNED_RE = /<!--\s*WC-EVENT\s+location-spawned\s+([^>]*?)-->/g;
const WC_LOC_SPAWN_ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;
const MAX_LOC_SPAWN_PER_MESSAGE = 3; // 单次回复最多 spawn 3 个动态 location

/**
 * 运行时 LLM 通过 location-spawned marker 即兴生成的地点(parser 中间表示)。
 * applyWcEventsToPlaza 内做"剧本/玩家双开关 + parent 存在 + 配额 + id 不冲突"校验后,
 * 调 plaza.spawnDynamicLocation 物化。
 */
export interface WcLocationSpawnedEvent {
  id: string;
  name: string;
  parent: string;
  description: string;
  reason?: string;
  start: number;
  end: number;
}

/**
 * 地点环境状态变化事件。LLM 在叙事让某地"门破/客栈烧/灯灭"这类**永久变化**时输出。
 * Plaza 写入 sceneStateOverrides;之后 prompt 注入合并 scenario.locations[…].sceneState 初始值。
 */
export interface WcSceneStateChangeEvent {
  locationId: string;
  key: string;
  value: string;
  reason?: string;
  start: number;
  end: number;
}

// WC-STAT 注释格式: <!-- WC-STAT subject=<id> hp=<±n> [stamina=<±n>] [willpower=<±n>] [conditions+=a,b] [conditions-=c] [reason="..."] -->
//   - subject 必填,后面至少一个数值字段 或 conditions 操作
//   - 数字带 +/- 号都支持(+15 / -20 / 15 都接受);A3 放宽:允许浮点 -20.5 → Math.trunc 后取 -20
//   - conditions+=tag1,tag2 追加;conditions-=tag3 移除。tag 是 kebab-case
//   - subject 允许可选引号包裹(A3),reason 可选
const WC_STAT_RE =
  /<!--\s*WC-STAT\s+subject\s*=\s*["']?([a-zA-Z0-9_-]+)["']?((?:\s+(?:hp|stamina|willpower)\s*=\s*[+-]?\d+(?:\.\d+)?|\s+conditions[+\-]=[a-zA-Z0-9,_-]+)+)(?:\s+reason\s*=\s*"([^"]*)")?\s*-->/g;

// WC-TRUST 注释格式: <!-- WC-TRUST delta=<±n> reason="一句话" -->
//   - delta 整数;parser clamp 到 ±TRUST_DELTA_MAX = ±10(性格驱动最大值,prompt 里教 LLM 按 traits 自调)
//   - reason 必填(没 reason 的 trust 变化无意义,且被记入 key_moments 供下次 prompt 看)
//   - 不带 subject —— 这是 NPC 评判自己跟玩家的关系(caller 用 currentNpcId)
//   - 一次 NPC 回复最多 1 个 WC-TRUST(在 prompt 里教 LLM,parser 也只取第一个)
// A3 放宽:delta 接受浮点(parser 用 parseFloat + Math.round 取整)
const WC_TRUST_RE =
  /<!--\s*WC-TRUST\s+delta\s*=\s*([+-]?\d+(?:\.\d+)?)\s+reason\s*=\s*"([^"]*)"\s*-->/g;
const TRUST_DELTA_MAX = 10; // 单次 trust 变化绝对值上限(豪侠级别);LLM 按 traits 自调,parser 仅防爆数
// 子规则:在匹配的 deltas 子串里再扫单个字段。A3 放宽:接受浮点
const WC_STAT_FIELD_RE = /(hp|stamina|willpower)\s*=\s*([+-]?\d+(?:\.\d+)?)/g;
// conditions+= 或 conditions-= ;value 是逗号分隔的 tag 列表
const WC_STAT_CONDITIONS_RE = /conditions([+\-])=([a-zA-Z0-9,_-]+)/g;

const MAX_EVENTS_PER_MESSAGE = 16;
const MAX_STAT_EVENTS_PER_MESSAGE = 24; // 战斗一回合可能有多次,放宽
const MAX_DELTA_MAGNITUDE = 300; // 单次伤害/治疗的绝对值上限,防 LLM 失控写 -9999

// ───────────────────────────────────────────────────────────────
// A2: parse-fail 日志层
// ───────────────────────────────────────────────────────────────
//
// 严格 parser 对格式偏差零容忍 — 引号没配对、reason 漏引号、数值不合法
// 之类的 LLM 输出会被静默丢弃,事后无人知晓。A2 引入"宽松对比 + ring buffer"
// 让这些失败可观测。
//
// 思路:
//   1. 用宽松正则 `<!--\s*WC-(EVENT|STAT|TRUST)[^>]*-->` 扫一遍,得到 fuzzy 计数
//   2. 跟严格 parser 的 strict 计数做差
//   3. 差额 > 0 → 有标记被丢弃,记入 ring buffer + console.warn
//
// ring buffer 容量 100,超出 FIFO 丢弃旧记录。getWcParseFailures() 供 UI 读。

const WC_FUZZY_RE = /<!--\s*WC-(EVENT|STAT|TRUST)\b[^>]*-->/g;

export interface WcParseFailure {
  /** ISO 时间戳 */
  at: string;
  /** 'WC-EVENT' / 'WC-STAT' / 'WC-TRUST' */
  kind: string;
  /** 原始注释片段(截断到 200 字符) */
  raw: string;
  /** 启发式猜测 — 为什么严格 parser 漏了 */
  hint: string;
}

const FAIL_BUFFER_MAX = 100;
const failBuffer: WcParseFailure[] = [];

function recordFail(kind: string, raw: string, hint: string): void {
  const entry: WcParseFailure = {
    at: new Date().toISOString(),
    kind,
    raw: raw.length > 200 ? raw.slice(0, 197) + '...' : raw,
    hint,
  };
  failBuffer.push(entry);
  if (failBuffer.length > FAIL_BUFFER_MAX) failBuffer.shift();
  // 同步打 console,开发时立刻可见
  // eslint-disable-next-line no-console
  console.warn(`[wc-parse-fail] ${kind}: ${hint}\n  raw: ${entry.raw}`);
}

/**
 * 读取最近 N 条 parse 失败记录。供调试 UI / 测试断言用。
 * 返回的是副本,调用方修改不影响内部 buffer。
 */
export function getWcParseFailures(limit = 50): WcParseFailure[] {
  return failBuffer.slice(-limit);
}

/** 清空 ring buffer(主要给单元测试用)。 */
export function clearWcParseFailures(): void {
  failBuffer.length = 0;
}

/** 给 caller 一个直接记录的入口(比如 emotion-detect / A6 用)。 */
export function recordExternalFailure(kind: string, raw: string, hint: string): void {
  recordFail(kind, raw, hint);
}

/**
 * 启发式猜测严格 parser 漏掉一条 fuzzy 匹配的原因。
 * 不求精确,只求给开发者一个能着手调试的线索。
 */
function guessFailHint(kind: string, raw: string): string {
  // reason 漏引号(reason= 后既非 " 也非 ')
  if (/\breason\s*=\s*[^"'\s]/.test(raw)) return 'reason 漏双引号包裹';
  // delta 完全不是数字(delta= 后既非 ± 也非数字也非空白 — 排除 [+-]? 的回溯误判)
  if (kind === 'WC-TRUST' && /delta\s*=\s*[^+\-\d\s]/.test(raw)) return 'delta 不是合法数字';
  // reason 含未转义引号(出现 reason="..."...) 而后又有 " ,正则提前关闭
  // 表现:整条还在但 hint 不准 — 用 raw 里出现多于 2 个引号且 -->  之前作判断
  const quoteCount = (raw.match(/"/g) ?? []).length;
  if (quoteCount > 2 && /reason/.test(raw)) return 'reason 内可能有未转义引号';
  // 属性值含中文字符 / 标点(白名单 [a-zA-Z0-9_-] 外)
  if (/[一-龥]|[，。；！？]/.test(raw.replace(/reason\s*=\s*"[^"]*"/, ''))) {
    return '属性值含中文/标点(白名单外)';
  }
  // 数值字段含小数 — 现在已支持,留作历史 hint
  if (kind === 'WC-STAT' && /=\s*[+-]?\d+\.\d+/.test(raw)) return '数值字段含小数(已支持)';
  // value 内含特殊符号(.、:、/ 等)
  if (kind === 'WC-EVENT' && /value\s*=\s*[^"'\sa-zA-Z0-9_-]/.test(raw)) {
    return 'value 含字符集外字符';
  }
  // kind / key 配对错误(如 milestone-reached + characterId)
  if (kind === 'WC-EVENT' && /companion-died.*\bvalue\s*=|location-changed.*\bcharacterId\s*=/.test(raw)) {
    return 'kind 跟 key 配对错误';
  }
  return '严格正则未匹配(原因不详)';
}

/**
 * 比对宽松匹配跟严格匹配的差额,把"看起来像但没解析出来"的块记入失败日志。
 * 在每个 parse 函数末尾调用,代价极小(就跑一次 fuzzy 正则)。
 *
 * @param text 待审计的原始文本
 * @param expectKind 'WC-EVENT' / 'WC-STAT' / 'WC-TRUST'
 * @param strictRaws 严格 parser 成功匹配的原始片段集合(用来排除已成功的,挑出漏的)
 */
function auditParseGap(text: string, expectKind: string, strictRaws: Set<string>): void {
  if (!text) return;
  WC_FUZZY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const k = expectKind.replace(/^WC-/, '');
  while ((m = WC_FUZZY_RE.exec(text))) {
    if (m[1] !== k) continue;
    const raw = m[0];
    if (strictRaws.has(raw)) continue; // 这条严格 parser 已经吃下
    recordFail(expectKind, raw, guessFailHint(expectKind, raw));
  }
}

/**
 * 从一段 LLM 输出文本里抓出所有 WC-EVENT 标记。
 * 注意:不做白名单校验(看模块顶部说明)。
 */
export function parseWcEvents(text: string): WcEvent[] {
  if (!text || typeof text !== 'string') return [];
  const out: WcEvent[] = [];
  const strictRaws = new Set<string>(); // A2: 收集成功匹配的原始片段,供 audit
  WC_EVENT_RE.lastIndex = 0; // global regex 状态重置(同一 regex 实例多次调用必须)
  let m: RegExpExecArray | null;
  while ((m = WC_EVENT_RE.exec(text))) {
    const [, kind, keyName, idValue, reason] = m;
    // kind / key 配对校验(防止 LLM 用 characterId 标 location-changed 之类)
    const expectKey = WC_EVENT_KIND_KEY[kind as WcEventKind];
    if (keyName !== expectKey) continue; // 注意:这条**已被严格正则匹配**但 kind/key 配错;audit 不会再记一遍
    strictRaws.add(m[0]);
    out.push({
      kind: kind as WcEventKind,
      id: idValue,
      reason: reason && reason.trim() ? reason.trim() : undefined,
      start: m.index,
      end: m.index + m[0].length,
    });
    if (out.length >= MAX_EVENTS_PER_MESSAGE) break;
  }
  auditParseGap(text, 'WC-EVENT', strictRaws);
  return out;
}

/**
 * 解析 scene-state-changed 事件(独立 regex,不进 WcEventKind 联合)。
 * 一回合上限 8 次防失控。
 */
export function parseWcSceneStateChanges(text: string): WcSceneStateChangeEvent[] {
  if (!text || typeof text !== 'string') return [];
  const out: WcSceneStateChangeEvent[] = [];
  WC_SCENE_STATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WC_SCENE_STATE_RE.exec(text))) {
    const [, locId, key, value, reason] = m;
    out.push({
      locationId: locId,
      key,
      value: value.trim(),
      reason: reason && reason.trim() ? reason.trim() : undefined,
      start: m.index,
      end: m.index + m[0].length,
    });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 解析 location-spawned 事件(独立 regex + 灵活 attr 解析)。
 * 一回合上限 MAX_LOC_SPAWN_PER_MESSAGE 次防失控。
 *
 * 仅做格式校验(必填字段齐全 + id/parent kebab-case);
 * 业务校验(双开关 / 配额 / parent 存在 / id 是否撞预设)在 applyWcEventsToPlaza 内做。
 */
export function parseWcLocationSpawnedEvents(text: string): WcLocationSpawnedEvent[] {
  if (!text || typeof text !== 'string') return [];
  const out: WcLocationSpawnedEvent[] = [];
  const droppedRaws: string[] = [];
  WC_LOCATION_SPAWNED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WC_LOCATION_SPAWNED_RE.exec(text))) {
    const fullRaw = m[0];
    const attrStr = m[1] ?? '';
    const attrs: Record<string, string> = {};
    WC_LOC_SPAWN_ATTR_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = WC_LOC_SPAWN_ATTR_RE.exec(attrStr))) {
      attrs[am[1]] = am[2];
    }
    const id = attrs.id;
    const name = attrs.name;
    const parent = attrs.parent;
    const description = attrs.description;
    const reason = attrs.reason;
    if (!id || !/^[a-z0-9.-]+$/.test(id)) {
      droppedRaws.push(`${fullRaw} (id 缺失/非法)`);
      continue;
    }
    if (!name || !name.trim()) {
      droppedRaws.push(`${fullRaw} (name 缺失)`);
      continue;
    }
    if (!parent || !/^[a-z0-9.-]+$/.test(parent)) {
      droppedRaws.push(`${fullRaw} (parent 缺失/非法)`);
      continue;
    }
    if (!description || !description.trim()) {
      droppedRaws.push(`${fullRaw} (description 缺失)`);
      continue;
    }
    out.push({
      id,
      name: name.trim(),
      parent,
      description: description.trim(),
      reason: reason && reason.trim() ? reason.trim() : undefined,
      start: m.index,
      end: m.index + fullRaw.length,
    });
    if (out.length >= MAX_LOC_SPAWN_PER_MESSAGE) break;
  }
  if (droppedRaws.length > 0) {
    recordExternalFailure(
      'WC-EVENT',
      'location-spawned',
      `${droppedRaws.length} 条 marker 字段不全已丢弃: ${droppedRaws.slice(0, 3).join('; ')}`,
    );
  }
  return out;
}

/**
 * 把 WC-EVENT 注释从展示文本里剥掉。
 * UI 渲染消息时调,避免用户看到 raw 注释。
 * (大多数 markdown 渲染器会自动剥 HTML 注释,这层是保险。)
 */
export function stripWcEvents(text: string): string {
  if (!text) return text;
  return text
    .replace(WC_EVENT_RE, '')
    .replace(WC_SCENE_STATE_RE, '') // scene-state-changed 独立 regex,也一起剥
    .replace(WC_LOCATION_SPAWNED_RE, '') // location-spawned 独立 regex,也一起剥
    .replace(WC_STAT_RE, '') // WC-STAT 也一起剥
    .replace(WC_TRUST_RE, '') // WC-TRUST 也一起剥
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 解析 WC-TRUST 标记。
 * 设计:
 *   - 单条 delta clamp 到 ±TRUST_DELTA_MAX = ±10,防 LLM 写 +999 一次跳满 trust
 *   - 一回复内多个 WC-TRUST 合并成 1 个(delta 累加再 clamp;reason 用 / 拼接),不再静默丢弃
 *     (这样即便 LLM 拆成 2-3 个写,信号也不丢)
 *   - 返回数组长度 ≤1(合并后),caller 可继续按"单个"语义处理
 */
export function parseWcTrustEvents(text: string): WcTrustEvent[] {
  if (!text || typeof text !== 'string') return [];
  // A5:不再 break,先扫所有匹配,然后合并
  WC_TRUST_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let deltaSum = 0;
  const reasons: string[] = [];
  const strictRaws = new Set<string>(); // A2
  let firstStart = -1;
  let lastEnd = -1;
  let count = 0;
  while ((m = WC_TRUST_RE.exec(text))) {
    const [, deltaStr, reason] = m;
    strictRaws.add(m[0]);
    // A3:接受浮点(parseFloat),trust delta 用 round 而非 trunc(+0.7 算 +1 更合理)
    const rawFloat = parseFloat(deltaStr);
    if (!Number.isFinite(rawFloat)) continue;
    const raw = Math.round(rawFloat);
    const trimmedReason = (reason ?? '').trim();
    if (!trimmedReason) continue; // 没 reason 拒收
    // 单条先 clamp,再累加(防止 LLM 写 5 个 +99 累加变 +495)
    const clampedSingle = Math.max(-TRUST_DELTA_MAX, Math.min(TRUST_DELTA_MAX, raw));
    if (clampedSingle === 0) continue;
    deltaSum += clampedSingle;
    reasons.push(trimmedReason);
    if (firstStart < 0) firstStart = m.index;
    lastEnd = m.index + m[0].length;
    count++;
    // 极端防御:超过 5 个 WC-TRUST/回复必有蹊跷,停止累加
    if (count >= 5) break;
  }
  auditParseGap(text, 'WC-TRUST', strictRaws);
  if (count === 0) return [];
  // 合并后再做一次最终 clamp(防小幅多条累加爆 ±10)
  const finalDelta = Math.max(-TRUST_DELTA_MAX, Math.min(TRUST_DELTA_MAX, deltaSum));
  if (finalDelta === 0) return []; // 累加后正好抵消 → 当无事发生
  return [
    {
      delta: finalDelta,
      // 多条时用 " / " 拼接,清晰反映"这一回合 LLM 综合判断了哪些事"
      reason: reasons.join(' / '),
      start: firstStart,
      end: lastEnd,
    },
  ];
}

/**
 * 解析 WC-STAT 数值变化标记。
 * 安全性同 WC-EVENT:不校验 subject 是否在白名单,由 plaza.applyCombatDelta 负责。
 * 单条 delta 绝对值被 clamp 到 MAX_DELTA_MAGNITUDE,防 LLM 写 -99999 一击秒杀。
 */
export function parseWcStatEvents(text: string): WcStatEvent[] {
  if (!text || typeof text !== 'string') return [];
  const out: WcStatEvent[] = [];
  const strictRaws = new Set<string>(); // A2
  WC_STAT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WC_STAT_RE.exec(text))) {
    const [, subject, deltasBlob, reason] = m;
    strictRaws.add(m[0]);
    const ev: WcStatEvent = {
      subject,
      reason: reason && reason.trim() ? reason.trim() : undefined,
      start: m.index,
      end: m.index + m[0].length,
    };
    // 子扫描 1:hp / stamina / willpower 数值字段
    WC_STAT_FIELD_RE.lastIndex = 0;
    let f: RegExpExecArray | null;
    while ((f = WC_STAT_FIELD_RE.exec(deltasBlob))) {
      const [, key, valStr] = f;
      // A3:接受浮点(parseFloat + trunc),-20.5 → -20,+15.7 → 15;
      // 用 trunc 而非 round,因为伤害值"少算半点"比"多算半点"更安全
      const rawFloat = parseFloat(valStr);
      if (!Number.isFinite(rawFloat)) continue;
      const raw = Math.trunc(rawFloat);
      const clamped = Math.max(-MAX_DELTA_MAGNITUDE, Math.min(MAX_DELTA_MAGNITUDE, raw));
      if (key === 'hp') ev.hp = clamped;
      else if (key === 'stamina') ev.stamina = clamped;
      else if (key === 'willpower') ev.willpower = clamped;
    }
    // 子扫描 2:conditions+= / conditions-= 标签操作
    WC_STAT_CONDITIONS_RE.lastIndex = 0;
    let c: RegExpExecArray | null;
    while ((c = WC_STAT_CONDITIONS_RE.exec(deltasBlob))) {
      const [, op, tagBlob] = c;
      const tags = tagBlob
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0 && t.length <= 40); // 单个 tag 最长 40 字符
      if (tags.length === 0) continue;
      if (op === '+') {
        ev.conditionsAdd = [...(ev.conditionsAdd ?? []), ...tags];
      } else {
        ev.conditionsRemove = [...(ev.conditionsRemove ?? []), ...tags];
      }
    }
    // 至少要有一个有效字段才算事件成立
    const hasField =
      ev.hp !== undefined ||
      ev.stamina !== undefined ||
      ev.willpower !== undefined ||
      (ev.conditionsAdd && ev.conditionsAdd.length > 0) ||
      (ev.conditionsRemove && ev.conditionsRemove.length > 0);
    if (hasField) out.push(ev);
    if (out.length >= MAX_STAT_EVENTS_PER_MESSAGE) break;
  }
  auditParseGap(text, 'WC-STAT', strictRaws);
  return out;
}

import { plaza } from './plaza';
import { describeStatsForLlm, type CombatStat } from './combat-stats';
import { getScenario, type DynamicLocation } from './scenarios';

/**
 * 处理一条 LLM 输出的完整副作用:
 *   1. parse WC-EVENT 标记
 *   2. 写入持久化状态(plaza.markCompanionDead/markItemLost/setCurrentLocation/triggerBeats)
 *   3. 收集本次真正命中的展示信息,供 UI 通知
 *   4. 返回剥掉标记的净化文本,适合写入 messages 历史(避免 LLM 后续看到自己的旧标记)
 *
 * location-changed / milestone-reached 只在当前在剧本里(plaza.inScenario != null)时生效;
 * 广场态下静默忽略。
 */
export function applyWcEventsToPlaza(text: string, opts: ApplyWcEventsOptions = {}): {
  cleanedText: string;
  diedCompanionNames: string[];
  lostItemNames: string[];
  /** 本次最终切到的 location id(取最后一个 location-changed);未切返 null */
  newLocation: string | null;
  /** 本次实际新增的 milestone id 列表(去重过) */
  newMilestoneIds: string[];
  /** 本次新发现的 artifact ids(已 dedup,只保留真新增) */
  newlyDiscoveredArtifactIds: string[];
  /** 本次写入的环境状态变化 */
  sceneStateChanges: Array<{ locationId: string; key: string; value: string }>;
  /** 本次新物化的动态 location(双开关 + 配额校验通过的) */
  newlySpawnedLocations: DynamicLocation[];
} {
  const events = parseWcEvents(text);
  const sceneStateEvents = parseWcSceneStateChanges(text);
  const spawnEvents = parseWcLocationSpawnedEvents(text);
  const diedCompanionNames: string[] = [];
  const lostItemNames: string[] = [];
  let newLocation: string | null = null;
  const newMilestoneIds: string[] = [];
  const newlyDiscoveredArtifactIds: string[] = [];
  const sceneStateChanges: Array<{ locationId: string; key: string; value: string }> = [];
  const newlySpawnedLocations: DynamicLocation[] = [];
  if (events.length === 0 && sceneStateEvents.length === 0 && spawnEvents.length === 0) {
    return {
      cleanedText: text,
      diedCompanionNames,
      lostItemNames,
      newLocation,
      newMilestoneIds,
      newlyDiscoveredArtifactIds,
      sceneStateChanges,
      newlySpawnedLocations,
    };
  }
  const currentScenarioId = plaza.get().inScenario;
  const scenarioObj = currentScenarioId ? getScenario(currentScenarioId) : null;
  // A4:拿当前剧本的预设 locations 白名单(可能 undefined → 不校验)
  const scenarioLocations = scenarioObj?.locations?.map((l) => l.id) ?? null;

  // ─── 1. spawn 先处理(物化新 location → 后续 location-changed 可跳过去)──
  if (currentScenarioId && spawnEvents.length > 0) {
    const config = scenarioObj?.dynamicLocations;
    const playerAllowed = plaza.getPlayerSettings().allowRuntimeExpansion;
    if (!config?.allowed) {
      // 剧本未授权:全丢
      for (const sp of spawnEvents) {
        recordExternalFailure(
          'WC-EVENT',
          `location-spawned id=${sp.id}`,
          '剧本未声明 dynamicLocations.allowed=true,已丢',
        );
      }
    } else if (!playerAllowed) {
      // 玩家未开启:全丢
      for (const sp of spawnEvents) {
        recordExternalFailure(
          'WC-EVENT',
          `location-spawned id=${sp.id}`,
          '玩家未开启 allowRuntimeExpansion 设置,已丢',
        );
      }
    } else {
      const cap = config.maxPerSession ?? 8;
      const requireConnected = config.requireConnectedToCurrent ?? true;
      const expectedPrefix = `${currentScenarioId}.dyn-`;
      for (const sp of spawnEvents) {
        // 1) id 必须 <scenarioId>.dyn-<kebab>
        if (!sp.id.startsWith(expectedPrefix)) {
          recordExternalFailure(
            'WC-EVENT',
            `location-spawned id=${sp.id}`,
            `id 必须以 "${expectedPrefix}" 开头,已丢`,
          );
          continue;
        }
        // 2) 不能撞预设 location id
        if (scenarioLocations?.includes(sp.id)) {
          recordExternalFailure(
            'WC-EVENT',
            `location-spawned id=${sp.id}`,
            'id 跟预设 location 冲突,已丢',
          );
          continue;
        }
        // 3) parent 必须存在(预设或已 spawn)
        const presetExists = scenarioLocations?.includes(sp.parent) ?? false;
        const dynamicExists = !!plaza.getSpawnedLocation(currentScenarioId, sp.parent);
        if (!presetExists && !dynamicExists) {
          recordExternalFailure(
            'WC-EVENT',
            `location-spawned id=${sp.id}`,
            `parent "${sp.parent}" 不存在(既不是预设也不是已 spawn),已丢`,
          );
          continue;
        }
        // 4) requireConnectedToCurrent:parent 必须是玩家当前 location
        if (requireConnected) {
          const cur = plaza.get().currentLocation;
          if (cur !== sp.parent) {
            recordExternalFailure(
              'WC-EVENT',
              `location-spawned id=${sp.id}`,
              `parent "${sp.parent}" 不是玩家当前位置 "${cur ?? '(无)'}" → 违反 requireConnectedToCurrent,已丢`,
            );
            continue;
          }
        }
        // 5) session cap(每次检查最新计数,避免一回合 spawn 多个时超额)
        const used = plaza.getSessionSpawnCount(currentScenarioId);
        if (used >= cap) {
          recordExternalFailure(
            'WC-EVENT',
            `location-spawned id=${sp.id}`,
            `已达 session cap (${used}/${cap}),已丢`,
          );
          continue;
        }
        // 6) 物化
        const spawned = plaza.spawnDynamicLocation(currentScenarioId, {
          id: sp.id,
          name: sp.name,
          description: sp.description,
          parent: sp.parent,
        });
        if (spawned) newlySpawnedLocations.push(spawned);
      }
    }
  }

  // 拿一份"当前剧本所有合法 location id"集合(预设 + 已 spawn,含本次新 spawn 的)
  // —— 用于后续 location-changed / scene-state-changed 白名单 warn 时放宽
  const validLocationIds = new Set<string>(scenarioLocations ?? []);
  if (currentScenarioId) {
    for (const l of plaza.listSpawnedLocations(currentScenarioId)) {
      validLocationIds.add(l.id);
    }
  }

  // ─── 2. 通用 WC-EVENT 事件循环 ──
  const milestoneIds: string[] = [];
  for (const ev of events) {
    if (ev.kind === 'companion-died') {
      if (!opts.allowDestructiveEvents) {
        recordExternalFailure(
          'WC-EVENT',
          `companion-died characterId=${ev.id}`,
          '不可逆事件待人工确认,未自动 apply',
        );
        continue;
      }
      if (plaza.markCompanionDead(ev.id)) {
        const c = plaza.get().companions.find((x) => x.characterId === ev.id);
        // 取一个对玩家有意义的展示名:origin 第一段 / id 去前缀 / fallback id
        const display =
          c?.profile.origin?.split('·')[0]?.trim() ||
          c?.characterId.replace(/^companion-/, '') ||
          ev.id;
        diedCompanionNames.push(display);
      }
    } else if (ev.kind === 'item-lost') {
      if (!opts.allowDestructiveEvents) {
        recordExternalFailure(
          'WC-EVENT',
          `item-lost itemId=${ev.id}`,
          '不可逆事件待人工确认,未自动 apply',
        );
        continue;
      }
      if (plaza.markItemLost(ev.id)) {
        const i = plaza.get().inventory.find((x) => x.id === ev.id);
        lostItemNames.push(i?.name ?? ev.id);
      }
    } else if (ev.kind === 'location-changed') {
      // 只在剧本内生效;广场态静默忽略
      if (!currentScenarioId) continue;
      // A4:白名单 guard(放宽到"预设+动态"集)— 不在内时拒绝 apply
      if (scenarioLocations && !validLocationIds.has(ev.id)) {
        recordExternalFailure(
          'WC-EVENT',
          `location-changed value=${ev.id}`,
          `value '${ev.id}' 既不在预设白名单也不在动态扩展中(已拒绝,可能 LLM 编造地点)`,
        );
        continue;
      }
      // T7:连通图软校验 — 当前 location 有 connections 表且目标不在内 → warn 但仍 apply
      // 当前 location 优先查动态(spawned),再查预设
      const currentLoc = plaza.get().currentLocation;
      if (currentLoc && currentLoc !== ev.id) {
        const dynamicHere = plaza.getSpawnedLocation(currentScenarioId, currentLoc);
        const here = dynamicHere
          ? { connections: dynamicHere.connections }
          : scenarioObj?.locations?.find((l) => l.id === currentLoc);
        if (
          here?.connections &&
          here.connections.length > 0 &&
          !here.connections.includes(ev.id)
        ) {
          recordExternalFailure(
            'WC-EVENT',
            `location-changed from=${currentLoc} to=${ev.id}`,
            `从 '${currentLoc}' 跳到 '${ev.id}',但 '${ev.id}' 不在邻接表 [${here.connections.join(', ')}] 内(已 apply)`,
          );
        }
      }
      // 多次 location-changed 取最后一次(剧情可能写"先到 A,再到 B")
      plaza.setCurrentLocation(ev.id);
      newLocation = ev.id;
    } else if (ev.kind === 'milestone-reached') {
      if (!currentScenarioId) continue;
      milestoneIds.push(ev.id);
    } else if (ev.kind === 'artifact-discovered') {
      if (!currentScenarioId) continue;
      if (plaza.discoverArtifact(currentScenarioId, ev.id)) {
        newlyDiscoveredArtifactIds.push(ev.id);
      }
    }
  }
  // 批量提交 milestone(triggerBeats 内部已去重 + 返回真正新增的)
  if (milestoneIds.length > 0 && currentScenarioId) {
    const added = plaza.triggerBeats(currentScenarioId, milestoneIds);
    newMilestoneIds.push(...added);
  }
  // ─── 3. scene-state-changed:独立处理,每条调一次 plaza.setSceneStateOverride ──
  for (const ssc of sceneStateEvents) {
    if (!currentScenarioId) continue;
    // 软校验:放宽到预设 + 动态
    if (scenarioLocations && !validLocationIds.has(ssc.locationId)) {
      recordExternalFailure(
        'WC-EVENT',
        `scene-state-changed location=${ssc.locationId}`,
        `locationId '${ssc.locationId}' 不在预设也不在动态扩展中`,
      );
    }
    plaza.setSceneStateOverride(currentScenarioId, ssc.locationId, ssc.key, ssc.value);
    sceneStateChanges.push({ locationId: ssc.locationId, key: ssc.key, value: ssc.value });
  }
  return {
    cleanedText: stripWcEvents(text),
    diedCompanionNames,
    lostItemNames,
    newLocation,
    newMilestoneIds,
    newlyDiscoveredArtifactIds,
    sceneStateChanges,
    newlySpawnedLocations,
  };
}

/**
 * 处理一条 LLM 输出里的所有 WC-STAT 数值变化标记。
 * 调用 plaza.applyCombatDelta 写入状态;白名单已在 plaza 层处理。
 * 返回 (subject, 变化描述) 数组,供 UI 提示用("队友 XX 受了重伤")。
 */
export function applyWcStatEventsToPlaza(
  text: string,
): Array<{ subject: string; deltaText: string; reason?: string }> {
  const events = parseWcStatEvents(text);
  if (events.length === 0) return [];
  const out: Array<{ subject: string; deltaText: string; reason?: string }> = [];
  for (const ev of events) {
    const ok = plaza.applyCombatDelta(ev.subject, {
      hp: ev.hp,
      stamina: ev.stamina,
      willpower: ev.willpower,
      conditionsAdd: ev.conditionsAdd,
      conditionsRemove: ev.conditionsRemove,
    });
    if (!ok) continue;
    const parts: string[] = [];
    if (ev.hp !== undefined && ev.hp !== 0)
      parts.push(`HP ${ev.hp > 0 ? '+' : ''}${ev.hp}`);
    if (ev.stamina !== undefined && ev.stamina !== 0)
      parts.push(`体力 ${ev.stamina > 0 ? '+' : ''}${ev.stamina}`);
    if (ev.willpower !== undefined && ev.willpower !== 0)
      parts.push(`意志 ${ev.willpower > 0 ? '+' : ''}${ev.willpower}`);
    if (ev.conditionsAdd && ev.conditionsAdd.length > 0)
      parts.push(`+状态: ${ev.conditionsAdd.join(',')}`);
    if (ev.conditionsRemove && ev.conditionsRemove.length > 0)
      parts.push(`-状态: ${ev.conditionsRemove.join(',')}`);
    if (parts.length === 0) continue;
    out.push({ subject: ev.subject, deltaText: parts.join(' '), reason: ev.reason });
  }
  return out;
}

/**
 * E 方案 — chatMode 判定 heuristic。
 *
 * 默认 'engaged'(保守 — 漏标 marker 比多塞 prompt 更糟)。
 * 仅当满足全部"安全条件"时降级到 'casual':
 *   - 玩家不在战斗(combatStats 空或不存在)
 *   - 玩家消息短(< 20 字符)
 *   - 玩家消息不含动作 / 紧张关键词
 *
 * 由 caller (page.tsx:send) 在每次 NPC 回复前调用,传给 SystemPromptContext.chatMode。
 * Director / banter 等其他 callLLM 路径不用此函数(它们一律 engaged)。
 */
const ACTION_KEYWORDS_RE =
  /\[行动\]|\[叙事\]|打|杀|拔|抽|挥|刺|斩|烧|死|逃|跑|追|护|救|喊|怒|急|快|紧|危/;

export function detectChatMode(
  playerMsg: string,
  combatStats?: Record<string, unknown> | null,
): 'engaged' | 'casual' {
  // 战斗中 → 一律 engaged(WC-STAT 段必须在)
  if (combatStats && Object.keys(combatStats).length > 0) return 'engaged';
  // 消息含动作 / 紧张关键词 → engaged
  if (ACTION_KEYWORDS_RE.test(playerMsg)) return 'engaged';
  // 消息够长(可能在描述情境)→ engaged
  if (playerMsg.length >= 20) return 'engaged';
  // 短消息 + 无关键词 + 不在战斗 → casual(寒暄 / 闲聊)
  return 'casual';
}

/**
 * 把 trust_archetype 映射成 prompt 里的一行描述。
 * 未设档 → 返 null(caller 回退到 5 档矩阵)。
 */
function formatTrustArchetypeLine(
  archetype: 'firebrand' | 'moderate' | 'politician' | 'aloof' | 'paranoid' | undefined,
): string | null {
  switch (archetype) {
    case 'firebrand':
      return '直爽豪迈 / 重义气,可剧烈 ±5~±7。一句对眼就 +5,一次背叛 -7。';
    case 'moderate':
      return '中性文人 / 普通豪侠,典型 ±3,极端事件才 ±5。';
    case 'politician':
      return '城府深 / 老练政客,大事 ±2,小事不变。';
    case 'aloof':
      return '极冷淡 / 修行者,±1 已是极限,大多数轮不写。';
    case 'paranoid':
      return '多疑 / 心机重 / 被骗过,单次小(典型 +1,负向稍敏感 -2)。加分可累积,但短期进不了高信任区。';
    default:
      return null;
  }
}

/**
 * 构建「当前身体状态 + WC-STAT 规则」的 prompt 段。
 * 拼到 NPC system prompt 末尾,跟 buildWcEventInstructions 并列。
 *
 * @param stats key=subject ('player' / companion-id),value=该角色当前数值
 * @param subjectNames 每个 subject id 的人类可读名字,LLM 描述时用
 */
export function buildCombatStateInstructions(input: {
  stats: Record<string, CombatStat>;
  subjectNames: Record<string, string>;
}): string {
  const entries = Object.entries(input.stats);
  if (entries.length === 0) return '';

  const lines: string[] = [
    '',
    '## 战斗与身体状态 (WC-STAT)',
    '',
    '**玩家看不见这些数字**,他们只通过你的叙事感知角色状态。你的任务:',
    '1. **读** 下方的精确数值,用文字翻译成自然描述(气喘吁吁 / 左臂使不上劲 / 心如止水 / 眼神涣散),不要直接报数字',
    '2. 不同 tier 用不同笔触:充沛=利落、良好=自如、受损=吃力、危急=濒临极限、力竭=瘫倒',
    '3. **写** 战斗 / 心理冲击 / 受伤 / 恢复发生时,在回复末尾输出 WC-STAT 标记,游戏引擎会按数值变化推进世界',
    '',
    '### 当前数值(玩家不知道,你必须知道并据此叙事)',
  ];

  for (const [subject, stat] of entries) {
    const displayName = input.subjectNames[subject] ?? subject;
    lines.push('');
    lines.push(`**${displayName}** (\`${subject}\`)`);
    lines.push(describeStatsForLlm(stat));
  }

  // 渐进披露:6 条示例 → 3 条核心(hp / hp+condition+= / hp+condition-=),其余规则浓缩
  lines.push('');
  lines.push('### 输出格式(原样照抄,只换 subject、数字、状态名)');
  lines.push('```');
  lines.push('<!-- WC-STAT subject=<id> hp=-15 stamina=-5 reason="挨了一刀" -->');
  lines.push('<!-- WC-STAT subject=<id> hp=-25 conditions+=broken-left-arm reason="左臂被砍" -->');
  lines.push('<!-- WC-STAT subject=<id> hp=+10 conditions-=broken-left-arm reason="找到接骨大夫" -->');
  lines.push('```');
  lines.push('');
  lines.push('**数值规则**:');
  lines.push('- subject 用上方 `id`(玩家=`player`,队友=companion id);数字带 ±,单次绝对值 ≤50');
  lines.push('- 没发生战斗 / 变化时**不要**输出 WC-STAT,留干净对话');
  lines.push('- 敌方 NPC 自己脑内 track,不为它们写 WC-STAT');
  lines.push('- HP=0 是"濒死/倒地",非死亡;真死亡用 `WC-EVENT companion-died`');
  lines.push('');
  lines.push('**持续状态(conditions)规则**:');
  lines.push('- 严重伤害用 `conditions+=<tag>` 追加 kebab-case 标签(broken-left-arm / bleeding / poisoned / soul-tainted / concussion 等)');
  lines.push('- 多个用逗号分隔(`conditions+=bleeding,broken-rib`);移除用 `conditions-=<tag>`');
  lines.push('- 下次见到此角色时 conditions 会出现在「持续状态」行,请据此限制其行为');
  lines.push('- 单条 WC-STAT 里 condition 数 ≤3,不要重复追加已有的');

  return lines.join('\n');
}

/**
 * NPC system prompt 里塞给 LLM 的「事件标记规则」说明文本。
 * 拼到 system prompt 末尾即可,长度 350-800 字(取决于启用的子模块)。
 *
 * 子模块按需启用:
 *   - 携带了队友/物品 → 输出 companion-died/item-lost 规则
 *   - 在动态剧本里(locations 非空) → 输出 location-changed 规则
 *   - 设了 milestone 目标 → 输出 milestone-reached 规则
 *
 * 调用方负责传入这次实际可被标记的 id 列表,否则 LLM 不知道允许标记哪些。
 */
export function buildWcEventInstructions(input: {
  carriedCompanions: Array<{ id: string; name: string }>;
  carriedItems: Array<{ id: string; name: string }>;
  /** 动态剧本的 location 列表(空 / undefined → 不输出 location 规则) */
  locations?: Array<{ id: string; name: string; description?: string }>;
  /** 当前所在 location id(用于提示 LLM 玩家此刻在哪) */
  currentLocationId?: string | null;
  /** 启用 milestone 机制(只要 scenario.targetMilestones > 0 就传 true) */
  milestonesEnabled?: boolean;
  /** 当前 location 有未发现的 artifact → 输出 artifact-discovered 规则 */
  hasUndiscoveredArtifacts?: boolean;
  /**
   * 启用 NPC 自评 trust(只在 NPC chat 路径传 true;Director 不用)。
   * NPC 在回复末尾用 <!-- WC-TRUST delta=±n reason="..." --> 评判这轮跟玩家关系的变化。
   */
  npcTrustEnabled?: boolean;
  /**
   * D 方案:NPC 自带 trust 档位。设了 → WC-TRUST 段只输出该档 1 行;
   * 缺省 → 注入完整 5 档矩阵让 LLM 自己对照(向后兼容,但 prompt 多 ~300B)。
   */
  npcTrustArchetype?: 'firebrand' | 'moderate' | 'politician' | 'aloof' | 'paranoid';
  /**
   * E 方案:对话回合重要性。
   *   - 'engaged'(默认):全套规则
   *   - 'casual':闲聊模式,WC-EVENT 段头 + companion-died/item-lost/WC-STAT 全部折叠,
   *     只留 WC-TRUST + location-changed + milestone-reached 的简化版
   */
  chatMode?: 'engaged' | 'casual';
  /**
   * 运行时扩展开关(双开关全部为 true 时由 caller 传 true)。
   *   - 剧本侧 scenario.dynamicLocations.allowed
   *   - 玩家侧 plaza.playerSettings.allowRuntimeExpansion
   *   - 必须还在 session cap 之内
   *   true → 输出 location-spawned marker 引导段
   *   false / 缺省 / casual → 完全不输出此段(LLM 不知道这条路开着)
   */
  canSpawnLocation?: boolean;
  /**
   * 当前 session 剩余 spawn 配额(scenario.dynamicLocations.maxPerSession - 已用)。
   * 注入 prompt 让 LLM 知道还能扩展几次,自我节制。
   */
  spawnCapRemaining?: number;
  /**
   * 当前 session 已用配额(纯展示用,方便 LLM 自己评估"是否要再 spawn")。
   */
  spawnUsed?: number;
  /**
   * 剧本作者自定义的扩展引导话术(scenario.dynamicLocations.hint)。
   * 缺省 → 用本函数内置默认引导。非空 → 在默认段头位置注入此段。
   */
  spawnHint?: string;
  /**
   * 当前 scenarioId(用于在 prompt 示例里给 LLM 看 "<scenarioId>.dyn-..." 的具体格式)。
   * canSpawnLocation 为 true 时必须传。
   */
  spawnScenarioId?: string;
}): string {
  const {
    carriedCompanions,
    carriedItems,
    locations,
    currentLocationId,
    milestonesEnabled,
    hasUndiscoveredArtifacts,
    npcTrustEnabled,
    npcTrustArchetype,
    chatMode,
    canSpawnLocation,
    spawnCapRemaining,
    spawnUsed,
    spawnHint,
    spawnScenarioId,
  } = input;
  const isCasual = chatMode === 'casual';
  const hasLifeCycle = !isCasual && (carriedCompanions.length > 0 || carriedItems.length > 0);
  const hasLocations = !!(locations && locations.length > 0);
  // 运行时扩展段:双开关都通过 + 配额未满 + 有 scenarioId + 不在 casual 模式
  // casual 跳过 — spawn 是高价值动作,不该在闲聊回合发生
  const hasSpawn =
    !!canSpawnLocation &&
    !isCasual &&
    (spawnCapRemaining ?? 0) > 0 &&
    !!spawnScenarioId &&
    !!currentLocationId; // 必须知道玩家当前位置才能正确填 parent
  // 完全没任何子模块要启用 → 不输出
  if (
    !hasLifeCycle &&
    !hasLocations &&
    !milestonesEnabled &&
    !npcTrustEnabled &&
    !hasUndiscoveredArtifacts &&
    !hasSpawn
  )
    return '';

  const lines: string[] = [
    '',
    '## 世界状态事件标记 (WC-EVENT)',
    '',
    isCasual
      ? // E:casual 模式段头压缩到 1 行
        '在回复末尾用 HTML 注释标记关键世界变化(玩家看不到,引擎会读)。'
      : '当剧情发展导致世界状态变更时,在你回复的【末尾】插入一行或多行 HTML 注释标记。' +
        '玩家看不到这行注释,但游戏引擎会读取并永久改变状态。',
  ];

  // ── companion-died / item-lost 段(渐进式披露:companion 和 item 各自按需输出,
  //    跟旧版"任一非空就同时出"不同;空 ctx 时这段直接跳过,LLM 不用看不相关规则)──
  const hasCompanionDied = carriedCompanions.length > 0;
  const hasItemLost = carriedItems.length > 0;
  if (hasCompanionDied || hasItemLost) {
    const titleParts: string[] = [];
    if (hasCompanionDied) titleParts.push('队友阵亡');
    if (hasItemLost) titleParts.push('物品损毁');
    lines.push(
      '',
      `### ${titleParts.join(' / ')}(不可逆)`,
      '',
      '**仅在以下情况输出标记**:',
    );
    if (hasCompanionDied) {
      lines.push('- 队友在剧情里**确凿无疑地死亡**(不是受伤、晕厥、暂时离队 —— 必须是死)');
    }
    if (hasItemLost) {
      lines.push('- 物品被**永久损毁或彻底失落**(不是损耗、出借、暂存 —— 必须是再也拿不回来)');
    }
    lines.push('', '**严禁**轻率标记。一旦标记,代价极大。', '', '**格式**:', '```');
    if (hasCompanionDied) {
      lines.push('<!-- WC-EVENT companion-died characterId=<id> reason="一句话" -->');
    }
    if (hasItemLost) {
      lines.push('<!-- WC-EVENT item-lost itemId=<id> reason="一句话" -->');
    }
    lines.push('```');

    if (hasCompanionDied) {
      lines.push('', '**可被标记阵亡的队友**(只能用以下 id):');
      for (const c of carriedCompanions) {
        lines.push(`- \`${c.id}\` (${c.name})`);
      }
    }
    if (hasItemLost) {
      lines.push('', '**可被标记损毁的物品**(只能用以下 id):');
      for (const i of carriedItems) {
        lines.push(`- \`${i.id}\` (${i.name})`);
      }
    }
    lines.push('', 'id 必须完全匹配上方列表(精确到每个字符)。不在列表里的 id 写了无效。');
  }

  // ── location-changed 段(动态剧本)──
  // casual 时用紧凑版:列表保留(没法省 — LLM 需知道合法 id 才能写),规则压成 1 行
  if (hasLocations && locations) {
    if (isCasual) {
      lines.push(
        '',
        '### 玩家移动',
        '玩家**真的**到了另一个地点时输出 `<!-- WC-EVENT location-changed value=<id> reason="一句话" -->`。',
        '可用 id:',
      );
      for (const l of locations) {
        const here = currentLocationId === l.id ? ' ← **现在**' : '';
        lines.push(`- \`${l.id}\` (${l.name})${here}`);
      }
    } else {
      lines.push(
        '',
        '### 玩家移动 (location-changed)',
        '',
        '这是个**开放世界**剧本,玩家可以在多个地点之间漫游。当剧情让玩家**真的**到达另一个地点时,输出 location-changed 标记。',
        '',
        '**格式**:',
        '```',
        '<!-- WC-EVENT location-changed value=<location-id> reason="一句话怎么去的" -->',
        '```',
        '',
        '**当前可用地点**(只能用以下 id):',
      );
      for (const l of locations) {
        const here = currentLocationId === l.id ? ' ← **玩家当前在此**' : '';
        const desc = l.description ? ` — ${l.description.slice(0, 60)}` : '';
        lines.push(`- \`${l.id}\` (${l.name})${desc}${here}`);
      }
      lines.push(
        '',
        '**规则**:',
        '- 只在叙事中**真的**到达新地点时输出(不是"打算去"、"看向远方"、"听说那里有什么")',
        '- 同一地点不要重复标记(已经在 changan 就不要再写 location-changed value=changan)',
        '- 玩家短暂离开但当场返回(如"走到院子里"),不要标记 — 那不是穿城而过',
        '- 一次回复最多 1 个 location-changed(剧情压缩感的需要)',
      );
    }
  }

  // ── artifact-discovered 段 ──
  // casual 模式跳过(寒暄时不会有发现);hasUndiscoveredArtifacts=true 才输出
  if (hasUndiscoveredArtifacts && !isCasual) {
    lines.push(
      '',
      '### 玩家发现线索 / 物件 (artifact-discovered)',
      '',
      '当玩家在剧情中**真的调查 / 触发发现** system prompt 里"# 此地藏的线索/物件"列表的某件物件,在叙事末尾追加:',
      '```',
      '<!-- WC-EVENT artifact-discovered value=<artifactId> reason="一句话怎么发现的" -->',
      '```',
      '- 只能用 system prompt 已列出的 artifact id;未列出的不要凭空标',
      '- 玩家若没主动调查 / 询问 / 察觉相关方向,不要主动让他"发现"',
      '- 一次叙事最多 1-2 个发现(避免线索倒灌)',
    );
  }

  // ── scene-state-changed 段 ──
  // casual 模式跳过;只在动态剧本(hasLocations)输出
  if (hasLocations && !isCasual) {
    lines.push(
      '',
      '### 环境状态永久变化 (scene-state-changed)',
      '',
      '当剧情让某地点的某个**永久属性**发生变化(客栈被烧、门锁破、灯熄灭、街道堆尸)时,在末尾追加:',
      '```',
      '<!-- WC-EVENT scene-state-changed location=<locId> key=<key> value="<新状态>" reason="一句话" -->',
      '```',
      '- location 用"当前可用地点"列表的 id;key 用 kebab/snake-case;value 描述(可中文,必须双引号)',
      '- 例:`location=tavern key=condition value="烧成废墟"`、`location=palace-gate key=guards value="无人值守"`',
      '- **临时事件**(打开抽屉、翻看书页、关上一扇门)不要标 — 只在玩家**离开再回来仍然变了**的情况标',
      '- 同一 location.key 多次写以最后一次为准',
    );
  }

  // ── location-spawned 段(运行时扩展)──
  // 双开关 + 配额 + 非 casual + 有 currentLocation 时输出
  if (hasSpawn) {
    const usedDisp = spawnUsed ?? 0;
    const capRem = spawnCapRemaining ?? 0;
    lines.push('', '### 即兴扩展新场所 (location-spawned)');
    if (spawnHint && spawnHint.trim()) {
      // 剧本自定义引导(覆盖默认段头)
      lines.push('', spawnHint.trim());
    } else {
      lines.push(
        '',
        '本剧本与玩家设置都允许你在剧情中**即兴新增地点**。当玩家提到要去某个未列在上述"当前可用地点"' +
          '列表的**具体场所**(如"酒馆后院"、"那条暗巷"),你可以扩展。',
      );
    }
    lines.push(
      '',
      `**剩余配额**:本次 session 还能扩展 ${capRem} 次(已用 ${usedDisp})。`,
      '',
      '**格式**:',
      '```',
      `<!-- WC-EVENT location-spawned id="${spawnScenarioId}.dyn-<kebab>" name="<中文名>" parent="${currentLocationId}" description="<一句场景描述>" reason="<触发原因>" -->`,
      '```',
      '',
      '**规则**:',
      `- \`id\` 必须以 \`${spawnScenarioId}.dyn-\` 开头,kebab-case(如 \`${spawnScenarioId}.dyn-back-alley\`)`,
      `- \`parent\` 必须填玩家**当前所在**地点 id:\`${currentLocationId}\`(其他值会被丢弃)`,
      '- 只扩展能用脚走到的**具体场所**(街角小铺 / 庭院假山 / 后巷),不扩展宏观地理(另一个朝代 / 平行宇宙)',
      '- 一旦命名,描述会被**冻结** — 后续访问保持一致,不要随后改名换设定',
      '- 一次回复**最多扩展 2 个**;不重要的过场地点不要 spawn,留给真正叙事需要的',
      '- spawn 后立刻接 `<!-- WC-EVENT location-changed value="<新 id>" -->` 把玩家移过去(如果剧情让他去了)',
    );
  }

  // ── milestone-reached 段 ──
  // casual 模式跳过(闲聊不可能触发 milestone)
  if (milestonesEnabled && !isCasual) {
    lines.push(
      '',
      '### 剧情里程碑 (milestone-reached)',
      '',
      '这个剧本以 milestone 计算完成度(每达成 1 个就加 1/N 完成度,影响出剧本时的原力奖励)。' +
        '当剧情发生**真正重要的剧情转折**时,输出 milestone-reached 标记。',
      '',
      '**格式**(id 用 kebab-case,描述事件本质):',
      '```',
      '<!-- WC-EVENT milestone-reached id=<milestone-id> reason="一句话" -->',
      '```',
      '',
      '**例子**(id 由你即兴起,但要稳定 — 同一事件再次提及用同一 id 才会被去重):',
      '- `obtained-changsheng-jue` 拿到长生诀',
      '- `befriended-shi-feixuan` 跟师妃暄结下深交',
      '- `defeated-mojen-faction` 重创魔门一脉',
      '',
      '**规则**:',
      '- **稀缺**:整个剧本生命周期里 5-10 个 milestone 就够了,不要凑数。每次输出 1 个、最多 2 个',
      '- **真转折**才标:得到关键物品、跟主要 NPC 关系大变、击败重要敌人、解锁新地点权力等',
      '- 重复 id 会被引擎去重,不双倍计入。但你输出多次也没坏处',
      '- **不要**为"对话进展顺利"、"打了个小架"标 milestone',
    );
  }

  // ── WC-TRUST 段(NPC 自评跟玩家的关系变化)──
  // D 方案:NPC 自带 archetype → 只输出该档 1 行(省 ~300B/NPC)
  // 否则回退到完整 5 档矩阵让 LLM 自己对照 traits 选档
  if (npcTrustEnabled) {
    const archetypeLine = formatTrustArchetypeLine(npcTrustArchetype);
    lines.push(
      '',
      '### 你对玩家信任的变化 (WC-TRUST)',
      '',
      '玩家做了明显影响你们关系的事(真诚分担、撒谎被识破、帮你解围、触你逆鳞)时,' +
        '回复末尾加一个 WC-TRUST 标记。玩家**看不到数字**,他只能从你的措辞、态度、是否答应他察觉。',
      '',
      '**格式**:`<!-- WC-TRUST delta=<±n> reason="玩家做了什么 / 你为什么这么想" -->`',
    );
    if (archetypeLine) {
      // archetype 1 行版本
      lines.push('', `**你的 trust 幅度**:${archetypeLine}`);
    } else {
      // 5 档完整矩阵(老剧本 / 没打 archetype 的 NPC)
      lines.push(
        '',
        '**幅度跟你的性格挂钩**(对照 traits 自选档):',
        '- 直爽豪迈 / 重义气:可剧烈,±5~±7',
        '- 中性文人 / 普通豪侠:典型 ±3,极端 ±5',
        '- 城府深 / 老练政客:大事 ±2,小事不变',
        '- 极冷淡 / 修行者:±1 已是极限,大多数轮不写',
        '- 多疑 / 心机重 / 被骗过:单次小(典型 +1,负向稍敏感 -2);加分可累积,但短期进不了高信任区',
      );
    }
    lines.push(
      '',
      '**关键规则**:',
      '- 大多数轮不该写 — 普通寒暄 / 信息交换 / 绕弯子,关系不动,不写 = 0',
      '- 一次回复最多 1 个;`reason` 必填且具体(下次对话你能看见这句)',
      '- **绝不**在对话文本里出现"信任 +3""好感度"等元词',
    );
  }

  return lines.join('\n');
}

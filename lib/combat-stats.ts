/**
 * 隐藏数值系统 (Combat Stats)
 * ============================
 *
 * 主角 / 队友 / 敌方 NPC 都有 3 个槽位:
 *   - HP   生命体力。0 = 倒地不起(是否死亡由 LLM 走 WC-EVENT 决定,不立刻判死)
 *   - 体力 stamina  跑动、连击、追击等行为的资源。0 = 力竭,只能喘气
 *   - 意志 willpower 心理/精神/腐化抵抗。0 = 崩溃/恐惧/被混沌渗透/精神失控
 *
 * 设计哲学(跟用户讨论后的决定):
 *   - **玩家看不到精确数字**。3 个数值只注入 LLM system prompt
 *   - LLM 把数字翻译成自然语言("你气喘吁吁"/"左臂使不上劲"/"心如止水")
 *   - LLM 在战斗叙事中输出 `<!-- WC-STAT subject=... hp=-15 ... -->` 标记
 *   - 跨场景持续,出剧本时全员回满(广场恢复 — 跟 forceReward 重置一个心智模型)
 *   - 死亡仍走 WC-EVENT(剧情驱动),HP=0 ≠ 自动死,只是"濒死状态"
 *
 * 跟传统 RPG 的关键差异:
 *   - 传统:HP 条暴露给玩家,玩家计算"我还能挨几下"
 *   - 这里:玩家从 LLM 描述判断状态,焦虑感来自叙事而非数字
 *   - LLM 拿到精确数字 → 描述更一致,不会今天写"奄奄一息"明天写"龙精虎猛"
 */

/** 一个槽位的当前值/上限对。 */
export interface StatSlot {
  current: number;
  max: number;
}

export interface CombatStat {
  hp: StatSlot;
  stamina: StatSlot;
  willpower: StatSlot;
  /**
   * 持续负面状态标签(自由 kebab-case)。LLM 在剧情发生严重伤害时输出
   * `conditions+=broken-left-arm` 把状态写入,后续对话里 LLM 看到此字段
   * 会自动限制角色行为(不能用左手攻击 / 不能跑等)。
   *
   * 设计选项:开放标签 — LLM 自由命名(broken-left-arm / soul-tainted /
   * concussion / poisoned),不预先枚举。代价是可能 LLM 写得不一致(broken-arm
   * vs broken-left-arm),但这种语义偏差在叙事里通常无所谓。
   *
   * 出剧本时跟数值一起清空(进剧本重新开始 — 跟 "出剧本回满" 一致)。
   * 严重持久创伤(如缺一条腿)应该走 WC-EVENT,不在 condition 里。
   */
  conditions: string[];
}

/** 5 档状态描述,翻译给 LLM 看。
 *  > 0.8 = 充沛
 *  0.5 - 0.8 = 良好
 *  0.25 - 0.5 = 受损
 *  0.0 - 0.25 = 危急
 *  = 0 = 力竭/濒死/崩溃
 */
export type StatTier = '充沛' | '良好' | '受损' | '危急' | '力竭';

export function tierOf(slot: StatSlot): StatTier {
  if (slot.max <= 0) return '力竭';
  const ratio = slot.current / slot.max;
  if (ratio <= 0) return '力竭';
  if (ratio < 0.25) return '危急';
  if (ratio < 0.5) return '受损';
  if (ratio < 0.8) return '良好';
  return '充沛';
}

/** 把 current clamp 到 [0, max]。max 不变。 */
export function clampSlot(slot: StatSlot): StatSlot {
  const cur = Math.max(0, Math.min(slot.max, Math.floor(slot.current)));
  return { current: cur, max: Math.max(0, Math.floor(slot.max)) };
}

/** 用一组 delta 算新值(支持单/双/三槽位的部分更新 + conditions 增删)。 */
export function applyDeltaToStat(
  stat: CombatStat,
  delta: {
    hp?: number;
    stamina?: number;
    willpower?: number;
    /** 要追加的 condition 标签;已存在则跳过(去重) */
    conditionsAdd?: string[];
    /** 要移除的 condition 标签;不存在则跳过 */
    conditionsRemove?: string[];
  },
): CombatStat {
  // conditions:先 add(去重),再 remove。出现冲突时 remove 赢(更明确)。
  const cond = new Set(stat.conditions ?? []);
  for (const c of delta.conditionsAdd ?? []) {
    const k = c.trim().toLowerCase();
    if (k) cond.add(k);
  }
  for (const c of delta.conditionsRemove ?? []) {
    const k = c.trim().toLowerCase();
    if (k) cond.delete(k);
  }
  return {
    hp: clampSlot({
      current: stat.hp.current + (delta.hp ?? 0),
      max: stat.hp.max,
    }),
    stamina: clampSlot({
      current: stat.stamina.current + (delta.stamina ?? 0),
      max: stat.stamina.max,
    }),
    willpower: clampSlot({
      current: stat.willpower.current + (delta.willpower ?? 0),
      max: stat.willpower.max,
    }),
    // 上限防 LLM 把状态列表刷爆(常见就 3-5 个,>20 强制截断保最近添加的)
    conditions: Array.from(cond).slice(-20),
  };
}

/**
 * 满状态构造器。level 决定上限缩放:
 *   - 主角(level 概念不适用,固定基准):传 1
 *   - 队友(CompanionEntry.level):传该值
 *   - 等级 1 = 100 / 100 / 100,每级 +20 上限
 *   - 上限 200(level 6 触顶)— 防止过度数值膨胀
 *
 * 战锤设定下意志槽对玩家很重要(混沌腐化),意志上限跟 HP 同步缩放(不额外区分)。
 */
export function makeFullCombatStat(level: number): CombatStat {
  const lvl = Math.max(1, Math.min(6, Math.floor(level)));
  const cap = 100 + (lvl - 1) * 20; // 1→100, 2→120, ..., 6→200
  return {
    hp: { current: cap, max: cap },
    stamina: { current: cap, max: cap },
    willpower: { current: cap, max: cap },
    conditions: [],
  };
}

/** 主角的基础 stats(level 固定 1)。 */
export function makePlayerCombatStat(): CombatStat {
  return makeFullCombatStat(1);
}

/**
 * 把 CombatStat 翻译给 LLM 看的 markdown 段。
 * 暴露精确数字 + tier 描述 — LLM 决定如何叙事化。
 *
 * 例子输出:
 *
 *   - HP: 75/120 (良好)
 *   - 体力: 30/120 (受损,气喘)
 *   - 意志: 100/120 (充沛)
 */
export function describeStatsForLlm(stat: CombatStat): string {
  const lines = [
    `- HP: ${stat.hp.current}/${stat.hp.max} (${tierOf(stat.hp)})`,
    `- 体力: ${stat.stamina.current}/${stat.stamina.max} (${tierOf(stat.stamina)})`,
    `- 意志: ${stat.willpower.current}/${stat.willpower.max} (${tierOf(stat.willpower)})`,
  ];
  if (stat.conditions && stat.conditions.length > 0) {
    lines.push(`- 持续状态: ${stat.conditions.join(', ')}`);
  }
  return lines.join('\n');
}

/** Stat 是否全部触底(HP+stamina+will 全 0 → 玩家彻底倒下)。 */
export function isAllSlotsZero(stat: CombatStat): boolean {
  return stat.hp.current === 0 && stat.stamina.current === 0 && stat.willpower.current === 0;
}

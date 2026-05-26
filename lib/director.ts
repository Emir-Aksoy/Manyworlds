/**
 * Director Agent prompt + JSON 解析
 * ==================================
 *
 * Director 是剧本里的"导演" — 不是 NPC,负责推进剧情节拍。
 *
 * 两种模式:
 *   1. 结构化(剧本有 scenes 骨架):LLM 输出 JSON,包含 narration + triggeredBeatIds + trustDeltas + moveToScene
 *   2. 自由(无骨架):产 1-3 段叙事文本,旧行为
 */

import type { Scene, Beat } from './scenarios';
import type { CombatStat } from './combat-stats';
import { buildCombatStateInstructions, buildWcEventInstructions } from './llm-events';

// ─── I-series:Director 共用的"玩家身份 + 愿望"提示块 ────────────────

/**
 * Director 看玩家的视角(跟 NPC 不同 — Director 是"世界",负责让剧情自然反映玩家的身份和愿望)。
 */
export interface DirectorPlayerCtx {
  playerIdentity?: {
    mode: 'soul' | 'body';
    displayName: string;
    gender: 'male' | 'female' | 'other' | 'unspecified';
    age: number;
    background: string;
    bodyEntryContext?: string;
  };
  wishes?: {
    granted: string[];
    denied: string[];
  };
}

/**
 * Director 共用的「战斗数值 + 不可逆事件 + 动态地点」上下文。
 *   - stats / subjectNames:主角 + 携带队友的隐藏数值(WC-STAT 输入)
 *   - carriedCompanions / carriedItems:死亡 / 损毁的白名单(WC-EVENT 输入)
 *   - locations:动态剧本的地点列表(WC-EVENT location-changed 用)
 *   - currentLocationId:玩家此刻在哪
 *   - milestonesEnabled:动态完成度开关(scenario.targetMilestones > 0)
 */
export interface DirectorCombatCtx {
  stats?: Record<string, CombatStat>;
  subjectNames?: Record<string, string>;
  carriedCompanions?: Array<{ id: string; name: string }>;
  carriedItems?: Array<{ id: string; name: string }>;
  locations?: Array<{ id: string; name: string; description?: string }>;
  currentLocationId?: string | null;
  milestonesEnabled?: boolean;
}

/**
 * 渲染 Director 视角下的 WC-STAT + WC-EVENT 说明段。
 * 与 NPC chat 路径不同的关键:Director 是 JSON 输出,所以注释要塞在 narration 字符串内部。
 *
 * 返回空字符串 = 没有上下文(剧本无战斗 / 没带队友),不注入此段保持简洁。
 */
function renderDirectorWcInstructions(combatCtx?: DirectorCombatCtx): string {
  if (!combatCtx) return '';
  const {
    stats,
    subjectNames,
    carriedCompanions,
    carriedItems,
    locations,
    currentLocationId,
    milestonesEnabled,
  } = combatCtx;
  const hasStats = stats && Object.keys(stats).length > 0;
  const hasDeathTargets =
    (carriedCompanions && carriedCompanions.length > 0) ||
    (carriedItems && carriedItems.length > 0);
  const hasLocations = !!(locations && locations.length > 0);
  if (!hasStats && !hasDeathTargets && !hasLocations && !milestonesEnabled) return '';

  const parts: string[] = ['', '# 不可逆世界事件标记(WC-STAT / WC-EVENT)', ''];
  parts.push(
    '你的 narration 经常会描述战斗 / 受伤 / 物品损毁 / 队友死亡 / 玩家移动到新地点 / 关键剧情转折等事件。',
    '游戏引擎需要这些事件落地为世界状态变化。**请把 HTML 注释标记直接塞在 narration 字符串内部**(JSON 字符串的末尾即可,JSON 字符串里允许任意字符)。',
    '',
    '**示例(注意是写在 `"narration": "..."` 引号内,不是 JSON 之外)**:',
    '```json',
    '{',
    '  "narration": "你跟随商队走了三天三夜,长安城墙的轮廓在朝霞里浮现。\\n\\n<!-- WC-EVENT location-changed value=changan reason=\\"商队抵达\\" -->",',
    '  "triggeredBeatIds": [],',
    '  "trustDeltas": []',
    '}',
    '```',
    '',
    '注意:注释里的双引号要转义成 `\\"`,这是合法 JSON。引擎会从 narration 里抓出标记并清理后再展示给玩家。',
  );

  if (hasStats) {
    const combatInstr = buildCombatStateInstructions({
      stats: stats!,
      subjectNames: subjectNames ?? {},
    });
    if (combatInstr) parts.push(combatInstr);
  }
  // 把 carriedCompanions/Items + locations + milestonesEnabled 都塞进 buildWcEventInstructions
  // (它内部按需启用子模块)
  if (hasDeathTargets || hasLocations || milestonesEnabled) {
    const wcInstr = buildWcEventInstructions({
      carriedCompanions: carriedCompanions ?? [],
      carriedItems: carriedItems ?? [],
      locations,
      currentLocationId,
      milestonesEnabled,
    });
    if (wcInstr) parts.push(wcInstr);
  }

  return parts.join('\n');
}

/**
 * 把玩家身份段渲染成 Director 视角的文本。空字符串表示没有身份信息(向后兼容)。
 */
function renderPlayerIdentityForDirector(
  pi: DirectorPlayerCtx['playerIdentity'],
): string {
  if (!pi) return '';
  const ageStr = pi.age > 0 ? `,年龄约 ${pi.age} 岁` : '';
  const genderStr =
    pi.gender === 'male' ? ',男性' : pi.gender === 'female' ? ',女性' : '';
  if (pi.mode === 'soul') {
    return `# 玩家身份(本世界视角)
玩家化身为 **${pi.displayName}**(本世界的人${genderStr}${ageStr})。
${pi.background}
你的叙事应该假设玩家本就属于这个世界 — NPC 不会觉得他/她突兀,环境也是他/她熟悉的。`;
  }
  // body
  const bodyCtx =
    pi.bodyEntryContext && pi.bodyEntryContext.trim()
      ? `他/她出现在此世界的经过:${pi.bodyEntryContext.trim()}`
      : pi.background;
  return `# 玩家身份(异世界访客视角)
玩家是 **${pi.displayName}** —— 来自另一个世界的访客(${pi.gender === 'male' ? '男性' : pi.gender === 'female' ? '女性' : '不限性别'}${ageStr})。
${bodyCtx}
**叙事关键**:玩家对本世界的常识可能不熟,NPC 可能感到他/她的言行陌生。世界对他/她有微妙的排异感 — 这个张力是 body 模式的核心。你的 narration 可以让环境(空气、动物、技术、口音)对玩家展现出"不太对劲"的细节。`;
}

/**
 * 把愿望段渲染成 Director 视角的文本(只列 granted — Director 主要任务是让被批准的愿望自然成真)。
 */
function renderWishesForDirector(wishes: DirectorPlayerCtx['wishes']): string {
  if (!wishes || wishes.granted.length === 0) return '';
  return `# 玩家被命运批准的祈愿(让它们逐步、自然地显现)
${wishes.granted.map((w) => `- ${w}`).join('\n')}
**规则**:不要在叙事里直接列愿望,不要用"命运""祈愿""愿望"等元词。
让它们在合适的时机以**自然事件**形式发生 — 不是"愿望成真"而是"事情就是这样发生了"。
当下场景未必能立刻触发某条愿望,**别强行硬塞** — 等合适的节点再让它显现。`;
}

// ─── 结构化模式 ──────────────────────────────────────────────────

export function buildStructuredDirectorPrompt(
  scenarioName: string,
  scenarioDescription: string,
  npcRoster: string,
  currentNpcName: string,
  currentScene: Scene | undefined,
  pendingBeats: Beat[],
  extraCtx?: DirectorPlayerCtx,
  combatCtx?: DirectorCombatCtx,
): string {
  const playerBlock = renderPlayerIdentityForDirector(extraCtx?.playerIdentity);
  const wishesBlock = renderWishesForDirector(extraCtx?.wishes);
  const sceneBlock = currentScene
    ? `# 当前场景
${currentScene.name} — ${currentScene.description}`
    : '# 当前场景\n(未指定)';

  const beatsBlock =
    pendingBeats.length > 0
      ? '# 未完成的 beat 列表(只能从这里挑触发,id 必须严格一致)\n' +
        pendingBeats
          .map(
            (b) =>
              `- [${b.type}] ${b.id}\n  说明:${b.summary}\n  触发条件:${b.triggerHint}`,
          )
          .join('\n')
      : '# 未完成 beat\n(本 scene 所有 beat 都已完成,你可以输出 moveToScene 切到下一个 scene)';

  // 抽出 checkpoint beats(给玩家"指方向"用)和 optional(supporting)
  const pendingCheckpoints = pendingBeats.filter((b) => b.type === 'checkpoint');
  const pendingOptionals = pendingBeats.filter((b) => b.type === 'optional');
  const objectiveBlock =
    pendingCheckpoints.length > 0
      ? '# 当前主线目标(玩家应该朝这个方向走,但你不能替他做)\n' +
        pendingCheckpoints
          .map((b) => `- ${b.summary}\n  自然提示:${b.triggerHint}`)
          .join('\n')
      : '# 当前主线目标\n(本 scene 主线已完成,可以输出 moveToScene 推进到下一场景)';

  return `你是这个剧本的世界观引导员。你不是 NPC,不是命令玩家的导演 — 你是世界本身,
当玩家无所适从、需要一个方向时,你**用世界观允许的方式**让方向自然浮现。

# 你的核心职责
1. **指出目标方向**(不替玩家行动):让玩家知道"接下来世界期待我去做什么",但**永远是玩家自己决定要不要去做**
2. **按世界观推进**:用符合本剧本设定的自然方式 — 比如 NPC 走过来主动说一句话、远处传来某个声音、玩家口袋里的信引起注意、Bao 在通讯里催了一句 —— 而不是强行让玩家做某事
3. **尊重玩家自由度**:玩家可以完全无视你给的方向,选择自己的路。世界不会因此停摆,只是会有自然的代价 / 错过 / 偏离

# 关键约束
- ❌ 不要写"玩家做了 / 玩家说 / 玩家走向"等替玩家行动的句子
- ❌ 不要给玩家选择题("是否要 A 或 B")— 玩家自己会想自己的方式
- ✅ 让世界**自然地暴露目标**:NPC 一句话、环境一个细节、伏笔一闪
- ✅ 玩家可以不按主线走 — 那就让 optional beats 或 trust 变化来回应

# 当前剧本
${scenarioName} —— ${scenarioDescription}

${sceneBlock}

${playerBlock}

${objectiveBlock}

${wishesBlock}

${
  pendingOptionals.length > 0
    ? '# 可选支线(玩家做到了就触发,做不到不影响主线)\n' +
      pendingOptionals
        .map((b) => `- ${b.summary}(条件:${b.triggerHint})`)
        .join('\n')
    : ''
}
${renderDirectorWcInstructions(combatCtx)}

# 剧本可用 NPC 名单(引入时只能从这里挑)
${npcRoster}

# 玩家当前对话伙伴
${currentNpcName}

# 输出格式(强制)

只输出一个 \`\`\`json\`\`\` 代码块,块前块后无任何文字:

\`\`\`json
{
  "narration": "1-2 段第三人称叙事。让世界本身自然地暴露主线方向 — 通过 NPC 的一句话、环境的一个细节、远处的一个动静。不要替玩家行动,不要给选择题,不要总结剧本设定。中文。",
  "triggeredBeatIds": ["beat-id-1"],
  "trustDeltas": [
    { "npcId": "<某 NPC character_id>", "delta": -5, "reason": "玩家在他面前说了刻薄话" }
  ],
  "moveToScene": null
}
\`\`\`

# triggeredBeatIds 规则
- 看最近对话 + 玩家行动,是否恰好满足上面 beat 的触发条件
- id 必须**逐字一致**;一次最多 1-2 个
- 大部分情况是 [] — 主动推进时玩家通常还没行动,beat 不会被触发
- 仅当 narration 中"自然推进了一拍"(比如 NPC 主动说出关键信息,让玩家被动获得 beat),才标记

# trustDeltas 规则
- 单次变动绝对值 ≤ 8
- npcId 必须是 NPC 名单里某个 character_id
- 不变就 []

# moveToScene 规则
- 默认 null
- 只有本 scene 所有 checkpoint 已完成时,才能填下一个 scene id
- 否则保持 null,等玩家行动自然推进

# 叙事规则
- 1-2 段,简洁有画面感
- 引入 NPC 用 *...* 标注动作
- 不要 emoji,不要写"叙事:"前缀
- **绝不**写"玩家做了 X"— 玩家是主体,你只描述世界`;
}

// ─── C3 行动反应模式 ─────────────────────────────────────────────

/**
 * Director 的"反应"模式 — 玩家在 ⚡ 行动 tab 描述了自己要做什么,
 * Director 描述世界(NPC + 环境)对这个行动的反应。
 *
 * 跟"结构化推进模式"的差别:
 *   - 推进模式:Director 是导演,主动产剧情节拍
 *   - 反应模式:Director 是世界,被动回应玩家做的事
 *
 * 关键:不要替玩家做决定,不要"推进"主线,只描述自然的因果反应。
 * Beat 触发仍然评估 — 因为玩家行动可能恰好满足某个 beat 的 triggerHint。
 */
export function buildActionReactionPrompt(
  scenarioName: string,
  scenarioDescription: string,
  npcRoster: string,
  presentNpcs: string,
  currentScene: Scene | undefined,
  pendingBeats: Beat[],
  playerAction: string,
  extraCtx?: DirectorPlayerCtx,
  combatCtx?: DirectorCombatCtx,
): string {
  const playerBlock = renderPlayerIdentityForDirector(extraCtx?.playerIdentity);
  const wishesBlock = renderWishesForDirector(extraCtx?.wishes);
  const sceneBlock = currentScene
    ? `# 当前场景
${currentScene.name} — ${currentScene.description}`
    : '# 当前场景\n(未指定)';

  const beatsBlock =
    pendingBeats.length > 0
      ? '# 此 scene 未完成的 beats(如果玩家行动恰好满足某个,加进 triggeredBeatIds,id 必须严格一致)\n' +
        pendingBeats
          .map(
            (b) =>
              `- [${b.type}] ${b.id}\n  说明:${b.summary}\n  触发条件:${b.triggerHint}`,
          )
          .join('\n')
      : '# 未完成 beats\n(本 scene beats 都已完成)';

  return `你是这个剧本的世界本身,不是任何 NPC,也不是导演。
你的任务:玩家刚刚做了一件事,你**描述世界对这个行动的反应**。

# 关键原则
- **你不主动推进剧情**。玩家想干什么,你只描述自然的因果反应,不要把玩家拽回主线
- **不要替玩家说话 / 做决定 / 做选择**。玩家可能不按剧本走,这是允许的
- **NPC 会按各自人设反应**。如果玩家做的事得罪了某个 NPC,描述他/她的反应
- **环境有物理 / 物理之外的因果**。火扑过来人会被烫,你不能说"玩家躲开了"(那是玩家自己说的)
- **保持克制**。1-2 段就好,别长篇

# 剧本设定
${scenarioName} —— ${scenarioDescription}

${sceneBlock}

${playerBlock}

# 当前在场的 NPC(他们可能对玩家行动有反应)
${presentNpcs || '(无人在场)'}

# 剧本全员 NPC 名单(其他 NPC 不在身边,但你可以引用其名字)
${npcRoster}

${beatsBlock}

${wishesBlock}
${renderDirectorWcInstructions(combatCtx)}

# 玩家刚刚做了
${playerAction}

# 输出格式(强制)

只输出一个 \`\`\`json\`\`\` 代码块,块前块后无任何文字:

\`\`\`json
{
  "narration": "1-2 段第三人称叙事,描述世界 + NPC 对玩家行动的反应。中文。不要替玩家做决定,不要主动推进剧情。",
  "triggeredBeatIds": ["beat-id-1", "..."],
  "trustDeltas": [
    { "npcId": "<NPC character_id>", "delta": -3, "reason": "玩家在他面前撕了对方的信" }
  ]
}
\`\`\`

# triggeredBeatIds 规则
- 玩家的"行动"恰好满足上面 beat 的触发条件 → 加进数组
- id 必须**逐字一致**(包括连字符)
- 大多数情况下应该是 [] —— 玩家自由探索时不一定每次都触发 beat
- 一次最多 1-2 个

# trustDeltas 规则
- 单次变动绝对值 ≤ 8(剧烈冲突 +/- 6,普通 +/- 1-2)
- npcId 必须是上面 NPC 名单里某一个
- 玩家行动没影响关系时返回 []

# 叙事规则
- 1-2 段,有画面感,避免长篇
- 引入 NPC 时用 *...* 标注动作
- 不要 emoji
- 不要写"叙事:"或类似前缀
- 不要替玩家说话(玩家自己说的话不要替他续);玩家没说的话也不要硬塞给他`;
}

// ─── 自由模式(旧行为)──────────────────────────────────────────

export function buildFreeDirectorPrompt(
  scenarioName: string,
  scenarioDescription: string,
  npcRoster: string,
  currentNpcName: string,
): string {
  return `你现在是这个剧本的 Director,不是任何具体 NPC。基于当前对话,用 1-3 段简洁的第三人称叙述推进剧情:
- 描述时间或场景的变化、引入新人物或事件、给玩家提供新的选择或冲突
- 不要重复已经发生的事情,不要替玩家做决定
- 如果有 NPC 登场,用 *...* 标注其外貌动作
- 用中文叙述。直接写叙事内容,不要写"叙事:"或类似前缀
- 引入新 NPC 时,只能从下面这个剧本可用 NPC 名单里挑(不要凭空捏造新角色,否则系统生不出立绘)

# 当前剧本
${scenarioName} —— ${scenarioDescription}

# 剧本可用 NPC 名单
${npcRoster}

# 玩家当前对话伙伴
${currentNpcName}`;
}

// ─── JSON 解析 ───────────────────────────────────────────────────

export interface DirectorOutput {
  narration?: unknown;
  triggeredBeatIds?: unknown;
  trustDeltas?: unknown;
  moveToScene?: unknown;
}

/**
 * 从 Director 响应里挖 JSON 块,容错:
 *   - ```json``` 围栏
 *   - 裸 JSON
 *   - 解析失败返 null,调用方应 fallback 到把整段当 narration
 */
export function parseDirectorJson(text: string): DirectorOutput | null {
  const candidates: string[] = [];
  const jsonFenceRe = /```\s*json\s*\n?/gi;
  let m: RegExpExecArray | null;
  while ((m = jsonFenceRe.exec(text)) !== null) {
    const fromIdx = m.index + m[0].length;
    const c = scanBalancedJson(text, fromIdx);
    if (c) candidates.push(c);
  }
  if (candidates.length === 0) {
    const c = scanBalancedJson(text, 0);
    if (c) candidates.push(c);
  }
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj === 'object') return obj as DirectorOutput;
    } catch {
      // 继续试下一个
    }
  }
  return null;
}

/** 复用 scenario-import.ts 里那套 balanced-brace 扫描(避免循环依赖,这里独立写一份)。 */
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
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

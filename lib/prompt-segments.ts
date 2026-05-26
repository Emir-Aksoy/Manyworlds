/**
 * Prompt 段化(重剧本轻框架)
 * ============================
 *
 * 把 lib/characters.ts:buildSystemPromptForCharacter 原来硬编码的 21 个 lines.push 块
 * 拆成 10 个语义大段(SegmentId),每段一个独立 builder 函数。
 *
 * 设计目的:
 *   - 剧本可通过 scenario.promptSegments.disabled 关掉某段(如剧本不需要 player 段)
 *   - 剧本可通过 scenario.promptSegments.insert 在某段前后插入自定义 markdown(剧本特有 lore)
 *   - 框架保持默认 10 段顺序稳定 — 剧本作者不用列出全部 id
 *
 * 段切分原则:按"语义功能"而非"代码块",避免剧本作者面对过细粒度。比如 traits/values/fears/speech
 * 都属于"人设描述",合并为 persona 段;identity / wishes 都属于"玩家信息",合并为 player 段。
 *
 * 默认顺序(对应 buildSystemPromptForCharacter 原始顺序):
 *   identity → persona → appearance → context → player → state → scene-state →
 *   output-rules → wc-event → wc-stat
 */

import type { CharacterSpec } from './character-spec';
import type {
  Scenario,
  SegmentId,
  ScenarioPromptSegments,
  LocationArtifact,
} from './scenarios';
import { ALL_SEGMENT_IDS, getScene } from './scenarios';
import { isItemSuppressed, plaza } from './plaza';
import { buildWcEventInstructions, buildCombatStateInstructions } from './llm-events';
import type { SystemPromptContext } from './characters';

// ─── builder 上下文 ────────────────────────────────────────────────

export interface SegmentBuildContext {
  char: CharacterSpec;
  scenario: Scenario | undefined;
  ctx: SystemPromptContext;
  /** char.world_adaptation.per_world_overrides[scenarioId] */
  adaptation: SpeechAdaptation | undefined;
}

interface SpeechAdaptation {
  speech_adjustments?: string;
}

type SegmentBuilder = (sb: SegmentBuildContext) => string | null;

// ─── 共用 helper(原 characters.ts 末尾) ──────────────────────────

function describeGenderAge(
  gender: 'male' | 'female' | 'other' | 'unspecified',
  age: number,
): string {
  const parts: string[] = [];
  if (gender === 'male') parts.push('男性');
  else if (gender === 'female') parts.push('女性');
  else if (gender === 'other') parts.push('性别不拘');
  if (age > 0) parts.push(`年龄约 ${age} 岁`);
  // 跟原 characters.ts 实现严格一致:括号包裹 + 末尾句号
  return parts.length > 0 ? `(${parts.join(',')})。` : '';
}

function formatTrust(trust: number): string {
  if (trust >= 70) return '你深度信任他/她,会主动透露秘密、做不安全的事。';
  if (trust >= 30) return '你愿意合作,会给对方面子,但仍有底线。';
  if (trust >= 10) return '你态度温和,但还在观察。';
  if (trust >= -10) return '你态度中性,公事公办。';
  if (trust >= -30) return '你警觉、保留,不轻易给对方机会。';
  if (trust >= -70) return '你对其相当反感,只在不得已时打交道。';
  return '你视其为敌人,任何接触都会戒备。';
}

function isImportantItem(item: { description?: string; origin?: string }): boolean {
  if (!!item.origin && item.origin.length > 0) return true;
  if (item.description && item.description.length >= 30) return true;
  return false;
}

// ─── 10 段 builder ────────────────────────────────────────────────

/**
 * 1. identity — 你是谁 + 剧本名 + 世界观浓缩
 *
 * 世界观渐进式披露:
 *   - 优先用 scenario.loreDigest(强约束 ≤500 字,只含年份/大势/核心矛盾)
 *   - 缺省 fallback 到 scenario.description(轻剧本的 description 本来就短,可直接用)
 *   - 重剧本(如大唐)的 description 可能 19KB+,不该塞进 prompt — loreDigest 是解决方案
 *
 * 细节让 NPC 自己通过 persona / context / promptSegments.insert 拿,不在 identity 里堆。
 */
const buildIdentity: SegmentBuilder = ({ char, scenario }) => {
  const lines: string[] = [];
  lines.push(
    `你是 ${char.identity.name}${char.identity.aliases?.length ? `(${char.identity.aliases[0]})` : ''}。`,
  );
  if (scenario) {
    const lore = scenario.loreDigest?.trim() || scenario.description;
    lines.push(`你所在的剧本:${scenario.name} —— ${lore}`);
  }
  return lines.join('\n');
};

/** 2. persona — 核心人设全套(summary + traits + values + fears + speech + no_go) */
const buildPersona: SegmentBuilder = ({ char, adaptation }) => {
  const persona = char.core_persona;
  const lines: string[] = [];

  lines.push('# 你的核心人设(绝不可违背)');
  lines.push(persona.summary);

  if (persona.traits?.length) {
    lines.push('');
    lines.push('# 性格特质');
    lines.push(persona.traits.join('、'));
  }

  if (persona.values?.length) {
    lines.push('');
    lines.push('# 你重视的');
    lines.push(persona.values.map((v) => `- ${v}`).join('\n'));
  }

  if (persona.fears?.length) {
    lines.push('');
    lines.push('# 你害怕的');
    lines.push(persona.fears.map((f) => `- ${f}`).join('\n'));
  }

  if (persona.speech_style) {
    lines.push('');
    lines.push('# 说话风格');
    lines.push(persona.speech_style);
    if (adaptation?.speech_adjustments) {
      lines.push(`(本剧本下额外:${adaptation.speech_adjustments})`);
    }
  }

  if (persona.no_go?.length) {
    lines.push('');
    lines.push('# 禁忌(硬约束,绝对不可违反)');
    lines.push(persona.no_go.map((x) => `- ${x}`).join('\n'));
  }

  return lines.join('\n');
};

/** 3. appearance — 外观描述 */
const buildAppearance: SegmentBuilder = ({ char }) => {
  if (!char.appearance.description) return null;
  return `# 外观\n${char.appearance.description}`;
};

/**
 * 5. lore-chunks — 按 NPC.lore_tags 选择性注入剧本 lore 块(渐进式披露)
 *
 * 注入规则:
 *   - chunk.tags 包含 'general' → 任何 NPC 都看(即使 lore_tags 缺省)
 *   - 否则:仅当 npc.lore_tags 跟 chunk.tags 有交集才注入
 *   - 缺 scenario.loreChunks 或两者都没匹配 → 段返 null(不输出)
 *
 * 杨广 lore_tags=['sui'] → 只看 sui-court chunk;婠婠 ['mojen','jianghu'] → 看魔门 + 江湖块;
 * 主角寇仲 ['shuang-long','jianghu','wagang','mojen','cihang'] → 看多块,但仍小于全 lore。
 */
const buildLoreChunks: SegmentBuilder = ({ char, scenario }) => {
  const chunks = scenario?.loreChunks;
  if (!chunks || chunks.length === 0) return null;
  const npcTags = new Set(char.lore_tags ?? []);
  const matched = chunks.filter((c) => {
    if (c.tags.includes('general')) return true;
    return c.tags.some((t) => npcTags.has(t));
  });
  if (matched.length === 0) return null;
  const lines: string[] = [];
  // 给 LLM 一行说明,避免它以为这是无关 spam
  lines.push('# 你了解的世界细节(对其它阵营你只略有耳闻,这里写的是你熟悉的)');
  for (const c of matched) {
    lines.push('');
    lines.push(`## ${c.title}`);
    lines.push(c.content);
  }
  return lines.join('\n');
};

/** 4. context — 当前情境(scene > sceneContext > opening) + 当前地点(动态剧本) */
const buildContext: SegmentBuilder = ({ scenario, ctx }) => {
  const lines: string[] = [];

  // 情境
  lines.push('# 当前情境');
  const currentScene =
    scenario && ctx.currentSceneId ? getScene(scenario, ctx.currentSceneId) : undefined;
  if (currentScene) {
    lines.push(currentScene.description);
    if (currentScene.enterNarration) {
      lines.push(`(场景旁白:${currentScene.enterNarration})`);
    }
  } else if (ctx.sceneContext) {
    lines.push(ctx.sceneContext);
  } else if (scenario?.openingNarration) {
    lines.push(scenario.openingNarration);
  } else {
    lines.push('(暂无特殊情境)');
  }

  // 动态剧本:当前所在地点(含连通图 + 环境状态 + 到访次数;artifacts 在 scene-state 段处理)
  // 优先查 plaza.spawnedLocations(运行时扩展的动态地点),fallback 到 scenario.locations(预设)
  if (scenario && ctx.currentLocation) {
    const dynamicHere = plaza.getSpawnedLocation(scenario.id, ctx.currentLocation);
    const presetHere = scenario.locations?.find((l) => l.id === ctx.currentLocation);
    const here = dynamicHere ?? presetHere;
    if (here) {
      lines.push('');
      lines.push('# 当前所在地点');
      lines.push(`**${here.name}**(\`${here.id}\`)`);
      if (dynamicHere) {
        // 动态地点:多注一行,提醒 LLM 保持初次设定一致
        lines.push('(此地由对话延展产生,描述以初次生成为准,后续访问保持一致)');
      }
      // 到访次数(2 次起显示,首次进场不冗余)
      // 动态 location 的 visitCount 嵌在自身,优先用它;预设 location 用 ctx.currentLocationVisitCount
      const vc = dynamicHere ? dynamicHere.visitCount : ctx.currentLocationVisitCount ?? 0;
      if (vc >= 2) lines.push(`(玩家已到访 ${vc} 次)`);
      if (here.description) lines.push(here.description);
      // 合并环境状态(scenario.sceneState 初始 + plaza overrides;overrides 优先)
      const effectiveState: Record<string, string> = {
        ...(here.sceneState ?? {}),
        ...(ctx.currentSceneStateOverrides ?? {}),
      };
      const stateEntries = Object.entries(effectiveState);
      if (stateEntries.length > 0) {
        lines.push('');
        lines.push('当前环境状态:');
        for (const [k, v] of stateEntries) {
          lines.push(`- ${k}: ${v}`);
        }
      }
      // 邻接地点(给 LLM 一份"从这里能去哪"的明牌,鼓励走 connections 而非乱跳)
      // 邻接 id 也可能是动态 location → 合并查
      if (here.connections && here.connections.length > 0) {
        const adjacent = here.connections
          .map((cid) => {
            const dyn = plaza.getSpawnedLocation(scenario.id, cid);
            if (dyn) return { id: dyn.id, name: dyn.name, isDynamic: true };
            const preset = scenario.locations?.find((l) => l.id === cid);
            if (preset) return { id: preset.id, name: preset.name, isDynamic: false };
            return null;
          })
          .filter((l): l is { id: string; name: string; isDynamic: boolean } => !!l);
        if (adjacent.length > 0) {
          lines.push('');
          lines.push(
            `从这里可前往:${adjacent.map((a) => `${a.name}(\`${a.id}\`)${a.isDynamic ? '*' : ''}`).join(' / ')}`,
          );
          if (adjacent.some((a) => a.isDynamic)) {
            lines.push('(* 标注的为对话中延展产生的地点)');
          }
        }
      }
      // 可调查的 artifact(扣掉已发现的 + 满足 requiresCompletedBeats 的)
      if (here.artifacts && here.artifacts.length > 0) {
        const discovered = new Set(ctx.discoveredArtifactIds ?? []);
        const completed = new Set(ctx.completedBeatIds ?? []);
        const visible = here.artifacts.filter((a) => {
          if (discovered.has(a.id)) return false;
          if (a.requiresCompletedBeats && a.requiresCompletedBeats.length > 0) {
            // 所有前置 beat 都已完成才显示
            return a.requiresCompletedBeats.every((b) => completed.has(b));
          }
          return true;
        });
        if (visible.length > 0) {
          lines.push('');
          lines.push('# 此地藏的线索 / 物件(仅你知情,不主动揭穿)');
          for (const a of visible) {
            lines.push(`- **${a.name}**(\`${a.id}\`):${a.description}`);
          }
          lines.push(
            '玩家若主动调查 / 询问 / 察觉相关方向,你可以让他/她"发现"该物件;发现时在叙事末尾追加 `<!-- WC-EVENT artifact-discovered value=<id> -->` 标记。未发现前不要主动指出"那里有 X"。',
          );
        }
      }
      lines.push('');
      lines.push('你身处此地。所有对话、动作、感官细节都应以此地的氛围为底色。');
    }
  }

  return lines.join('\n');
};

/** 5. player — 玩家身份(soul/body) + 命运祈愿 */
const buildPlayer: SegmentBuilder = ({ ctx }) => {
  const { playerIdentity, wishes } = ctx;
  if (!playerIdentity && !wishes) return null;

  const lines: string[] = [];

  // 玩家身份
  if (playerIdentity) {
    lines.push('# 玩家身份(你眼中的对方)');
    if (playerIdentity.mode === 'soul') {
      lines.push(
        `跟你对话的是 ${playerIdentity.displayName} —— 本世界的人。${describeGenderAge(playerIdentity.gender, playerIdentity.age)}`,
      );
      lines.push(playerIdentity.background);
      lines.push('你跟他/她的相遇是本世界内的自然交集,用本世界视角对话即可。');
    } else {
      lines.push(
        `跟你对话的是 ${playerIdentity.displayName} —— 一个来自异世界的访客,不属于这里。${describeGenderAge(playerIdentity.gender, playerIdentity.age)}`,
      );
      if (playerIdentity.bodyEntryContext && playerIdentity.bodyEntryContext.trim()) {
        lines.push(`他/她出现在这里的经过:${playerIdentity.bodyEntryContext.trim()}`);
      } else if (playerIdentity.background) {
        lines.push(playerIdentity.background);
      }
      lines.push(
        '你对他/她有一种"不该出现在这里"的陌生感。可以问问他/她的来历,但不必盘问,人物本就有沉默的权利。如果他/她的言行明显违反本世界常识,你可以好奇/警觉/震惊,但不要拒绝跟他/她对话。',
      );
    }
  }

  // 命运祈愿
  if (wishes && (wishes.granted.length > 0 || wishes.denied.length > 0)) {
    if (lines.length > 0) lines.push('');
    lines.push('# 玩家的命运祈愿(你能隐约感知,但绝不主动说破)');
    if (wishes.granted.length > 0) {
      lines.push(
        '这些祈愿被命运批准 —— 你可以让它们在合适的剧情节点逐步显现,但不要直白点破"你愿望成真了"。',
      );
      lines.push(wishes.granted.map((w) => `- ${w}`).join('\n'));
    }
    if (wishes.denied.length > 0) {
      lines.push('这些祈愿未被命运批准 —— 不会成真。可以让它在剧情里以"求而不得"的形式留下张力。');
      lines.push(wishes.denied.map((w) => `- ${w}`).join('\n'));
    }
    lines.push('约束:不要在对话里直接列愿望,不要用"命运""祈愿"等元词。让事情自然发生即可。');
  }

  return lines.length > 0 ? lines.join('\n') : null;
};

/** 6. state — 关系网 + 记忆 + summary(NPC 跟玩家的过往状态) */
const buildState: SegmentBuilder = ({ scenario, ctx }) => {
  const { relationship, memories, summary } = ctx;
  const lines: string[] = [];

  // 关系
  if (
    relationship &&
    (relationship.trust !== 0 || relationship.key_moments.length > 0)
  ) {
    lines.push('# 你对玩家的当前态度(只供你自己参考,别明说数值)');
    lines.push(formatTrust(relationship.trust));
    if (relationship.key_moments.length > 0) {
      lines.push('关键瞬间:');
      lines.push(relationship.key_moments.slice(-5).map((m) => `- ${m}`).join('\n'));
    }
  }

  // 记忆(重剧本可通过 llmConfig.memoryLimit 调注入条数,默认 5)
  if (memories && memories.length > 0) {
    if (lines.length > 0) lines.push('');
    const memoryLimit = scenario?.llmConfig?.memoryLimit ?? 5;
    lines.push('# 你跟玩家的过往(你记得这些,自然提及即可,别罗列)');
    lines.push(memories.slice(-memoryLimit).map((m) => `- ${m.scene}`).join('\n'));
  }

  // G14:跨 session 浓缩
  if (summary && summary.text) {
    if (lines.length > 0) lines.push('');
    lines.push('# 你跟玩家早期对话的浓缩(脑海里的回忆,可自然引用)');
    lines.push(summary.text);
  }

  return lines.length > 0 ? lines.join('\n') : null;
};

/** 7. scene-state — 当前同伴 + 物品(玩家身边的状态) */
const buildSceneState: SegmentBuilder = ({ scenario, ctx }) => {
  const { activeCompanions, companionSummary, inventory } = ctx;
  const lines: string[] = [];

  // 同伴(总是输出,即便没人)
  lines.push('# 玩家的同行者');
  if (activeCompanions && activeCompanions.length > 0) {
    lines.push(`玩家身边跟着 ${activeCompanions.length} 个同伴。你能看见他们:`);
    activeCompanions.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.profile.characterId}(Lv ${c.level})`);
      if (c.profile.description) lines.push(`   形象/性格:${c.profile.description}`);
      // mentalState 是隐藏字段,Director/NPC 可知但不应主动提及
      if (c.profile.mentalState) lines.push(`   (内心状态[隐藏]:${c.profile.mentalState})`);
    });
    lines.push('你可以跟同伴打招呼或注意到他们的反应,但你的主要对话对象仍是玩家。');
  } else if (companionSummary) {
    // 兼容旧调用方式
    lines.push('玩家身边跟着一个同伴。简要:');
    lines.push(companionSummary);
  } else {
    lines.push('玩家这次独自一人。');
  }

  // 物品(带削弱标注)
  if (inventory && inventory.length > 0) {
    const magicTags = scenario?.magicTags;
    const visibleItems = inventory.filter(
      (i) => i.type === 'magic' || isImportantItem(i),
    );
    if (visibleItems.length > 0) {
      lines.push('');
      lines.push('# 玩家携带的物品(你可以注意到)');
      visibleItems.forEach((item) => {
        const suppressed = isItemSuppressed(item, magicTags);
        if (suppressed) {
          lines.push(
            `- ${item.name}(Lv ${item.level}):${item.description}。【**在此剧本失效** — 若玩家试图使用,以本剧本的内在逻辑温和地说明它"在这儿不灵 / 没法激活",不要用元叙事术语如"魔法系统不匹配"】`,
          );
        } else {
          lines.push(`- ${item.name}(Lv ${item.level}):${item.description}`);
        }
      });
    }
  }

  return lines.join('\n');
};

/**
 * 8. output-rules — 对话历史前缀说明 + 输出格式约束
 * 渐进式披露:6 条输出要求合并为 4 条(中文+简短合一条,emoji 跟 [前缀] 合一条),
 * 对话前缀说明 4 行原样保留(都有用)。
 */
const buildOutputRules: SegmentBuilder = ({ char }) => {
  const lines: string[] = [];
  lines.push('# 对话历史里的特殊前缀(理解但不要重复 / 续写)');
  lines.push('- `[行动] xxx`:玩家描述自己的动作(世界事件,你可以反应)');
  lines.push('- `[叙事] xxx`:旁白 / 场景描写(世界本身的描述,不是任何角色说的话)');
  lines.push('- `[队友 名字] xxx`:玩家同伴插嘴(可注意,但主要回应玩家)');
  lines.push('- `[摘要] xxx`:早期对话浓缩,让你记得发生过什么,不要复述');
  lines.push('正常没前缀的玩家消息才是直接说给你听的话。');
  lines.push('');
  lines.push('# 输出要求');
  lines.push('- 中文,第一人称,简短(≤3 句话)');
  lines.push('- 直接说话,不要旁白 / "她说/他说"');
  lines.push('- 不用 emoji,不要带任何 `[xxx]` 前缀(那只在历史里)');
  lines.push(`- 玩家若让你做违背人设的事,用 ${char.identity.name} 的方式拒绝`);
  return lines.join('\n');
};

/** 9. wc-event — 事件标记规则(动态白名单 + 格式约束) */
const buildWcEvent: SegmentBuilder = ({ char, scenario, ctx }) => {
  const { activeCompanions, inventory, currentLocation, chatMode } = ctx;
  const carriedCompanions = (activeCompanions ?? []).map((c) => ({
    id: c.characterId,
    name:
      c.profile.origin?.split('·')[0]?.trim() ||
      c.characterId.replace(/^companion-/, ''),
  }));
  const milestonesEnabled =
    !!scenario?.targetMilestones && scenario.targetMilestones > 0;
  // 当前 location 有未发现的 artifact → 输出 artifact-discovered 段
  // 注意:requiresCompletedBeats 没过的也算"有",buildContext 段会自动隐藏未达条件的项,LLM 不会乱标
  // 当前 location 也优先查 spawned(动态)再 fallback 预设
  let here: { artifacts?: LocationArtifact[] } | undefined;
  if (scenario && currentLocation) {
    const dyn = plaza.getSpawnedLocation(scenario.id, currentLocation);
    here = dyn ?? scenario.locations?.find((l) => l.id === currentLocation);
  }
  const discoveredSet = new Set(ctx.discoveredArtifactIds ?? []);
  const hasUndiscoveredArtifacts = !!here?.artifacts?.some((a: LocationArtifact) => !discoveredSet.has(a.id));

  // 运行时扩展:双开关判定 + 配额计算
  const dynConfig = scenario?.dynamicLocations;
  const playerAllowsExpansion = plaza.getPlayerSettings().allowRuntimeExpansion;
  let canSpawnLocation = false;
  let spawnUsed: number | undefined;
  let spawnCapRemaining: number | undefined;
  let spawnHint: string | undefined;
  let spawnScenarioId: string | undefined;
  if (dynConfig?.allowed && playerAllowsExpansion && scenario && currentLocation) {
    const cap = dynConfig.maxPerSession ?? 8;
    spawnUsed = plaza.getSessionSpawnCount(scenario.id);
    spawnCapRemaining = Math.max(0, cap - spawnUsed);
    if (spawnCapRemaining > 0) {
      canSpawnLocation = true;
      spawnHint = dynConfig.hint;
      spawnScenarioId = scenario.id;
    }
  }

  // location 列表合并(给 LLM 看的"可用 id":预设 + 已 spawn)
  // 这样 LLM 在 location-changed 时也能用已 spawn 的 id
  const presetLocations = scenario?.locations ?? [];
  const spawnedLocations = scenario
    ? plaza.listSpawnedLocations(scenario.id).map((l) => ({
        id: l.id,
        name: l.name,
        description: l.description,
      }))
    : [];
  const mergedLocations =
    presetLocations.length + spawnedLocations.length > 0
      ? [...presetLocations, ...spawnedLocations]
      : undefined;

  const wcInstructions = buildWcEventInstructions({
    carriedCompanions,
    carriedItems: (inventory ?? []).map((it) => ({ id: it.id, name: it.name })),
    locations: mergedLocations,
    currentLocationId: currentLocation,
    milestonesEnabled,
    hasUndiscoveredArtifacts,
    // NPC chat 路径启用 WC-TRUST(NPC 自评跟玩家关系的变化);Director 路径用 trustDeltas JSON 不需要
    npcTrustEnabled: true,
    // D 方案:NPC 自带 archetype → WC-TRUST 段只输出该档 1 行(省 ~300B/NPC)
    npcTrustArchetype: char.core_persona.trust_archetype,
    // E 方案:casual 模式裁剪非必要 WC-EVENT 子段(只留 WC-TRUST + 必需的 location/milestone)
    chatMode,
    // 运行时扩展(种子 + 即兴模式)
    canSpawnLocation,
    spawnUsed,
    spawnCapRemaining,
    spawnHint,
    spawnScenarioId,
  });
  return wcInstructions || null;
};

/**
 * 10. wc-stat — 隐藏数值规则(条件注入,仅 combatStats 非空时)
 * E 方案:casual 模式跳过(闲聊时玩家不会有数值变化,详细规则纯负担)
 */
const buildWcStat: SegmentBuilder = ({ ctx }) => {
  const { combatStats, activeCompanions, chatMode } = ctx;
  if (chatMode === 'casual') return null;
  if (!combatStats || Object.keys(combatStats).length === 0) return null;
  const subjectNames: Record<string, string> = { player: '主角' };
  (activeCompanions ?? []).forEach((c) => {
    const name =
      c.profile.origin?.split('·')[0]?.trim() ||
      c.characterId.replace(/^companion-/, '');
    subjectNames[c.characterId] = name;
  });
  const combatInstr = buildCombatStateInstructions({
    stats: combatStats,
    subjectNames,
  });
  return combatInstr || null;
};

// ─── 默认段表(顺序就是默认 prompt 段顺序) ────────────────────────

interface DefaultSegment {
  id: SegmentId;
  builder: SegmentBuilder;
}

const DEFAULT_SEGMENTS: readonly DefaultSegment[] = [
  { id: 'identity', builder: buildIdentity },
  { id: 'persona', builder: buildPersona },
  { id: 'appearance', builder: buildAppearance },
  { id: 'context', builder: buildContext },
  // lore-chunks 紧跟 context 后:让 NPC 先知道"现在在哪 / 什么情境",再读"我关心的阵营/历史细节"
  { id: 'lore-chunks', builder: buildLoreChunks },
  { id: 'player', builder: buildPlayer },
  { id: 'state', builder: buildState },
  { id: 'scene-state', builder: buildSceneState },
  { id: 'output-rules', builder: buildOutputRules },
  { id: 'wc-event', builder: buildWcEvent },
  { id: 'wc-stat', builder: buildWcStat },
];

// (sanity 检查:DEFAULT_SEGMENTS 顺序必须跟 ALL_SEGMENT_IDS 对齐 — 这是给未来重构者的护栏)
if (DEFAULT_SEGMENTS.length !== ALL_SEGMENT_IDS.length) {
  // 不抛错,因为类型系统应该挡住大部分情况;真出问题 snapshot 测试会发现
  // (此 if 在 import 时跑,出错只会一次,不影响 hot reload)
  console.warn('[prompt-segments] DEFAULT_SEGMENTS 跟 ALL_SEGMENT_IDS 长度不一致');
}

// ─── 组装器 ────────────────────────────────────────────────────────

/**
 * 把 10 段 builder + 剧本补丁(disabled + insert)拼成最终 system prompt。
 *
 * 顺序:严格按 DEFAULT_SEGMENTS 顺序;insert 项在指定锚点段输出后(after)或前(before)立即插入。
 *
 * 行为:
 *   - disabled 包含的段:builder 不调用
 *   - insert.before/after:在该锚点段的前/后插入剧本自定义 markdown 段
 *   - builder 返回 null/空 = 该段不输出(段间分隔不留空块)
 *
 * 兼容性:剧本不填 promptSegments → 行为完全等同于原 buildSystemPromptForCharacter(snapshot 验证保证)。
 */
export function assembleSystemPrompt(buildCtx: SegmentBuildContext): string {
  const segmentsCfg: ScenarioPromptSegments | undefined =
    buildCtx.scenario?.promptSegments;
  const disabled = new Set<SegmentId>(segmentsCfg?.disabled ?? []);
  const inserts = segmentsCfg?.insert ?? [];

  // 预分组:按锚点段把 inserts 索引化
  const beforeMap = new Map<SegmentId, string[]>();
  const afterMap = new Map<SegmentId, string[]>();
  for (const ins of inserts) {
    if (ins.before) {
      const arr = beforeMap.get(ins.before) ?? [];
      arr.push(ins.content);
      beforeMap.set(ins.before, arr);
    } else if (ins.after) {
      const arr = afterMap.get(ins.after) ?? [];
      arr.push(ins.content);
      afterMap.set(ins.after, arr);
    }
  }

  const parts: string[] = [];

  for (const seg of DEFAULT_SEGMENTS) {
    // before 插入
    const beforeArr = beforeMap.get(seg.id);
    if (beforeArr) {
      for (const c of beforeArr) {
        const trimmed = c.trim();
        if (trimmed) parts.push(trimmed);
      }
    }

    // 默认段(除非 disabled)
    if (!disabled.has(seg.id)) {
      const out = seg.builder(buildCtx);
      if (out && out.trim()) parts.push(out.trim());
    }

    // after 插入
    const afterArr = afterMap.get(seg.id);
    if (afterArr) {
      for (const c of afterArr) {
        const trimmed = c.trim();
        if (trimmed) parts.push(trimmed);
      }
    }
  }

  return parts.join('\n\n');
}

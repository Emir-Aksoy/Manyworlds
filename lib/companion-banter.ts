/**
 * 队友插嘴 (Companion Banter)
 * ============================
 *
 * 在玩家跟 NPC 一轮对话后,**异步**判断 active 队友是否该插嘴 + 生成一句话。
 *
 * 走 task='companion.banter' lane(UNIFIED_MATRIX 里 → local_gemma)。
 * 用 local Gemma 跑是因为这是高频低价值判断 — 大多数轮次队友"不插嘴"(返 null),
 * 没必要烧 codex_spark 的钱;Gemma 在本机跑成本接近 0。
 *
 * 频率控制:外部调用方负责频次限制(参考实现:每 3 条消息最多 1 次)。
 */

import { callLLM } from './gateway';
import { plaza, type CompanionEntry } from './plaza';
import type { Scenario } from './scenarios';
import { describeStatsForLlm } from './combat-stats';
import { stripWcEvents } from './llm-events';

export interface BanterDecisionInput {
  companion: CompanionEntry;
  /** 玩家最近发的话 */
  playerMessage: string;
  /** NPC 刚回的话 */
  npcReply: string;
  /** 跟玩家对话的 NPC 名 */
  npcName: string;
  scenario: Scenario | undefined;
}

export interface BanterResult {
  /** 队友最终说的话;null = 不插嘴 */
  line: string | null;
  /** lane / 时长用于 UI 显示(可选) */
  meta?: { laneUsed?: string; durationSec?: number };
  /** 失败信息(不阻断主对话) */
  error?: string;
}

export async function decideAndGenerateBanter(input: BanterDecisionInput): Promise<BanterResult> {
  if (typeof window === 'undefined') {
    return { line: null, error: 'client-only' };
  }
  const { companion, playerMessage, npcReply, npcName, scenario } = input;

  const companionLabel = companion.profile.characterId.replace(/^companion-/, '');

  // 隐藏数值:取当前剧本里主角 + 这个队友自己的状态(只读,banter 不写回)。
  // 没在剧本里(currentCombatStats 为空)时跳过此段。
  const plazaState = plaza.get();
  const selfStat = plazaState.currentCombatStats[companion.characterId];
  const playerStat = plazaState.currentCombatStats.player;
  const hasCombat = !!(selfStat || playerStat);
  const combatBlock = hasCombat
    ? `

# 当前身体状态(玩家不知道,**你不能直接说数字**,但要影响你说话的口气)
${selfStat ? `## 你自己\n${describeStatsForLlm(selfStat)}` : ''}
${playerStat ? `## 玩家\n${describeStatsForLlm(playerStat)}` : ''}

规则:
- 你"自己"危急 → 你可能气喘 / 撑不住,说话短促或带颤
- 玩家危急 → 你想替他撑场 / 拉他撤退,关心多于斗嘴
- 自己持续状态(conditions)会限制你的可能动作(如 broken-left-arm 时不能"拍肩膀")
- 但**绝对不要**说出具体数字,也**绝对不要**在你的输出里写 \`<!-- WC-STAT -->\` 或 \`<!-- WC-EVENT -->\` 这类标记 — 那是主对话流的工作,你只读不写`
    : '';

  const sys = `你是玩家的同伴"${companionLabel}",刚听到玩家跟 ${npcName} 的对话。

# 你是
${companion.profile.description || '(无描述)'}

# 你的内心状态(只你自己知道,**别明说,但会影响你的反应**)
${companion.profile.mentalState || '(无)'}

# 剧本背景
${scenario ? `${scenario.name} — ${scenario.description}` : '(未知)'}
${combatBlock}

# 你的任务:判断要不要插嘴
看刚刚那一轮对话,判断你是否要补一句。**保持克制 — 大多数时候不插嘴**,让玩家发挥。

只在以下情况插嘴:
- 对话提到了你强烈关心的事(吃的 / 安全 / 你恐惧的话题)
- NPC 说了让你不舒服的话,你想给玩家撑腰
- 玩家明显在尴尬 / 卡壳,你帮个台阶
- 场面适合你卖个萌或调侃一下,缓解气氛
${hasCombat ? '- 你自己或玩家身体状态危急,你忍不住关心一句 / 警告一声' : ''}

不要在以下情况插嘴:
- 玩家和 NPC 谈正事,你帮不上忙
- 对话已经把话说完了,你只是想刷存在感
- 你刚刚说过话

# 输出格式(严格)

\`\`\`json
{ "shouldChime": true, "line": "你的一句话(20 字内)" }
\`\`\`

或

\`\`\`json
{ "shouldChime": false }
\`\`\`

只输出一个 JSON 代码块,块外没有任何文字。`;

  const userMsg = `刚刚发生的对话:

玩家: ${playerMessage}
${npcName}: ${npcReply}

你要不要插嘴?如插嘴,只说一句(20 字内)。`;

  let resp;
  try {
    resp = await callLLM({
      task: 'companion.banter',
      systemPrompt: sys,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 200,
      temperature: 0.7,
    });
  } catch (e) {
    return { line: null, error: e instanceof Error ? e.message : String(e) };
  }

  const parsed = extractBanterJson(resp.text);
  const meta = { laneUsed: resp.laneUsed, durationSec: resp.durationSec };
  if (!parsed) {
    // 容错:LLM 没出 JSON 但回了一句话?如果 resp.text 短且看着像台词,直接用
    const trimmed = stripWcEvents(resp.text).trim();
    if (trimmed && trimmed.length <= 40 && !trimmed.includes('{') && !trimmed.includes('}')) {
      // 真的像一句话,接受
      return { line: trimmed, meta };
    }
    return { line: null, meta };
  }
  if (parsed.shouldChime !== true) return { line: null, meta };
  if (typeof parsed.line !== 'string') return { line: null, meta };
  // 保险:即使 LLM 不听话写了 WC-STAT/EVENT 标记,这里也剥掉(banter 只读不写,标记一律忽略)
  const line = stripWcEvents(parsed.line).trim();
  if (!line) return { line: null, meta };
  return { line, meta };
}

// ─── JSON 解析 ───────────────────────────────────────────────────

interface BanterJson {
  shouldChime?: unknown;
  line?: unknown;
}

function extractBanterJson(text: string): BanterJson | null {
  const jsonFenceRe = /```\s*json\s*\n?/gi;
  let m: RegExpExecArray | null;
  while ((m = jsonFenceRe.exec(text)) !== null) {
    const fromIdx = m.index + m[0].length;
    const candidate = scanBalancedJson(text, fromIdx);
    if (candidate) {
      try {
        const obj = JSON.parse(candidate);
        if (obj && typeof obj === 'object') return obj as BanterJson;
      } catch {
        // continue
      }
    }
  }
  // 兜底:裸 JSON
  const candidate = scanBalancedJson(text, 0);
  if (candidate) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object') return obj as BanterJson;
    } catch {
      // ignore
    }
  }
  return null;
}

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

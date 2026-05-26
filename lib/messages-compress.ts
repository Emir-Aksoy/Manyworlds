/**
 * 对话历史压缩 (Messages Compression)
 * ====================================
 *
 * 当某角色的对话历史达到 tier 上限的 80%,把最旧的部分摘要成一段 "summary",
 * 替代原始消息插到 history 开头,让 NPC 仍能"记得"早期发生的事但不占太多 token。
 *
 * 走 task='utility.summary' lane(UNIFIED_MATRIX → codex_spark_bridge)。
 *
 * 压缩算法:
 *  1. 保留最近 keepRecent 条原汁原味的消息
 *  2. 前面的旧消息浓缩成 1 条 [摘要] 前缀的 assistant 消息
 *  3. 若已经有 [摘要] 消息存在,跟新的合并(避免摘要链滚雪球)
 */

import { callLLM } from './gateway';
import type { Message } from './gateway';

/** [摘要] 前缀,UI 渲染时会显示成蓝灰色 system 风格的浓缩条 */
export const SUMMARY_PREFIX = '[摘要] ';

export interface CompressOptions {
  /** 角色名,prompt 里告诉 LLM 主体 */
  characterName: string;
  /** 完整 messages */
  messages: Message[];
  /** 保留最近多少条原始消息(更早的全部摘要) */
  keepRecent: number;
}

export interface CompressResult {
  /** 压缩后的新 messages,头部含 1 条 [摘要] */
  compressed: Message[];
  /** 摘要了多少条原始消息(用于 UI 提示 / 调试) */
  summarized: number;
  /** 摘要文本(不含前缀) */
  summaryText: string;
  meta?: { laneUsed?: string; durationSec?: number };
}

/**
 * 主入口。如果 messages.length ≤ keepRecent + 1,不需要压缩,直接返回原 messages。
 * 失败时(LLM 出错)返回原 messages,不阻断主流程。
 */
export async function compressMessages(opts: CompressOptions): Promise<CompressResult | null> {
  if (typeof window === 'undefined') return null;
  const { characterName, messages, keepRecent } = opts;

  // 已经有 [摘要] 在头部?把它跟接下来要压的合并(避免摘要链堆积)
  const hasExistingSummary =
    messages.length > 0 &&
    messages[0].role === 'assistant' &&
    messages[0].content.startsWith(SUMMARY_PREFIX);

  // 要保留的最近 keepRecent 条
  const tail = messages.slice(-keepRecent);
  // 要被摘要的:头(已有摘要) + 中段
  const headSummary = hasExistingSummary ? messages[0] : null;
  const middleStart = hasExistingSummary ? 1 : 0;
  const middleEnd = messages.length - keepRecent;
  const middle = messages.slice(middleStart, middleEnd);

  if (middle.length === 0 && !headSummary) {
    // 没东西可压
    return null;
  }

  // 拼摘要素材给 LLM
  const oldSummaryNote = headSummary
    ? `## 早期已经摘要过的内容\n${headSummary.content.slice(SUMMARY_PREFIX.length)}\n\n`
    : '';
  const dialogueText = middle
    .map((m) => {
      if (m.role === 'user') return `玩家: ${m.content}`;
      return `${characterName}: ${m.content}`;
    })
    .join('\n');

  const userMsg = `${oldSummaryNote}## 接下来要并入摘要的对话片段
${dialogueText}

请输出一段连贯的摘要,涵盖以上所有内容(包括早期摘要 + 新片段),保留:
- 玩家做过的关键决定 / 说过的关键话
- ${characterName} 透露的关键信息 / 情感变化
- 双方关系的重要转折点

不要罗列对话。300 字以内,中文。`;

  const SYSTEM = `你是对话摘要员。把玩家和 ${characterName} 的对话历史浓缩成一段摘要,
让 ${characterName} 在后续对话中仍能"记得"这些早期发生的事,但不占大量 token。

要求:
- 单段文字(不分行,不要 bullet),300 字以内
- 第三人称视角写过去式:"玩家提到 ... ${characterName} 当时回答 ..."
- 保留关键事实和情感色彩
- 不要写"以下是摘要:"之类的元话
- 只输出摘要本身,不要任何前缀/后缀`;

  let resp;
  try {
    resp = await callLLM({
      task: 'utility.summary',
      systemPrompt: SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 600,
      temperature: 0.3,
    });
  } catch (e) {
    console.warn(`[messages-compress] LLM 摘要失败,放弃压缩:`, e);
    return null;
  }

  const summaryText = resp.text.trim();
  if (!summaryText) return null;

  const compressed: Message[] = [
    { role: 'assistant', content: SUMMARY_PREFIX + summaryText },
    ...tail,
  ];

  return {
    compressed,
    summarized: middle.length + (headSummary ? 1 : 0),
    summaryText,
    meta: { laneUsed: resp.laneUsed, durationSec: resp.durationSec },
  };
}

/**
 * 情绪检测 (Emotion Detection)
 * ==============================
 *
 * 输入:NPC 最新一句回复(+ 玩家最近一句作为上下文)
 * 输出:5 选 1 情绪
 *
 * 走 task='companion.banter' lane(UNIFIED_MATRIX → local_gemma)。
 * 跟 banter 共享 lane 是因为两者都是高频低价值短判断 — 本机 Gemma 跑成本接近 0。
 *
 * 失败 / 解析不到 / LLM 输出乱 → 都安全 fallback 到 'neutral'。
 * 调用方不需要 try/catch,这里全吃。
 */

import { callLLM } from './gateway';
import type { Emotion } from './portrait-emotions';
import { ALL_EMOTIONS, normalizeEmotion } from './portrait-emotions';

export interface DetectEmotionInput {
  /** 角色名,prompt 里用 */
  npcName: string;
  /** 角色 1-2 行简介(优化判断质量,可省略) */
  npcSummary?: string;
  /** 玩家最近一条 */
  playerMessage: string;
  /** 要分类的 NPC 回复 */
  npcReply: string;
}

export interface DetectEmotionResult {
  emotion: Emotion;
  /** 来源:'llm' 正常分类,'fallback' = 任意失败兜底成 neutral */
  source: 'llm' | 'fallback';
  /** 失败信息(仅供调试,不影响调用方逻辑) */
  error?: string;
  meta?: { laneUsed?: string; durationSec?: number };
}

const SYSTEM = `你是表情分类器。给定一段 NPC 的回复,判断这段话的主导情绪。

只能从 5 个选项里挑一个:
- neutral:平静、客观、没有明显情绪
- happy:开心、友好、欢迎、暖场
- serious:严肃、警惕、谈正事、不容置疑
- sad:难过、沮丧、怀念、低落
- intense:紧张、愤怒、激动、战斗

# 输出格式(严格)
只输出一个 JSON 代码块,块外无任何文字:

\`\`\`json
{ "emotion": "neutral" }
\`\`\`

emotion 字段必须是以上 5 个英文小写词之一。`;

export async function detectNpcEmotion(input: DetectEmotionInput): Promise<DetectEmotionResult> {
  if (typeof window === 'undefined') {
    return { emotion: 'neutral', source: 'fallback', error: 'client-only' };
  }
  const userMsg = `角色:${input.npcName}${input.npcSummary ? `(${input.npcSummary.slice(0, 80)})` : ''}

刚刚对话:
玩家:${input.playerMessage}
${input.npcName}:${input.npcReply}

${input.npcName} 这句话的主导情绪是?只输出 JSON。`;

  let resp;
  try {
    resp = await callLLM({
      task: 'companion.banter',
      systemPrompt: SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 60,
      temperature: 0.2,
    });
  } catch (e) {
    return {
      emotion: 'neutral',
      source: 'fallback',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const meta = { laneUsed: resp.laneUsed, durationSec: resp.durationSec };
  const parsed = extractEmotionJson(resp.text);
  if (parsed && typeof parsed.emotion === 'string') {
    const norm = normalizeEmotion(parsed.emotion);
    return { emotion: norm, source: 'llm', meta };
  }

  // 兜底:扫整段文本里有没有出现 5 个关键词之一
  const raw = resp.text.toLowerCase();
  for (const e of ALL_EMOTIONS) {
    if (raw.includes(e)) return { emotion: e, source: 'llm', meta };
  }

  return { emotion: 'neutral', source: 'fallback', meta, error: '未解析到情绪,fallback neutral' };
}

// ─── JSON 解析 ───────────────────────────────────────────────────

interface EmotionJson {
  emotion?: unknown;
}

function extractEmotionJson(text: string): EmotionJson | null {
  const jsonFenceRe = /```\s*json\s*\n?/gi;
  let m: RegExpExecArray | null;
  while ((m = jsonFenceRe.exec(text)) !== null) {
    const fromIdx = m.index + m[0].length;
    const candidate = scanBalancedJson(text, fromIdx);
    if (candidate) {
      try {
        const obj = JSON.parse(candidate);
        if (obj && typeof obj === 'object') return obj as EmotionJson;
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
      if (obj && typeof obj === 'object') return obj as EmotionJson;
    } catch {
      // ignore
    }
  }
  return null;
}

// ─── C1: emotion → trust 自动兜底映射 ───────────────────────────
//
// 当 LLM 没显式写 WC-TRUST 时,根据检测到的 emotion 自动给一个保守的 ±1。
// 这是"软兜底" — LLM 显式判断永远优先,这里只是补 LLM 漏标的情况。
//
// 映射哲学:
//   - 只对**明确正/负**情绪兜底,模糊态(sad/serious)给 0(避免误判)
//   - 幅度恒定 ±1(最小),不取代 LLM 的判断,只在零事件时补一点信号
//   - intense:愤怒/紧张/战斗 — 不一定是对玩家(可能是 NPC 自己怒于别处);
//     但实践中绝大多数 intense 都跟玩家行为相关 → -1 偏保守可接受
//   - happy:开心/友好/暖场 — 强信号 +1
//
// 使用方:调用方先检查 hadExplicitTrustChange,只在为 false 时用此兜底。

const EMOTION_AUTO_TRUST_MAP: Record<Emotion, number> = {
  neutral: 0,
  happy: +1,
  serious: 0,
  sad: 0,
  intense: -1,
};

export function getEmotionAutoTrust(emotion: Emotion): number {
  return EMOTION_AUTO_TRUST_MAP[emotion] ?? 0;
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

/**
 * 记忆固化 (Memory Consolidation)
 * ================================
 *
 * 返广场时,从最近的对话里摘出 3-5 个"关键瞬间",写入 plaza.npcMemories。
 * 下次再进同剧本/见同 NPC 时,system prompt 会注入这些记忆 → NPC 真的"记得"。
 *
 * 走 task='memory.consolidate' lane(UNIFIED_MATRIX 里 → codex_spark_bridge)。
 */

import { callLLM } from './gateway';
import { plaza, type NpcEpisodicMemory } from './plaza';
import { tierConfigFor } from './character-tiers';
import { getScenario } from './scenarios';

export interface ConsolidateOptions {
  npcId: string;
  npcName: string;
  scenarioId: string;
  /** 最近的对话,role 是 user/assistant,content 已不含 NARRATION_PREFIX */
  conversation: { role: 'user' | 'assistant'; content: string }[];
  /** 跟此 NPC 之前已有的记忆数(用于 prompt 提示"别重复") */
  existingMemoryCount?: number;
}

export interface ConsolidateResult {
  ok: boolean;
  added: number;
  memories: Omit<NpcEpisodicMemory, 'npcId' | 'real_timestamp'>[];
  rawText?: string;
  error?: string;
}

const SYSTEM = `你是叙事记忆整理员。给定玩家与某 NPC 最近的对话,摘出 2-5 个"关键瞬间"作为该 NPC 的长期记忆。

要求:
- 每个瞬间一句话(30-80 字),从 NPC 视角写,带情感色彩,以后能被 NPC 自然引用
- 不要罗列对话,要提炼"印象深的事"(玩家的选择/态度/某个动作/某句话)
- 评估每段记忆的情感强度 emotional_weight ∈ [-1, 1] (负 = 痛苦/不满,正 = 温暖/感激)
- 给 1-3 个标签描述这段记忆的主题

输出严格 JSON 代码块:

\`\`\`json
{
  "memories": [
    {
      "scene": "(以 NPC 视角的一句话)",
      "emotional_weight": 0.5,
      "tags": ["信任", "送信"]
    }
  ]
}
\`\`\`

如果对话太短或没有值得记的内容,返回 { "memories": [] }。`;

export async function consolidateNpcMemory(opts: ConsolidateOptions): Promise<ConsolidateResult> {
  if (typeof window === 'undefined') {
    return { ok: false, added: 0, memories: [], error: 'client-only function' };
  }
  if (opts.conversation.length < 2) {
    // 对话太短,不固化
    return { ok: true, added: 0, memories: [] };
  }

  // 拼用户消息:把对话浓缩成可读片段
  const dialogue = opts.conversation
    .map((m) => (m.role === 'user' ? `玩家: ${m.content}` : `${opts.npcName}: ${m.content}`))
    .join('\n');

  const userMsg = `NPC: ${opts.npcName}
剧本: ${opts.scenarioId}
${opts.existingMemoryCount ? `(此 NPC 已有 ${opts.existingMemoryCount} 条历史记忆,不要重复)` : ''}

最近对话:
${dialogue}

请摘出 2-5 个关键瞬间,严格按 JSON 格式输出。`;

  let resp;
  try {
    resp = await callLLM({
      task: 'memory.consolidate',
      systemPrompt: SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 800,
      temperature: 0.5,
    });
  } catch (e) {
    return { ok: false, added: 0, memories: [], error: e instanceof Error ? e.message : String(e) };
  }

  // 解析 JSON 块
  const parsed = extractMemoryJson(resp.text);
  if (!parsed) {
    return {
      ok: false,
      added: 0,
      memories: [],
      rawText: resp.text,
      error: '记忆固化:LLM 未输出有效 JSON',
    };
  }

  const memArr = Array.isArray(parsed.memories) ? parsed.memories : [];
  const cleaned: Omit<NpcEpisodicMemory, 'npcId' | 'real_timestamp'>[] = [];
  for (const item of memArr) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    if (typeof m.scene !== 'string' || !m.scene.trim()) continue;
    cleaned.push({
      scenarioId: opts.scenarioId,
      scene: m.scene.trim(),
      emotional_weight:
        typeof m.emotional_weight === 'number'
          ? Math.max(-1, Math.min(1, m.emotional_weight))
          : 0,
      tags: Array.isArray(m.tags)
        ? (m.tags as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 5)
        : [],
    });
  }

  if (cleaned.length > 0) {
    // F6:按 tier 配额(core=40 / side=20 / passing=10)而不是硬编码 30
    const scenario = getScenario(opts.scenarioId);
    const progress = scenario ? plaza.getScenarioProgress(opts.scenarioId) : null;
    const scene = scenario?.scenes && progress?.currentSceneId
      ? scenario.scenes.find((s) => s.id === progress.currentSceneId)
      : undefined;
    const tier = tierConfigFor(opts.npcId, scenario, scene);
    plaza.appendNpcMemories(opts.npcId, cleaned, tier.memoriesMax);
  }

  return { ok: true, added: cleaned.length, memories: cleaned, rawText: resp.text };
}

// ─── helpers ─────────────────────────────────────────────────────

function extractMemoryJson(text: string): { memories?: unknown } | null {
  const jsonFenceRe = /```\s*json\s*\n?/gi;
  let m: RegExpExecArray | null;
  while ((m = jsonFenceRe.exec(text)) !== null) {
    const fromIdx = m.index + m[0].length;
    const candidate = scanBalancedJson(text, fromIdx);
    if (candidate) {
      try {
        return JSON.parse(candidate) as { memories?: unknown };
      } catch {
        // continue
      }
    }
  }
  // 兜底:全文裸 JSON
  const candidate = scanBalancedJson(text, 0);
  if (candidate) {
    try {
      return JSON.parse(candidate) as { memories?: unknown };
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

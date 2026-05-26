/**
 * 对白结构指标抽取 (Reply Metrics)
 * ===================================
 *
 * C2:从 NPC 回复文本里抽出客观结构性指标 — 长度、问号比、自我指涉比、感叹比。
 * 用来推测 NPC 这一回合的"投入度 / 试探程度 / 攻击性",作为派生信号补充
 * 显式的 WC-EVENT / WC-STAT / WC-TRUST。
 *
 * 设计原则:
 *   - 不调 LLM、不引入 latency(完全本地字符串分析)
 *   - 中文 + 中英标点全兼容
 *   - 输出结构稳定,方便未来给 UI / debug panel / prompt 反馈
 *   - 提供 ring buffer 留痕,跟 llm-events.ts 的 parse-fail 模式一致
 *
 * 怎么用:
 *   const m = analyzeReplyStructure(npcReply);
 *   recordReplyMetrics(npcId, m);
 *   console.debug(`[reply-metrics] ${npcId} engagement=${m.engagementHint} q=${m.questionRatio}`);
 */

export type EngagementHint =
  | 'withdrawn'  // 短而无问、低投入 — NPC 心不在焉 / 警戒不愿说
  | 'curious'    // 问号多 — NPC 在试探 / 反问玩家
  | 'engaged'    // 中等长度 + 自我指涉适中 — 正常投入对话
  | 'expressive' // 长 + 感叹/语气词多 — NPC 情绪外露 / 戏剧化表达
  | 'lecturing'; // 长 + 几乎无问号 — NPC 在单方面输出 / 训话

export interface ReplyMetrics {
  /** 字符长度(去掉 WC-* HTML 注释后) */
  length: number;
  /** 句子数(按中英文句末标点切) */
  sentenceCount: number;
  /** 问号比 = 问号数 / 句子数;>0.5 说明几乎每句都是反问 */
  questionRatio: number;
  /** 感叹比 = 感叹号数 / 句子数 */
  exclamationRatio: number;
  /** 自我指涉比 = (我/本座/在下/老朽 等出现次数) / 句子数 */
  selfRefRatio: number;
  /** 启发式投入度分类 */
  engagementHint: EngagementHint;
}

// 中英文句末标点
const SENTENCE_END_RE = /[。.！!？?\n]+/;
// 中英文问号
const QUESTION_RE = /[？?]/g;
// 中英文感叹号
const EXCL_RE = /[！!]/g;
// 自我指涉关键词(常见武侠 / 古风第一人称)
const SELF_REF_RE = /我|本座|在下|老朽|贫道|小生|本宫|哀家|朕|寡人|本王/g;
// 去掉 WC-* HTML 注释,只算"实际对话长度"
const WC_COMMENT_RE = /<!--\s*WC-(EVENT|STAT|TRUST)\b[^>]*-->/g;

export function analyzeReplyStructure(text: string): ReplyMetrics {
  if (!text || typeof text !== 'string') {
    return {
      length: 0,
      sentenceCount: 0,
      questionRatio: 0,
      exclamationRatio: 0,
      selfRefRatio: 0,
      engagementHint: 'withdrawn',
    };
  }
  // 净化:剥掉 WC-* 注释,trim 空白
  const cleaned = text.replace(WC_COMMENT_RE, '').trim();
  const length = cleaned.length;

  // 按句末标点切;空段 / 单字段 fallback 为 1 句
  const sentences = cleaned
    .split(SENTENCE_END_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const sentenceCount = Math.max(sentences.length, 1);

  const questionMatches = cleaned.match(QUESTION_RE) ?? [];
  const exclMatches = cleaned.match(EXCL_RE) ?? [];
  const selfRefMatches = cleaned.match(SELF_REF_RE) ?? [];

  const questionRatio = questionMatches.length / sentenceCount;
  const exclamationRatio = exclMatches.length / sentenceCount;
  const selfRefRatio = selfRefMatches.length / sentenceCount;

  const engagementHint = classifyEngagement({
    length,
    sentenceCount,
    questionRatio,
    exclamationRatio,
    selfRefRatio,
  });

  return {
    length,
    sentenceCount,
    questionRatio,
    exclamationRatio,
    selfRefRatio,
    engagementHint,
  };
}

function classifyEngagement(m: {
  length: number;
  sentenceCount: number;
  questionRatio: number;
  exclamationRatio: number;
  selfRefRatio: number;
}): EngagementHint {
  // 阈值按中文校准:一个汉字 ≈ 英文 5-7 字符,所以长度阈值要远小于英文场景
  // 短且无问 — 抽离/警戒
  if (m.length < 15 && m.questionRatio < 0.1) return 'withdrawn';
  // 问号 > 50% — 反问 / 试探
  if (m.questionRatio > 0.5) return 'curious';
  // 感叹比 > 50%(平均每两句必有感叹号)— 表达型
  if (m.exclamationRatio > 0.5) return 'expressive';
  // 长 + 高自我指涉 + 几乎无问号 — 训话型(自吹 / 训诫)
  if (m.length > 40 && m.questionRatio < 0.1 && m.selfRefRatio > 0.8) return 'lecturing';
  // 其余:中等投入
  return 'engaged';
}

// ─── ring buffer ────────────────────────────────────────────────

export interface ReplyMetricsRecord {
  at: string;
  npcId: string;
  metrics: ReplyMetrics;
}

const METRICS_BUFFER_MAX = 50;
const metricsBuffer: ReplyMetricsRecord[] = [];

export function recordReplyMetrics(npcId: string, metrics: ReplyMetrics): void {
  metricsBuffer.push({
    at: new Date().toISOString(),
    npcId,
    metrics,
  });
  if (metricsBuffer.length > METRICS_BUFFER_MAX) metricsBuffer.shift();
}

/** 读取最近 N 条 metrics 留痕。 */
export function getReplyMetrics(limit = 50): ReplyMetricsRecord[] {
  return metricsBuffer.slice(-limit);
}

/** 清空 buffer(测试用)。 */
export function clearReplyMetrics(): void {
  metricsBuffer.length = 0;
}

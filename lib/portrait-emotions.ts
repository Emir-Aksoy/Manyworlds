/**
 * 多情绪立绘 (Multi-Emotion Portraits)
 * =====================================
 *
 * 5 种预设情绪 → 各自的 SDXL prompt modifier。
 * 思路:base_prompt 已经定了人物长相 / 服装 / 镜头,只在末尾追加情绪描述。
 * 关键词偏 SDXL 友好(英文,逗号分隔,具体可视细节)。
 *
 * 5 种情绪覆盖 80% 场景:
 *   - neutral:基线,不附加(原 base_prompt 效果)
 *   - happy:开心 / 友好 / 暖场
 *   - serious:严肃 / 正色 / 谈正事
 *   - sad:难过 / 沮丧 / 怀念
 *   - intense:紧张 / 愤怒 / 战斗状态
 *
 * 缓存键格式:{ [characterId]: { [emotion]: dataUrl } }(由 app/page.tsx 管理)。
 */

export type Emotion = 'neutral' | 'happy' | 'serious' | 'sad' | 'intense';

export const ALL_EMOTIONS: Emotion[] = ['neutral', 'happy', 'serious', 'sad', 'intense'];

export const EMOTION_LABELS: Record<Emotion, string> = {
  neutral: '平静',
  happy: '开心',
  serious: '严肃',
  sad: '难过',
  intense: '紧绷',
};

/** UI 上给情绪带一个 emoji,方便快速辨认。 */
export const EMOTION_ICONS: Record<Emotion, string> = {
  neutral: '🙂',
  happy: '😄',
  serious: '😐',
  sad: '😔',
  intense: '😤',
};

/**
 * 各情绪附加到 base_prompt 末尾的 modifier。
 * - neutral 留空,完全使用 base_prompt(避免不必要的重生)
 * - 其他追加面部表情 + 微妙的灯光/眼神描述,SDXL 4-step 也能拉开差异
 */
export const EMOTION_MODIFIERS: Record<Emotion, string> = {
  neutral: '',
  happy: ', warm smile, soft eyes, gentle expression, friendly mood, bright lighting',
  serious: ', stern face, focused gaze, slight frown, professional composure, controlled lighting',
  sad: ', downcast eyes, melancholic expression, soft frown, subdued mood, dim cool lighting',
  intense: ', intense focused stare, furrowed brow, tight jaw, dramatic shadow, high contrast lighting',
};

/**
 * 把情绪 modifier 拼到 base prompt 末尾。
 * neutral → 原样返回(节省 SDXL 工作量)。
 */
export function buildEmotionPrompt(basePrompt: string, emotion: Emotion): string {
  const mod = EMOTION_MODIFIERS[emotion];
  if (!mod) return basePrompt;
  // 已经有句末标点的话清掉再拼,避免 "..., warm smile" 这种双逗号
  const trimmed = basePrompt.replace(/[\s,，。.]+$/, '');
  return `${trimmed}${mod}`;
}

/**
 * 把任意字符串 normalize 成合法 Emotion(LLM 经常返回大小写不一致 / 加引号 / 中文)。
 * 不认识的归 'neutral'。
 */
export function normalizeEmotion(raw: unknown): Emotion {
  if (typeof raw !== 'string') return 'neutral';
  const s = raw.trim().toLowerCase().replace(/['"`]/g, '');
  if (s.includes('happy') || s.includes('开心') || s.includes('喜')) return 'happy';
  if (s.includes('serious') || s.includes('严肃') || s.includes('正色')) return 'serious';
  if (s.includes('sad') || s.includes('难过') || s.includes('伤')) return 'sad';
  if (s.includes('intense') || s.includes('angry') || s.includes('怒') || s.includes('紧'))
    return 'intense';
  return 'neutral';
}

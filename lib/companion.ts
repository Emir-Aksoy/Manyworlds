/**
 * Companion(队友)
 * =================
 *
 * 玩家携带的跨剧本队友。PoC Step 1 阶段只是占位 stub —— 内部一个固定的"小明"概况字符串,
 * 用来注入到任一 NPC 的 system prompt 里。
 *
 * Step 2(下一阶段)会扩展成完整的 V4 Companion:
 *   - 自己的 CharacterSpec V4(可携带)
 *   - 跨剧本 episodic memory(玩家在剧本 A 经历的事,队友在剧本 B 里"记得")
 *   - 人格演变(relationships.with_player.trust 累积)
 *   - 进入新剧本时 system prompt 自动注入跨剧本上下文
 */

/**
 * PoC 阶段的默认队友 —— 一个温和倔强的年轻人,玩家刚开始携带,跨剧本记忆为空。
 */
export const DEFAULT_COMPANION_SUMMARY = `名字:小明
性格:温和、倔强、理想主义、怕鬼、爱吃甜食
跨剧本经历:暂无(这是他第一次出门)`;

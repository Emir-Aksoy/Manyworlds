/**
 * 星际邮差 — 剧本 metadata
 * 来源:/scenarios/星际邮差-世界观.md + NPC卡组.md
 */

import type { Scenario } from '../index';
import { STARMAIL_NPCS, HALIA } from './npcs';
import { STARMAIL_SCENES, STARMAIL_START_SCENE_ID } from './scenes';

export const STARMAIL: Scenario = {
  id: 'starmail',
  name: '星际邮差',
  shortName: 'Star Mail',
  description:
    '玩家是 IPU(星际邮政联盟)的新晋邮差,负责跨星系送信。Halia 是其导师。从教程任务"送信到灯塔"开始,逐渐卷入"大寂静"事件的真相。',
  openingNarration:
    'Coriolis 中转站的钟敲了第三次。Halia 把"Lark-04"的钥匙扔过来,你接住了。"去吧。"她说,转身回了调度室。第一封信,在你的口袋里。',
  defaultNpcId: HALIA.character_id,
  npcs: STARMAIL_NPCS,
  // 教程剧本:免费进入
  entryCost: 0,
  // 世界观:科技邮差体系(IPU 飞船 / 通讯器 / 邮路) + 隐藏的灵能伏笔(Echo 闪回 / The Voice 心灵感应)
  magicTags: ['tech', 'psionic'],
  // 完成度奖励:刚摸过门是 30,主线全推 + 揭"大寂静"伏笔 150
  forceReward: { min: 30, max: 150 },
  // P1+P2:剧情骨架 — 5 个 scene,11 个 checkpoint
  scenes: STARMAIL_SCENES,
  startSceneId: STARMAIL_START_SCENE_ID,
  // I-series:中等难度教程剧本 — 愿望 40% 概率被批准
  difficulty: 'normal',
  // 灵魂进入预设:化身为 IPU 新晋邮差(性别/年龄继承玩家真实身份,让世代代入感强)
  playerSoulIdentity: {
    name: '新晋邮差',
    background:
      '你是 IPU(星际邮政联盟)Coriolis 分部刚通过结业考核的新晋邮差。简历干净,从未跑过实战邮路。Halia 是你的导师 — 她的语气总让你觉得自己漏了什么。你的飞船 Lark-04 钥匙在口袋里,第一封信也在。',
  },
};

export { HALIA, STARMAIL_NPCS, STARMAIL_SCENES };
export * from './npcs';

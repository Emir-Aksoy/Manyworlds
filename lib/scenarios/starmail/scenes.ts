/**
 * 星际邮差 · 剧情骨架(scene / beat / checkpoint)
 * =================================================
 *
 * 5 个 Scene,约 20 个 Beat,11 个 checkpoint。
 * 主线:Coriolis 拿信 → Lark-04 出港 → 灯塔星交付 → 返航异常 → 复命 + 大寂静伏笔
 *
 * Beat id 命名:`<scene>-<type>-<n>` (type: ck=checkpoint, op=optional)
 *
 * Director 在 advance() 时读未完成的 beats,依 triggerHint 判断推动。
 */

import type { Scene } from '../index';

export const STARMAIL_SCENES: Scene[] = [
  // ── Scene 1 ─────────────────────────────────────────────
  {
    id: 'scene-coriolis-arrival',
    name: 'Coriolis 中转站 · 第三次钟声',
    description:
      'Coriolis 中转站,2089 年。半合金穹顶外是冷光的星空,内厅永远飘着一层咖啡和金属润滑油的味道。Halia 站在调度台后,把一串 Lark-04 飞船的物理钥匙扔向玩家。三次钟声,意味着轮值开始。玩家的口袋里多了一封信。',
    enterNarration:
      '钟敲了第三次。Halia 把"Lark-04"的钥匙扔过来,你接住了。"去吧。"她说,转身回了调度室。第一封信,在你的口袋里。',
    imagePrompt:
      'cyberpunk space relay station interior, half-alloy dome ceiling, dim teal lighting, dispatch console, weathered IPU mail courier signage, semi-realistic illustration',
    presentNpcIds: ['starmail-npc-halia', 'starmail-npc-bao'],
    beats: [
      {
        id: 'sc1-ck-1',
        type: 'checkpoint',
        summary: '玩家正式接下任务 — 拿到 Lark-04 钥匙',
        triggerHint:
          '玩家明确说接受任务(类似 "我去 / 好 / 出发"),或顺手接住 Halia 扔来的钥匙、提到飞船名 Lark-04',
        unlockHint: '🔑 你接住了 Lark-04 的钥匙。任务开始。',
      },
      {
        id: 'sc1-ck-2',
        type: 'checkpoint',
        summary: '玩家读了第一封信的封皮:灯塔守人收',
        triggerHint:
          '玩家提到信、提到收件人(灯塔 / Lighthouse Keeper),或检视信封;或 Halia 主动提及"信是给灯塔的"',
        unlockHint: '📨 信封上的收件人:灯塔守人。',
      },
      {
        id: 'sc1-op-3',
        type: 'optional',
        summary: '玩家跟 Bao 寒暄 / 让 Bao 检查飞船',
        triggerHint:
          '玩家主动跟 Bao 说话或请他检查 Lark-04;Bao 也可能凑过来调侃',
      },
    ],
    nextSceneId: 'scene-lark04-launch',
  },

  // ── Scene 2 ─────────────────────────────────────────────
  {
    id: 'scene-lark04-launch',
    name: 'Lark-04 出港',
    description:
      '老式邮船 Lark-04 的驾驶舱。座椅有汗渍味,导航全息屏闪烁。玩家第一次单飞,系统语音冷冰冰地报着自检进度。通讯器只剩 Bao 在中转站监控。',
    enterNarration:
      'Lark-04 在停机坪上闪起蓝色尾灯。舱门合拢,你坐进驾驶椅。Bao 的声音从通讯器里挤进来:"伙计,起飞前先泡杯咖啡 — 不,先看燃料表。"',
    imagePrompt:
      'cockpit of small old mail spaceship, holographic navigation displays, single pilot seat, dim teal blue lighting, semi-realistic illustration',
    // Bao 在通讯频道里(物理不在场,但能对话)
    presentNpcIds: ['starmail-npc-bao'],
    beats: [
      {
        id: 'sc2-ck-1',
        type: 'checkpoint',
        summary: '玩家启动 Lark-04(给出某种"出发 / 起飞"的指令或交互)',
        triggerHint:
          '玩家说"起飞 / 出发 / 启动 / 点火" 或类似指令;或询问怎么启动,Bao 教他完成',
        unlockHint: '🚀 Lark-04 解锁,你正在跨星航路上。',
      },
      {
        id: 'sc2-ck-2',
        type: 'checkpoint',
        summary: 'Bao 通过通讯器远程指导(玩家求助 / Bao 主动播报)',
        triggerHint:
          '玩家提问 / Bao 给出导航建议 / 玩家跟 Bao 互动至少 1 次',
        unlockHint: '📡 Bao 在频道里给你罩着。',
      },
      {
        id: 'sc2-op-3',
        type: 'optional',
        summary: '玩家拒绝求助,选择独自摸索(影响 Bao 的关系)',
        triggerHint:
          '玩家在 sc2-ck-2 之前明确说"不用 / 我自己来 / 别打扰" 拒绝 Bao 的支援',
      },
    ],
    nextSceneId: 'scene-lighthouse-delivery',
  },

  // ── Scene 3 ─────────────────────────────────────────────
  {
    id: 'scene-lighthouse-delivery',
    name: '灯塔星 · 与守人对话',
    description:
      '抵达灯塔星 — 一颗几乎被废弃的小行星,只剩一座古老的脉冲灯塔还在缓慢闪烁。Lighthouse Keeper 是一位话很少的守人,住在灯塔底舱,跟外界几乎不交流。',
    enterNarration:
      'Lark-04 缓缓降落,灯塔的脉冲扫过你的舱体。门开了,Lighthouse Keeper 在那里 — 比传说中年轻得多,眼神却像活过千年。',
    imagePrompt:
      'ancient lighthouse on a small asteroid, slow pulsing beacon, dim starlight, lonely keeper figure silhouette in doorway, atmospheric science fiction illustration',
    presentNpcIds: ['starmail-npc-lighthouse'],
    beats: [
      {
        id: 'sc3-ck-1',
        type: 'checkpoint',
        summary: '玩家成功着陆灯塔星',
        triggerHint:
          '玩家说"我到了 / 着陆 / 抵达 / 看见灯塔" 或描述自己降落的过程',
        unlockHint: '🛰 着陆灯塔星。',
      },
      {
        id: 'sc3-ck-2',
        type: 'checkpoint',
        summary: '玩家见到 Lighthouse Keeper 并开始对话',
        triggerHint:
          '玩家跟 Lighthouse Keeper 至少有一轮对话(无论说什么);或 Keeper 主动开口',
        unlockHint: '🗝 你见到了灯塔守人。',
      },
      {
        id: 'sc3-ck-3',
        type: 'checkpoint',
        summary: '玩家把信交给 Lighthouse Keeper',
        triggerHint:
          '玩家明确说"把信给你 / 这是你的信 / 给你 / 这里" 等递信动作;或 Keeper 接过信并说"谢谢 / 收到"',
        unlockHint: '✉️ 信件已交付。任务主线完成。',
      },
      {
        id: 'sc3-op-4',
        type: 'optional',
        summary: '玩家追问"灯塔为什么还亮着"(伏笔)',
        triggerHint:
          '玩家问 Keeper 为什么不离开 / 灯塔为谁亮 / 信号给谁;Keeper 含糊地回答 "等一个回信"',
      },
      {
        id: 'sc3-op-5',
        type: 'optional',
        summary: 'Echo 首次在玩家思绪中说话(灵能伏笔)',
        triggerHint:
          '场景安静时玩家自言自语 / 沉思 / 询问灯塔工作原理;Echo 用心灵感应短暂插话 — Director 加一句"(脑中似乎有别的声音说: ...)"',
      },
    ],
    nextSceneId: 'scene-return-anomaly',
  },

  // ── Scene 4 ─────────────────────────────────────────────
  {
    id: 'scene-return-anomaly',
    name: '返航途中 · 异常信号',
    description:
      '返航航路。Lark-04 巡航中通讯器突然在非 IPU 频段响起 — 一段陌生的脉冲,带着古老的编码格式。Vex 海盗或 Mira 远程分析师可能介入。',
    enterNarration:
      '你拨转 Lark-04 的航向准备回家。导航刚定,通讯器就在一个不该用的频段响起了 — 短促,有规律,像求救,又像问候。',
    imagePrompt:
      'small mail ship cruising through deep space, mysterious anomaly signal visualized as faint geometric pulse, vast stars, sci-fi illustration',
    // 飞船里只能通过通讯频道联系外部 NPC(Bao/Mira/Vex)
    presentNpcIds: ['starmail-npc-bao', 'starmail-npc-mira', 'starmail-npc-vex'],
    beats: [
      {
        id: 'sc4-ck-1',
        type: 'checkpoint',
        summary: '玩家接收异常信号(注意到通讯器异常)',
        triggerHint:
          '玩家说"通讯器响了 / 信号 / 这是什么频段 / 我听见东西" 或主动调频接收;Director 也可旁白触发',
        unlockHint: '📡 你接收到一段陌生信号。',
      },
      {
        id: 'sc4-ck-2',
        type: 'checkpoint',
        summary: '玩家对信号做出明确选择(回应 / 忽略 / 求助)',
        triggerHint:
          '玩家说"回应 / 我回 / 忽略 / 关掉 / 报告 Halia / 让 Mira 看看"',
        unlockHint: '⚖ 你做出了选择。',
      },
      {
        id: 'sc4-op-3',
        type: 'optional',
        summary: 'Vex 海盗短暂接入频道',
        triggerHint:
          '玩家选择回应信号,或玩家描绘自己越过禁航区;Director 让 Vex 用粗鲁但克制的语气短暂登场',
      },
      {
        id: 'sc4-op-4',
        type: 'optional',
        summary: 'Mira 远程协助分析信号编码',
        triggerHint:
          '玩家请 Mira 帮忙;Mira 在 5 秒后给出"这编码格式比 IPU 早 80 年"的判断',
      },
    ],
    nextSceneId: 'scene-coriolis-debrief',
  },

  // ── Scene 5 ─────────────────────────────────────────────
  {
    id: 'scene-coriolis-debrief',
    name: 'Coriolis 复命 · 大寂静的暗示',
    description:
      '返航 Coriolis 中转站。Halia 在调度台后等着复命,目光锐利。这一段对话会决定玩家是否真的"听见"了某种声音 — The Voice 的第一次正式出现,只用心灵感应短暂闪一下。',
    enterNarration:
      'Lark-04 归位,你走出舱门。Halia 没起身,只是抬眼看你。"回来了。" 她说,"坐下,慢慢说。"',
    imagePrompt:
      'IPU dispatch office interior, weary senior officer at console, returning courier silhouette in doorway, warm orange lamp light contrast with cold blue station lighting, semi-realistic illustration',
    presentNpcIds: ['starmail-npc-halia', 'starmail-npc-bao', 'starmail-npc-ren'],
    beats: [
      {
        id: 'sc5-ck-1',
        type: 'checkpoint',
        summary: '玩家向 Halia 复命(叙述整趟经过)',
        triggerHint:
          '玩家跟 Halia 至少有一轮关于送信/灯塔/返航的对话,描述了任务情况',
        unlockHint: '📋 复命完成。',
      },
      {
        id: 'sc5-ck-2',
        type: 'checkpoint',
        summary: 'The Voice 短暂闪现(主线伏笔)',
        triggerHint:
          '玩家提到信号/灯塔/异常的瞬间,或对话间隙;Director 在 narration 中加一闪而过的心灵感应短句,比如"(……远处有什么在听)"。这是大寂静的伏笔,**只闪一次**,不要被 NPC 直接讨论。',
        unlockHint: '🌀 你脑中似乎听见了什么。但一闪即逝。',
      },
      {
        id: 'sc5-op-3',
        type: 'optional',
        summary: '玩家问 Halia "大寂静" 是什么',
        triggerHint:
          '玩家直接问 Halia 关于大寂静 / 那些消失的邮差 / 不该响的频段;Halia 用三句话回答,带回避',
      },
      {
        id: 'sc5-op-4',
        type: 'optional',
        summary: 'Ren 走过来塞了一张老旧信片',
        triggerHint:
          '复命后场景缓慢的时候,Ren 经过递东西;玩家可以选择接 / 不接 / 当场打开',
      },
    ],
    // 最后一个 scene,nextSceneId 留空
  },
];

export const STARMAIL_START_SCENE_ID = STARMAIL_SCENES[0].id;

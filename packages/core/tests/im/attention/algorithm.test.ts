import { describe, expect, it } from 'vitest'
import { decideAttention, scoreAttention } from '../../../src/im/attention/algorithm.js'
import { attentionDefaults, scoreAttentionSandbox } from '../../../src/im/attention/dev-sandbox.js'
import { attentionTopicUnits, topicCpSimilarity, topicEditSimilarity } from '../../../src/im/attention/topic-evidence.js'
import type { AttentionMessage, AttentionSnapshot } from '../../../src/im/attention/types.js'

const now = 1_761_746_400_000
function message(text: string, changes: Partial<AttentionMessage> = {}): AttentionMessage {
  return {
    eventId: `${now}-0`, platform: 'qq', botId: 'bot-a', groupId: 'group-a',
    platformMessageId: null, senderId: 'member-a', eventReceivedMs: now, platformSentMs: null,
    rawText: text, mediaOnly: false, mediaKinds: [], processableMedia: null,
    mentionedCurrentBot: false, mentionedOtherBot: false, mentionedOtherMember: false,
    hasUnresolvedMention: false, replyToPlatformMessageId: null, replyTargetSenderId: null,
    replyTargetIsBot: null, quoteText: null, senderIsBot: false, candidateText: text,
    ...changes,
  }
}
const empty: AttentionSnapshot = { messages: [], complete: false }
function topicSnapshot(text: string, ageSeconds = 0, context: readonly AttentionMessage[] = []): AttentionSnapshot {
  const anchor = { platformMessageId: 'reply-anchor', sentAtMs: now - ageSeconds * 1_000, recipientSenderId: null, accepted: true, sourceAttentionKind: 'proactive', finalText: text, deliveryId: 'delivery-anchor' }
  return { messages: context, complete: true, latestAcceptedFinal: anchor, acceptedOutboundFacts: [anchor] }
}

describe('群聊 attention-v3 决策', () => {
  it('只把明确问句作为 ASK，排除反问和转述', () => {
    expect(scoreAttention(message('为什么汉密尔顿的音乐这么好听'), empty).sceneScore).toBeCloseTo(.9)
    expect(scoreAttention(message('他哪会翻跟斗'), empty).sceneScore).toBe(0)
    expect(scoreAttention(message('他说为什么会这样'), empty).sceneScore).toBe(0)
    expect(scoreAttention(message('为什么延期。'), empty).askAdjustedScore).toBeCloseTo(.585)
    expect(scoreAttention(message('这咋回事'), empty).sceneScore).toBeCloseTo(.765)
    expect(scoreAttention(message('他说这咋回事'), empty).sceneScore).toBe(0)
    for (const text of ['为什么汉密尔顿的音乐这么好听', '为什么汉密尔顿的音乐这么好听啊？', '这个算法怎么样', 'Redis 超时怎么解决']) {
      expect(scoreAttention(message(text), empty).sceneScore, text).toBeCloseTo(.9)
    }
    for (const text of ['怎么这样啊？', '这咋回事', '那怎么回事？', '咋回事', '为什么呢', '你呢', '确实？', '离谱？']) {
      expect(scoreAttention(message(text), empty).sceneScore, text).toBeCloseTo(.765)
    }
    for (const text of ['他哪会翻跟斗', '这首歌真好听啊', '我不知道为什么会这样', '他说为什么会这样', '？']) {
      expect(scoreAttention(message(text), empty).sceneScore, text).toBe(0)
    }
  })

  it('CALL 按机器人称呼、祈使结构和具体宾语分档', () => {
    const cases: Array<[string, number]> = [
      ['咕咕看吧', .92], ['咕咕帮我看看这个算法怎么样', .92], ['咕咕查这个', .828],
      ['咕咕看', .736], ['咕咕别走', .92], ['咕咕看看这个', .92], ['咕咕看起来很累', 0],
      ['咕咕走了', 0], ['咕咕和小北真的能唠', 0], ['我看咕咕今天没说话', 0],
    ]
    for (const [text, expected] of cases) expect(scoreAttention(message(text), empty, { botAliases: ['咕咕'] }).sceneScore, text).toBeCloseTo(expected)
  })

  it('长材料中的弱问句按可见位置降权并返回码点区间', () => {
    const text = '背景资料'.repeat(300) + '。这个项目为什么延期？。' + '补充材料'.repeat(300)
    const decision = scoreAttention(message(text), empty)
    expect(decision.sceneType).toBe('ASK')
    expect(decision.askRawScore).toBeCloseTo(.9)
    expect(decision.askPositionWeight).toBeCloseTo(.55, 1)
    expect(decision.score).toBeCloseTo(49.5, 0)
    expect(decision.askSpanEnd).toBeGreaterThan(decision.askSpanStart!)
  })

  it('能力请求绕过普通阈值并保留安全范围诊断', () => {
    const text = '背景资料'.repeat(300) + '。咕咕帮我创建项目。' + '补充材料'.repeat(300)
    const decision = scoreAttention(message(text), empty, { botAliases: ['咕咕'] })
    expect(decision.kind).toBe('CAPABILITY_ACTION')
    expect(decision.capabilityStrength).toBe('strong')
    expect(decision.capabilitySpanStart).not.toBeNull()
  })

  it('能力准入拒绝转述、否定、计划和功能评价，但保留明确操作请求', () => {
    for (const text of ['那定个定时任务', '帮我创建一个项目', '给我记个笔记', '把这个笔记删掉', '小北帮我整理文件', '帮我建个项目', '帮我设置提醒', '给项目加个任务', '我想创建一个项目', '好吧 那记录个日程吧', '那么记录个笔记吧']) {
      expect(scoreAttention(message(text), empty).kind, text).toBe('CAPABILITY_ACTION')
    }
    for (const text of ['我已经 创建项目', '他说 创建项目', '我打算 创建项目', '创建项目 这个功能不错', '他让我 创建项目', '创建项目真的方便', '创建项目需要注意权限', '用户反馈请问如何创建项目', '他说创建项目，后来又讨论了权限', '文档中创建项目需要注意权限', '我已经创建了项目', '我准备创建一个项目']) {
      expect(scoreAttention(message(text), empty).kind, text).not.toBe('CAPABILITY_ACTION')
    }
  })

  it('能力请求保留子句级否定并报告长文弱请求的位置权重', () => {
    const denied = '背景资料'.repeat(150) + '。创建项目需要注意权限。' + '补充材料'.repeat(150)
    expect(scoreAttention(message(denied), empty).kind).not.toBe('CAPABILITY_ACTION')
    const weak = '背景资料'.repeat(250) + '。创建项目。' + '补充材料'.repeat(250)
    const decision = scoreAttention(message(weak), empty)
    expect(decision.kind).toBe('CAPABILITY_ACTION')
    expect(decision.capabilityStrength).toBe('weak')
    expect(decision.capabilityPositionWeight).toBeCloseTo(.55, 1)
  })

  it('只在完整快照和已接受锚点内计算话题衰减', () => {
    const anchor = { platformMessageId: 'reply-anchor', sentAtMs: now - 124_000, recipientSenderId: null, accepted: true, proactive: true, sourceAttentionKind: 'proactive', finalText: '翻个跟斗——来了，落地了', deliveryId: 'delivery-anchor' }
    const snapshot: AttentionSnapshot = { complete: true, messages: [], latestAcceptedFinal: anchor, acceptedOutboundFacts: [anchor] }
    const decision = scoreAttention(message('他哪会翻跟斗'), snapshot)
    expect(decision.state).toBe('TOPIC')
    expect(decision.topicRawScore).toBeCloseTo(.75, 2)
    expect(decision.score).toBeCloseTo(68.34, 0)
    expect(scoreAttention(message('他哪会翻跟斗'), { ...snapshot, complete: false }).state).toBe('COLD')
  })

  it('话题局部编辑匹配复用 Python 候选规则，忽略不相关话题', () => {
    const decision = scoreAttention(message('这咋回事'), topicSnapshot('翻个跟斗', 20))
    expect(decision.sceneType).toBe('ASK')
    expect(decision.sceneScore).toBeCloseTo(.765)
    expect(decision.topicScore).toBe(0)
    expect(scoreAttention(message('他哪会翻跟斗啊'), topicSnapshot('翻个跟斗')).topicRawScore).toBeCloseTo(.75)
    expect(topicEditSimilarity('挺好听', '真好听')[0]).toBeCloseTo(2 / 3)
    expect(topicEditSimilarity('翻跟斗', '个翻跟斗')[0]).toBe(0)
    expect(topicCpSimilarity('我也这样觉得', '嗯我也这样觉得')[0]).toBeCloseTo(.7638, 3)
  })

  it('成员主动只按已接受的收件人事实和严格180秒窗口', () => {
    const fact = { platformMessageId: 'reply', sentAtMs: now - 179_000, recipientSenderId: 'member-a', accepted: true, sourceAttentionKind: 'member_ACTIVE' }
    expect(scoreAttention(message('改成明天吧'), { ...empty, acceptedOutboundFacts: [fact] }).kind).toBe('MEMBER_ACTIVE')
    expect(scoreAttention(message('改成明天吧'), { ...empty, acceptedOutboundFacts: [{ ...fact, sentAtMs: now - 180_000 }] }).kind).toBe('PASSIVE')
    expect(scoreAttention(message('谢谢'), { ...empty, acceptedOutboundFacts: [fact] }).kind).toBe('PASSIVE')
  })

  it('模式阈值只影响普通分数，autonomous 模式保留硬排除规则', () => {
    expect(decideAttention(message('为什么延期。'), empty, 'natural').kind).toBe('PASSIVE')
    expect(decideAttention(message('为什么延期。'), empty, 'active').kind).toBe('PROACTIVE')
    expect(decideAttention(message('你好'), empty, 'autonomous').kind).toBe('ALLOW_RUN')
    expect(decideAttention(message('你好', { mentionedOtherMember: true }), empty, 'autonomous').kind).toBe('EXCLUDED')
  })

  it('开发沙盒复用同一 scorer、保留 Python DTO 且不回显正文', () => {
    expect(attentionDefaults().algorithm_version).toBe('attention-v3.0.7')
    const result = scoreAttentionSandbox({ anchor_text: '翻个跟斗——来了，落地了', text: '他哪会翻跟斗', gap_seconds: 124 }, 1_800_000_000_000)
    expect(result.state).toBe('TOPIC')
    expect(result.kind).toBe('PROACTIVE')
    expect(result.score).toBeCloseTo(68.34, 0)
    expect(JSON.stringify(result)).not.toContain('翻个跟斗')
  })

  it('问句标点与显式称呼按 Python 子句边界计分', () => {
    const cases: Array<[string, number, number]> = [
      ['为什么延期？', 1, .9], ['为什么延期', 1, .9], ['为什么延期。', .65, .585],
      ['请问为什么延期。', 1, .9], ['我想问为什么延期。', 1, .9],
    ]
    for (const [text, punctuation, score] of cases) {
      const result = scoreAttention(message(text), empty)
      expect(result.askPunctuationWeight, text).toBeCloseTo(punctuation)
      expect(result.askAdjustedScore, text).toBeCloseTo(score)
    }
    const laterStop = scoreAttention(message('为什么延期？我觉得主要是资源问题。'), empty)
    expect(laterStop.askPunctuationWeight).toBe(1)
    expect(laterStop.askSpanStart).toBe(0)
    const addressed = '背景资料'.repeat(300) + '。咕咕，我想问这个项目为什么延期？。' + '补充材料'.repeat(300)
    expect(scoreAttention(message(addressed), empty).askAdjustedScore).toBeCloseTo(.9)
  })

  it('长文问句择最佳证据，代码与引述不构成主动请求', () => {
    const text = '项目为什么延期？' + '背景资料'.repeat(200) + '。这个项目为什么延期？。' + '补充材料'.repeat(200) + '。项目如何上线？'
    const edge = scoreAttention(message(text), empty)
    expect(edge.askRawScore).toBeCloseTo(.9)
    expect(edge.askPositionWeight).toBeGreaterThan(.9)
    expect(edge.askPunctuationWeight).toBe(1)
    expect(edge.askSpanStart! < 40 || edge.askSpanStart! > text.length - 40).toBe(true)

    const request = '咕咕帮我看看'
    const code = '\n```python\n' + "raise Exception('咕咕看吧?')\n".repeat(800) + '```\n这是材料'
    expect(scoreAttention(message(request + code), empty, { botAliases: ['咕咕'] }).sceneScore).toBeCloseTo(.92)
    expect(scoreAttention(message('我只是转述：‘咕咕帮我看看’'), empty, { botAliases: ['咕咕'] }).sceneScore).toBe(0)
    const malformed = scoreAttention(message('```咕咕看吧'), empty, { botAliases: ['咕咕'] })
    expect(malformed.sceneScore).toBe(0)
    expect(malformed.reasons).toContain('segmentation_uncertain')
  })

  it('话题相似度保留局部编辑规则、长文采样及融合方式', () => {
    expect(topicEditSimilarity('他哪会翻跟斗', '翻个跟斗')[0]).toBeCloseTo(.75)
    expect(topicEditSimilarity('翻个跟斗', '翻个跟斗')[0]).toBe(0)
    expect(topicEditSimilarity('我也这样觉得', '嗯我也这样觉得')[0]).toBe(0)
    expect(topicEditSimilarity('這個', '那个')[0]).toBe(0)
    const cp = topicCpSimilarity('我也这样觉得', '嗯我也这样觉得')
    expect(cp[0]).toBeCloseTo(.7638, 3)
    expect(cp[1]).toBe(1)
    expect(cp[2]).toBe(6)

    const units = attentionTopicUnits(Array.from({ length: 80 }, (_, index) => `主题片段${index}`).join('。'))
    expect(units).toHaveLength(4)
    expect(units.every(unit => Array.from(unit).length <= 64)).toBe(true)
    expect(units[0]).not.toBe(units[units.length - 1])

    const fused = scoreAttention(message('Python 连接池超时怎么处理？'), topicSnapshot('今晚音乐真好听', 20))
    expect(fused.sceneScore).toBeCloseTo(.9)
    expect(fused.score).toBeCloseTo(90 + fused.topicScore * 10, 0)
  })

  it('话题上下文只收锚点附近可见消息并要求完整、已投递正文', () => {
    const before = message('火车到站了吗', { eventId: `${now - 35_000}-0`, eventReceivedMs: now - 35_000, platformMessageId: 'before' })
    const after = message('翻个跟斗可以吗', { eventId: `${now - 1_000}-0`, eventReceivedMs: now - 1_000, platformMessageId: 'after' })
    const future = message('翻个跟斗', { eventId: `${now + 5_000}-0`, eventReceivedMs: now + 5_000, platformMessageId: 'future' })
    const current = message('他哪会翻跟斗')
    const snapshot = topicSnapshot('音视频播放有一点延迟', 30, [before, after, future])
    const decision = scoreAttention(current, snapshot)
    expect(decision.topicMatchEventId).toBe(`${now - 1_000}-0`)
    expect(decision.topicMatchEventId).not.toBe(`${now + 5_000}-0`)
    expect(scoreAttention(current, { ...topicSnapshot('翻个跟斗'), complete: false }).state).toBe('COLD')
    expect(scoreAttention(current, topicSnapshot('翻个跟斗', 600)).topicScore).toBe(0)

    const noBody = { platformMessageId: 'reply-anchor', sentAtMs: now - 1_000, recipientSenderId: null, accepted: true, deliveryId: 'delivery-anchor' }
    const missingBody = scoreAttention(message('翻跟斗'), { complete: true, messages: [], latestAcceptedFinal: noBody })
    expect(missingBody.state).toBe('COLD')
    expect(missingBody.topicScore).toBe(0)
    expect(missingBody.anchorEventId).toBeNull()
  })

  it('结构化收件人优先于评分且成员主动回合严格限定接收人', () => {
    expect(decideAttention(message('谢谢', { mentionedCurrentBot: true }), empty, 'quiet').kind).toBe('DIRECT')
    expect(decideAttention(message('咕咕看吧', { mentionedOtherMember: true }), topicSnapshot('翻跟斗'), 'autonomous').kind).toBe('EXCLUDED')
    const current = message('这个办法为什么有效？', { replyToPlatformMessageId: 'bot-reply', replyTargetIsBot: true })
    const trusted = { platformMessageId: 'bot-reply', sentAtMs: now - 1_000, recipientSenderId: 'member-a', accepted: true, finalText: '办法' }
    expect(decideAttention(current, { complete: false, messages: [], botReplies: { 'bot-reply': trusted } }, 'natural').kind).toBe('CONTINUE')
    expect(decideAttention(current, { complete: false, messages: [], botReplies: { 'bot-reply': { ...trusted, recipientSenderId: 'member-b' } } }, 'natural').kind).toBe('PROACTIVE')

    const active = { platformMessageId: 'accepted-reply', sentAtMs: now - 1_000, recipientSenderId: 'member-a', accepted: true, sourceAttentionKind: 'DIRECT', finalText: '回复', deliveryId: 'delivery-member-active' }
    expect(decideAttention(message('改成明天吧'), { ...empty, acceptedOutboundFacts: [active] }, 'natural').kind).toBe('MEMBER_ACTIVE')
    for (const fact of [
      { ...active, sentAtMs: now }, { ...active, sentAtMs: now - 180_000 },
      { ...active, recipientSenderId: 'member-b' }, { ...active, accepted: false },
      { ...active, sourceAttentionKind: 'tool' }, { ...active, sentAtMs: now + 1_000 },
    ]) expect(decideAttention(message('改成明天吧'), { ...empty, acceptedOutboundFacts: [fact] }, 'natural').kind).toBe('PASSIVE')
    expect(decideAttention(message('谢谢，咕咕帮我查'), empty, 'natural', { botAliases: ['咕咕'] }).score).toBeCloseTo(92)
  })
})

import { casefoldSearchText } from '../../search/unicode.js'
import { normalizeAttentionText, buildLogicalCandidates } from './normalization.js'
import { questionEvidence } from './question.js'
import { visibleAttentionUnits } from './visible-units.js'
import { capabilityActionEvidence } from './capability-evidence.js'
import { attentionTopicEvidence, hasValidTopicAnchor } from './topic-evidence.js'
import { ATTENTION_THRESHOLDS, MEMBER_ACTIVE_TTL_MS } from './types.js'
import type { AttentionDecision, AttentionMessage, AttentionMode, AttentionSnapshot } from './types.js'

export { buildLogicalCandidates }

const actionRoots = new Set(Array.from('看瞧望读听闻摸尝观察说讲聊问答回述写画唱演评夸查找搜寻想猜算数比选判认知记学做弄搞改修测试验检排整合理拆装设调换转翻拍录发传贴交给送拿取放存删加减开关启停连接来去走跑跳坐站进出上下带陪帮教'))
const reportingRoots = new Set(Array.from('说讲问答回听知懂想觉得称提写引述记报'))
const personReference = new Set(Array.from('我你您他她它咱俺吾人谁各众全群'))
const pureReactions = new Set('好 好的 收到 谢谢 嗯 嗯嗯 哦 哦哦 是的 对 对的 没错 懂了 可以 行 ok 好滴 嗯呢 了解 明白 明白了 知道了 哈哈 哈哈哈 哈哈哈哈 666 草 笑死 笑死了 👍 👌 😂 🤣 好家伙 绷不住了 我笑了'.split(' '))
const ambiguousReactions = new Set(['确实', '离谱', '太好了', '这也行', '怎么这么离谱'])

function blankDecision(values: Partial<AttentionDecision> = {}): AttentionDecision {
  return {
    kind: 'PASSIVE', score: null, threshold: null, reasons: [], scoreBreakdown: [], state: null,
    sceneType: null, sceneScore: 0, topicScore: 0, topicRawScore: 0, anchorEventId: null,
    topicMatchEventId: null, matchedSpanLengths: null, askRawScore: 0, askPositionWeight: 1,
    askPunctuationWeight: 1, askAdjustedScore: 0, askSpanStart: null, askSpanEnd: null,
    capabilityStrength: null, capabilitySpanStart: null, capabilitySpanEnd: null,
    capabilityPositionWeight: null, ...values,
  }
}

function isReported(unit: string): boolean {
  const chars = Array.from(normalizeAttentionText(unit)), compact = chars.join('')
  if (!compact || compact.startsWith('我想知') || compact.startsWith('我想问')) return false
  const group = ['有人', '别人', '群友'].some(prefix => compact.startsWith(prefix))
  if (personReference.has(chars[0]!) || group) {
    let at = group ? 2 : 1
    if (!group && chars[at] === '们') at++
    while (at < Math.min(chars.length, 6) && '刚才之前'.includes(chars[at]!)) at++
    if (at < chars.length && reportingRoots.has(chars[at]!)) return true
    if (at + 1 < chars.length && '不没无'.includes(chars[at]!) && reportingRoots.has(chars[at + 1]!)) return true
  }
  return chars.length >= 2 && chars[0] === '听' && reportingRoots.has(chars[1]!)
}

function actionOccurrence(unit: string): { root: string; start: number; end: number } | null {
  const compact = normalizeAttentionText(unit)
  const matches = [...actionRoots].flatMap(root => {
    const at = compact.indexOf(root)
    return at < 0 ? [] : [{ root, start: at, end: at + root.length }]
  })
  return matches.sort((a, b) => a.start - b.start || b.root.length - a.root.length || a.root.localeCompare(b.root))[0] ?? null
}

function callScore(unit: string, aliases: readonly string[]): number {
  const compact = normalizeAttentionText(unit)
  if (!compact || isReported(unit)) return 0
  const normalized = [...new Set(aliases.map(normalizeAttentionText).filter(Boolean))].sort((a, b) => b.length - a.length)
  const alias = normalized.find(item => compact.startsWith(item))
  let remainder = alias ? compact.slice(alias.length) : compact
  let addressee = Boolean(alias)
  if (!addressee) {
    const match = /^(?:请|麻烦|帮我|帮忙|能否|可以)(?!大家|各位|你们)/u.exec(compact)
    addressee = Boolean(match)
    if (match) remainder = compact.slice(match[0].length)
  }
  if (!addressee || !remainder || /(?:起来|过了|到了|走了|来了|说了|讲了|看着|正在|已经|想起了|知道了)/u.test(remainder)) return 0
  const action = actionOccurrence(remainder)
  if (!action) return 0
  const tail = remainder.slice(action.end)
  if (!tail && '说讲问想知懂觉得'.includes(action.root)) return 0
  if (/(?:了|过|着|在|已|曾|将|起来|起来了|出来了)$/u.test(tail)) return 0
  const actionEnd = remainder.slice(0, action.end) + tail
  const imperative = /(?:吧|快|赶快|快点|别|请|一下|帮我|帮忙|给我|替我|为我)$/u.test(actionEnd)
    || /(.)\1(?:这个|一下|一遍|看看|说说|读读|查查|试试|想想)?/u.test(remainder)
    || /^(?:别|勿|莫|快|赶快|快点|帮|替|给|让|叫)/u.test(remainder)
  if (imperative) return .92
  if (tail && !/^(?:吗|呢|吧|啊|呀|哦|嘛|哈|哇|呐|啦|哟|了|过|着)?$/u.test(tail)) return .92 * .9
  return .92 * .8
}

interface SceneDetails {
  score: number
  kind: string | null
  uncertain: boolean
  askRaw: number
  askPosition: number
  askPunctuation: number
  askAdjusted: number
  askStart: number | null
  askEnd: number | null
}

function positionWeight(position: number, visibleLength: number): number {
  const alpha = Math.min(1, Math.max(0, (visibleLength - 200) / 600))
  const edgeWeight = .55 + .45 * Math.abs(2 * position - 1)
  return 1 - alpha * (1 - edgeWeight)
}

function sceneScore(message: AttentionMessage, aliases: readonly string[]): SceneDetails {
  const source = message.candidateText || message.rawText
  const { units, uncertain, visiblePrefix } = visibleAttentionUnits(source)
  const visibleLength = visiblePrefix.at(-1) ?? 0
  const aliasSet = new Set(aliases.map(normalizeAttentionText).filter(Boolean))
  const expanded = units.map((unit, index) => ({
    text: aliasSet.has(normalizeAttentionText(unit.text)) && units[index + 1] ? `${unit.text}${units[index + 1]!.text}` : unit.text,
  }))
  let best = 0, kind: string | null = null
  for (const unit of expanded) {
    const value = callScore(unit.text, aliases)
    if (value > best) { best = value; kind = 'CALL' }
  }
  let askRaw = 0, askPosition = 1, askPunctuation = 1, askAdjusted = 0
  let askStart: number | null = null, askEnd: number | null = null
  for (let index = 0; index < units.length; index++) {
    const unit = units[index]!
    const next = units[index + 1]
    const isAlias = Boolean(next && aliasSet.has(normalizeAttentionText(unit.text)))
    const text = isAlias ? `${unit.text}${next!.text}` : unit.text
    const end = isAlias ? next!.end : unit.end
    const [strength, scaffold] = questionEvidence(text)
    if (!strength) continue
    const raw = .9 * strength
    const visibleStart = visiblePrefix[unit.start] ?? 0, visibleEnd = visiblePrefix[end] ?? visibleLength
    const position = visibleLength ? (visibleStart + visibleEnd) / (2 * visibleLength) : .5
    const explicitTarget = [...aliasSet].some(alias => normalizeAttentionText(text).startsWith(alias))
    const weight = explicitTarget ? 1 : positionWeight(position, visibleLength)
    const punctuation = unit.terminator === '。' && !scaffold && !explicitTarget ? .65 : 1
    const adjusted = raw * weight * punctuation
    if (adjusted > askAdjusted) {
      askRaw = raw; askPosition = weight; askPunctuation = punctuation; askAdjusted = adjusted
      askStart = unit.start; askEnd = end
    }
    if (adjusted > best) { best = adjusted; kind = 'ASK' }
  }
  return { score: best, kind, uncertain, askRaw, askPosition, askPunctuation, askAdjusted, askStart, askEnd }
}

function isPureReaction(message: AttentionMessage): boolean {
  const units = visibleAttentionUnits(message.candidateText || message.rawText).units
  if (units.length !== 1) return false
  const value = casefoldSearchText(units[0]!.text.normalize('NFKC')).replace(/^[\s，,。.!！~～]+|[\s，,。.!！~～]+$/gu, '')
  return pureReactions.has(value)
}

function isAmbiguousReaction(message: AttentionMessage): boolean {
  const raw = (message.candidateText || message.rawText).normalize('NFKC').trim()
  const value = casefoldSearchText(raw).replace(/^[\s，,。.!！~～]+|[\s，,。.!！~～]+$/gu, '')
  return ambiguousReactions.has(value) && !raw.includes('?') && !raw.includes('？')
}

function otherRecipient(message: AttentionMessage): boolean {
  if (message.mentionedCurrentBot === true) return false
  if (message.mentionedOtherBot === true || message.mentionedOtherMember === true) return true
  return message.replyToPlatformMessageId !== null && message.replyTargetIsBot === false
}

function verifiedSubstantiveReply(message: AttentionMessage, snapshot: AttentionSnapshot): boolean {
  if (message.replyTargetIsBot !== true || !message.replyToPlatformMessageId || !message.senderId) return false
  const fact = snapshot.botReplies?.[message.replyToPlatformMessageId]
  if (!fact?.accepted || fact.recipientSenderId !== message.senderId || isPureReaction(message)) return false
  return visibleAttentionUnits(message.candidateText || message.rawText).units.some(unit => Array.from(normalizeAttentionText(unit.text)).length >= 3)
}

function hasMemberActiveReply(message: AttentionMessage, snapshot: AttentionSnapshot): boolean {
  if (!message.senderId) return false
  const qualifying = new Set(['DIRECT', 'member_CONTINUE', 'CAPABILITY_ACTION', 'proactive', 'autonomous', 'member_ACTIVE'])
  return (snapshot.acceptedOutboundFacts ?? []).some(fact => {
    const age = message.eventReceivedMs - fact.sentAtMs
    return fact.accepted && fact.recipientSenderId === message.senderId && typeof fact.sourceAttentionKind === 'string'
      && qualifying.has(fact.sourceAttentionKind) && age > 0 && age < MEMBER_ACTIVE_TTL_MS
  })
}

export function scoreAttention(message: AttentionMessage, snapshot: AttentionSnapshot, options: { botAliases?: readonly string[] } = {}): AttentionDecision {
  if (message.senderIsBot === true || !message.eventId) return blankDecision({ score: 0, reasons: ['invalid_or_bot_echo'], state: 'COLD' })
  if (message.mentionedCurrentBot === true) return blankDecision({ kind: 'DIRECT', score: 100, threshold: 0, reasons: ['native_mention'], state: 'COLD' })
  if (otherRecipient(message)) return blankDecision({ kind: 'EXCLUDED', score: 0, reasons: ['other_recipient'], state: 'COLD' })
  if (verifiedSubstantiveReply(message, snapshot)) return blankDecision({ kind: 'CONTINUE', score: 100, threshold: 0, reasons: ['verified_substantive_reply'], state: 'TOPIC' })
  const raw = message.candidateText || message.rawText
  if (!raw.trim()) return blankDecision({ score: 0, reasons: ['empty_message'], state: 'COLD' })
  if (isPureReaction(message) || isAmbiguousReaction(message)) return blankDecision({ score: 0, reasons: ['pure_short_reaction'], state: 'COLD' })
  if (raw.trim() === '?' || raw.trim() === '？') return blankDecision({ score: 0, reasons: ['bare_question_mark'], state: 'COLD' })
  const capability = capabilityActionEvidence(message)
  if (capability) return blankDecision({
    kind: 'CAPABILITY_ACTION', reasons: ['capability_action'], state: 'CAPABILITY_ACTION',
    capabilityStrength: capability.match.strength, capabilitySpanStart: capability.match.start,
    capabilitySpanEnd: capability.match.end, capabilityPositionWeight: capability.weight,
  })
  if (hasMemberActiveReply(message, snapshot)) return blankDecision({
    kind: 'MEMBER_ACTIVE', score: 100, reasons: ['member_active_window'],
    scoreBreakdown: [['member_active', 1]], state: 'MEMBER_ACTIVE',
  })
  const aliases = options.botAliases?.length ? options.botAliases : ['咕咕']
  const scene = sceneScore(message, aliases)
  const [topic, rawTopic, matchId, matchLengths] = attentionTopicEvidence(message, snapshot)
  const state = hasValidTopicAnchor(message, snapshot) ? 'TOPIC' : 'COLD'
  const score = state === 'TOPIC' ? 100 * (scene.score + topic - scene.score * topic) : 100 * scene.score
  const reasons = [`state_${state.toLowerCase()}`]
  if (scene.kind) reasons.push(`scene_${scene.kind.toLowerCase()}`)
  if (topic) reasons.push('topic_match')
  if (scene.uncertain) reasons.push('segmentation_uncertain')
  return blankDecision({
    kind: score > 0 ? 'PROACTIVE' : 'PASSIVE', score, reasons,
    scoreBreakdown: [['scene', scene.score], ['topic', topic], ['ask_raw', scene.askRaw], ['ask_position_weight', scene.askPosition], ['ask_punctuation_weight', scene.askPunctuation], ['ask_adjusted', scene.askAdjusted]],
    state, sceneType: scene.kind, sceneScore: scene.score, topicScore: topic, topicRawScore: rawTopic,
    anchorEventId: state === 'TOPIC' ? snapshot.latestAcceptedFinal?.deliveryId ?? null : null,
    topicMatchEventId: matchId, matchedSpanLengths: matchLengths,
    askRawScore: scene.askRaw, askPositionWeight: scene.askPosition,
    askPunctuationWeight: scene.askPunctuation, askAdjustedScore: scene.askAdjusted,
    askSpanStart: scene.askStart, askSpanEnd: scene.askEnd,
  })
}

export function decideAttention(message: AttentionMessage, snapshot: AttentionSnapshot, mode: AttentionMode, options: {
  botAliases?: readonly string[]; naturalThreshold?: number; activeThreshold?: number; quietThreshold?: number
} = {}): AttentionDecision {
  const result = scoreAttention(message, snapshot, options)
  if (['DIRECT', 'CONTINUE', 'CAPABILITY_ACTION', 'MEMBER_ACTIVE', 'EXCLUDED'].includes(result.kind)) return result
  if (mode === 'autonomous') {
    if (['invalid_or_bot_echo', 'empty_message', 'pure_short_reaction', 'bare_question_mark'].some(reason => result.reasons.includes(reason))) return result
    return { ...result, kind: 'ALLOW_RUN', threshold: null, reasons: [...result.reasons, 'autonomous_mode'] }
  }
  if (result.kind === 'PASSIVE' && result.score === 0) return result
  const threshold = mode === 'quiet' ? options.quietThreshold ?? ATTENTION_THRESHOLDS.quiet
    : mode === 'active' ? options.activeThreshold ?? ATTENTION_THRESHOLDS.active
      : options.naturalThreshold ?? ATTENTION_THRESHOLDS.natural
  if ((result.score ?? 0) < threshold) return { ...result, kind: 'PASSIVE', threshold, reasons: [...result.reasons, 'below_threshold'] }
  return { ...result, kind: 'PROACTIVE', threshold, reasons: [...result.reasons, 'threshold_reached'] }
}

export interface ScoredAttentionCandidate {
  message: AttentionMessage
  decision: AttentionDecision
}

/**
 * 统一 Web Host 与 Desktop 从一批群消息中选择 Agent 触发项的规则。
 * ASK 是否可延迟处理由宿主能力决定；不支持延迟唤醒的宿主应显式关闭 allowAsk。
 */
export function selectAttentionCandidate<T extends ScoredAttentionCandidate>(
  candidates: readonly T[], mode: AttentionMode, options: { allowAsk?: boolean } = {},
): T | null {
  const eligible = new Set(['ALLOW_RUN', 'DIRECT', 'CONTINUE', 'CAPABILITY_ACTION', 'MEMBER_ACTIVE'])
  const canAsk = options.allowAsk !== false
  if (mode === 'autonomous') return candidates.find(candidate => eligible.has(candidate.decision.kind)) ?? null
  return candidates.find(candidate => eligible.has(candidate.decision.kind))
    ?? candidates.find(candidate => candidate.decision.kind === 'PROACTIVE'
      && (canAsk || candidate.decision.sceneType !== 'ASK'))
    ?? null
}

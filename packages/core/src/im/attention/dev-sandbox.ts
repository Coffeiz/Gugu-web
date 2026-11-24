import { getAttentionDefaults, type AttentionDefaults } from './defaults.js'
import { attentionMessageFromPayload } from './message.js'
import { decideAttention } from './algorithm.js'
import { ATTENTION_ALGORITHM_VERSION, type AttentionMode, type AttentionSnapshot, type BotReplyFact } from './types.js'

export interface AttentionSandboxInput {
  text: string
  anchor_text?: string
  before_anchor?: readonly string[]
  after_anchor?: readonly string[]
  gap_seconds?: number
  member_active_age_seconds?: number | null
  aliases?: readonly string[]
  mode?: AttentionMode
  snapshot_complete?: boolean
}

export interface AttentionSandboxResult {
  algorithm_version: string
  kind: string
  score: number | null
  threshold: number | null
  state: string | null
  scene_type: string | null
  scene_score: number
  ask_raw_score: number
  ask_position_weight: number
  ask_punctuation_weight: number
  ask_adjusted_score: number
  ask_span_start: number | null
  ask_span_end: number | null
  capability_strength: string | null
  capability_span_start: number | null
  capability_span_end: number | null
  capability_position_weight: number | null
  topic_score: number
  topic_raw_score: number
  reasons: string[]
  score_breakdown: { rule: string; weight: number }[]
  anchor_event_id: string | null
  topic_match_event_id: string | null
  matched_span_lengths: readonly [number, number] | null
  snapshot_complete: boolean
}

export function attentionDefaults(): AttentionDefaults { return getAttentionDefaults() }

function sandboxMessage(text: string, at: number, ordinal: number, sender: string, senderIsBot = false) {
  return attentionMessageFromPayload(`${at}-${ordinal}`, {
    platform: 'sandbox', channel_id: 'sandbox', chat_id: 'sandbox', platform_user_id: sender,
    sender_is_bot: senderIsBot, text, native_bot_mentioned: false, mentions_other_bot: false,
    mentions_other_member: false,
  })
}

export function scoreAttentionSandbox(input: AttentionSandboxInput, nowMs = Date.now()): AttentionSandboxResult {
  const gapSeconds = input.gap_seconds ?? 30
  const anchorAt = nowMs - gapSeconds * 1_000
  const messages = (input.before_anchor ?? []).slice(-5).map((text, index, list) =>
    sandboxMessage(text, anchorAt - (list.length - index) * 1_000, index + 1, `member-${index + 1}`))
  for (const [index, text] of (input.after_anchor ?? []).slice(0, 5).entries()) {
    const at = Math.min(nowMs - 1, anchorAt + (index + 1) * 1_000)
    if (at > anchorAt) messages.push(sandboxMessage(text, at, index + 20, `member-${index + 20}`))
  }
  const current = sandboxMessage(input.text, nowMs, 99, 'member-current')
  const anchor: BotReplyFact = {
    platformMessageId: 'sandbox-accepted-anchor', sentAtMs: anchorAt, recipientSenderId: null,
    accepted: Boolean(input.anchor_text), sourceAttentionKind: 'proactive',
    finalText: input.anchor_text || null, deliveryId: 'sandbox-delivery',
  }
  const active: BotReplyFact | null = input.member_active_age_seconds == null ? null : {
    platformMessageId: 'sandbox-member-active', sentAtMs: nowMs - input.member_active_age_seconds * 1_000,
    recipientSenderId: 'member-current', accepted: true, sourceAttentionKind: 'member_ACTIVE',
    finalText: null, deliveryId: 'sandbox-member-active-delivery',
  }
  const snapshot: AttentionSnapshot = {
    messages, complete: input.snapshot_complete ?? true,
    latestAcceptedFinal: input.anchor_text ? anchor : null,
    acceptedOutboundFacts: [input.anchor_text ? anchor : null, active].filter((fact): fact is BotReplyFact => fact !== null),
  }
  const decision = decideAttention(current, snapshot, input.mode ?? 'natural', { botAliases: input.aliases ?? ['咕咕'] })
  return {
    algorithm_version: ATTENTION_ALGORITHM_VERSION, kind: decision.kind, score: decision.score,
    threshold: decision.threshold, state: decision.state, scene_type: decision.sceneType,
    scene_score: decision.sceneScore, ask_raw_score: decision.askRawScore,
    ask_position_weight: decision.askPositionWeight, ask_punctuation_weight: decision.askPunctuationWeight,
    ask_adjusted_score: decision.askAdjustedScore, ask_span_start: decision.askSpanStart,
    ask_span_end: decision.askSpanEnd, capability_strength: decision.capabilityStrength,
    capability_span_start: decision.capabilitySpanStart, capability_span_end: decision.capabilitySpanEnd,
    capability_position_weight: decision.capabilityPositionWeight, topic_score: decision.topicScore,
    topic_raw_score: decision.topicRawScore, reasons: [...decision.reasons],
    score_breakdown: decision.scoreBreakdown.map(([rule, weight]) => ({ rule, weight })),
    anchor_event_id: decision.anchorEventId, topic_match_event_id: decision.topicMatchEventId,
    matched_span_lengths: decision.matchedSpanLengths, snapshot_complete: snapshot.complete,
  }
}

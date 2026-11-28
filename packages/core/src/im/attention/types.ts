/** 群聊注意力算法的可信事实；正文只作为输入，不进入诊断输出。 */
export const ATTENTION_ALGORITHM_VERSION = 'attention-v3.0.7'
export const MEMBER_ACTIVE_TTL_MS = 180_000
export const ATTENTION_THRESHOLDS = Object.freeze({ quiet: 85, natural: 65, active: 55 })

export type AttentionMode = 'quiet' | 'natural' | 'active' | 'autonomous'
export type AttentionKind = 'ALLOW_RUN' | 'DIRECT' | 'CONTINUE' | 'CAPABILITY_ACTION' | 'MEMBER_ACTIVE' | 'PROACTIVE' | 'EXCLUDED' | 'PASSIVE'

export interface AttentionMessage {
  eventId: string
  platform: string
  botId: string
  groupId: string
  platformMessageId: string | null
  senderId: string | null
  eventReceivedMs: number
  platformSentMs: number | null
  rawText: string
  mediaOnly: boolean
  mediaKinds: readonly string[]
  processableMedia: boolean | null
  mentionedCurrentBot: boolean | null
  mentionedOtherBot: boolean | null
  mentionedOtherMember: boolean | null
  hasUnresolvedMention: boolean
  replyToPlatformMessageId: string | null
  replyTargetSenderId: string | null
  replyTargetIsBot: boolean | null
  quoteText: string | null
  senderIsBot: boolean | null
  candidateText: string | null
}

export interface BotReplyFact {
  platformMessageId: string
  sentAtMs: number
  recipientSenderId: string | null
  accepted: boolean
  proactive?: boolean
  sourceAttentionKind?: string | null
  finalText?: string | null
  deliveryId?: string | null
}

export interface AttentionSnapshot {
  messages: readonly AttentionMessage[]
  complete: boolean
  botReplies?: Readonly<Record<string, BotReplyFact>>
  windowTruncated?: boolean | null
  latestAcceptedFinal?: BotReplyFact | null
  acceptedOutboundFacts?: readonly BotReplyFact[]
}

export interface AttentionDecision {
  kind: AttentionKind
  score: number | null
  threshold: number | null
  reasons: readonly string[]
  scoreBreakdown: readonly (readonly [string, number])[]
  state: string | null
  sceneType: string | null
  sceneScore: number
  topicScore: number
  topicRawScore: number
  anchorEventId: string | null
  topicMatchEventId: string | null
  matchedSpanLengths: readonly [number, number] | null
  askRawScore: number
  askPositionWeight: number
  askPunctuationWeight: number
  askAdjustedScore: number
  askSpanStart: number | null
  askSpanEnd: number | null
  capabilityStrength: string | null
  capabilitySpanStart: number | null
  capabilitySpanEnd: number | null
  capabilityPositionWeight: number | null
}

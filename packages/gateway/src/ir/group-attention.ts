import { buildLogicalCandidates, decideAttention, selectAttentionCandidate } from '@gugu/core/im/attention/algorithm'
import { attentionMessageFromPayload } from '@gugu/core/im/attention/message'
import type { AttentionDecision, AttentionMessage, AttentionMode, BotReplyFact } from '@gugu/core/im/attention/types'

const windowMs = 10 * 60_000
const maxMessagesPerGroup = 80
const maxGroups = 500

export interface ImGroupAttentionInput {
  platform: 'feishu' | 'telegram'
  botId: string
  groupId: string
  mode: AttentionMode
  payload: Readonly<Record<string, unknown>>
  nowMs?: number
}

export interface ImGroupAttentionHistoryMessage {
  id: number
  createdAt: string
  content: string
  platformUserId: string | null
}

export interface ImGroupAttentionHistory {
  messages: readonly ImGroupAttentionHistoryMessage[]
  acceptedFacts: readonly BotReplyFact[]
  complete: boolean
}

function historyMessage(input: ImGroupAttentionInput, message: ImGroupAttentionHistoryMessage): AttentionMessage | null {
  const createdAtMs = Date.parse(message.createdAt)
  if (!Number.isSafeInteger(message.id) || message.id < 1 || !Number.isSafeInteger(createdAtMs)
    || createdAtMs < 1 || typeof message.content !== 'string') return null
  return {
    eventId: `${createdAtMs}-${message.id}`, platform: input.platform, botId: input.botId, groupId: input.groupId,
    platformMessageId: null, senderId: message.platformUserId, eventReceivedMs: createdAtMs, platformSentMs: null,
    rawText: message.content, mediaOnly: false, mediaKinds: [], processableMedia: null,
    mentionedCurrentBot: null, mentionedOtherBot: null, mentionedOtherMember: null,
    hasUnresolvedMention: /(?<![A-Za-z0-9_])@[A-Za-z0-9_]+/u.test(message.content),
    replyToPlatformMessageId: null, replyTargetSenderId: null, replyTargetIsBot: null,
    quoteText: null, senderIsBot: false, candidateText: message.content,
  }
}

/** Desktop 群聊复用 Core 参与度算法；出站锚点只接受平台已回执并持久化的事实。 */
export function createImGroupAttentionGate() {
  const history = new Map<string, AttentionMessage[]>()
  let sequence = 0

  return {
    evaluate(input: ImGroupAttentionInput, persistedHistory?: ImGroupAttentionHistory): { run: boolean; decision: AttentionDecision } {
      const nowMs = input.nowMs ?? Date.now()
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || !input.botId || !input.groupId) {
        throw new Error('群聊参与度上下文无效')
      }
      const key = JSON.stringify([input.platform, input.botId, input.groupId])
      const previous = history.get(key) ?? []
      const recent = persistedHistory === undefined
        ? previous.filter(message => message.eventReceivedMs >= nowMs - windowMs)
        : persistedHistory.messages.map(message => historyMessage(input, message))
          .filter((message): message is AttentionMessage => message !== null && message.eventReceivedMs >= nowMs - windowMs)
      const eventId = `${nowMs}-${++sequence}`
      const payload: Record<string, unknown> = { ...input.payload, platform: input.platform,
        bot_id: input.botId, chat_type: 'group', chat_id: input.groupId }
      const current = attentionMessageFromPayload(eventId, payload)
      const candidates = buildLogicalCandidates([...recent, current])
      const subject = candidates.find(message => message.eventId === eventId) ?? current
      const acceptedFacts = persistedHistory?.acceptedFacts.filter(fact => fact.accepted === true
        && Number.isSafeInteger(fact.sentAtMs) && fact.sentAtMs <= nowMs && typeof fact.finalText === 'string' && !!fact.finalText.trim()) ?? []
      const botReplies: Record<string, BotReplyFact> = Object.create(null) as Record<string, BotReplyFact>
      for (const message of [...recent, current]) {
        if (message.replyTargetIsBot !== true || !message.replyToPlatformMessageId || !message.senderId) continue
        const fact = acceptedFacts.find(item => item.platformMessageId === message.replyToPlatformMessageId
          && item.recipientSenderId === message.senderId && item.sentAtMs <= message.eventReceivedMs)
        if (fact) botReplies[message.replyToPlatformMessageId] = fact
      }
      const latestAcceptedFinal = [...acceptedFacts].sort((a, b) => b.sentAtMs - a.sentAtMs)[0] ?? null
      const snapshot = { messages: recent, complete: persistedHistory?.complete === true && recent.every(message => !!message.senderId),
        acceptedOutboundFacts: acceptedFacts, botReplies, latestAcceptedFinal }
      const decision = decideAttention(subject, snapshot, input.mode,
        { botAliases: ['咕咕'] })
      const mentioned = payload.native_bot_mentioned === true || payload.bot_mentioned === true || payload.group_mentioned === true
      const run = mentioned || selectAttentionCandidate([{ message: subject, decision }], input.mode, { allowAsk: false }) !== null

      recent.push(current)
      history.delete(key)
      history.set(key, recent.slice(-maxMessagesPerGroup))
      if (history.size > maxGroups) history.delete(history.keys().next().value!)
      return { run, decision }
    },
  }
}

import type { Pool } from 'pg'
import { buildLogicalCandidates, decideAttention, selectAttentionCandidate } from '@gugu/core/im/attention/algorithm'
import { attentionMessageFromPayload } from '@gugu/core/im/attention/message'
import { normalizeAttentionText } from '@gugu/core/im/attention/normalization'
import { strip } from '@gugu/core/shared/values'
import type { ImPendingAskResume, ImPendingAskScope } from '@gugu/gateway'
import type { AttentionDecision, AttentionMessage, AttentionMode, AttentionSnapshot } from '@gugu/core/im/attention/types'
import type { createPostgresRedisImAttentionSnapshot } from './snapshot.js'
import type { createRedisImPendingAskStore } from '../interactions/ask.js'
import type { ImAttentionVoiceReadInput, ImAttentionVoiceResult } from './voice.js'

export interface ImAttentionCandidate { eventId: string; payload: Readonly<Record<string, unknown>> }
export interface ImAttentionOutcome {
  disposition: 'run' | 'passive' | 'pending' | 'bypass'
  subject: ImAttentionCandidate | null
  decision: AttentionDecision | null
  configVersion: number
  mode: AttentionMode
  replyChoice: 'pending' | 'reply'
}
const invalid = () => new Error('群自动回复决策不可用')

/** 不创建Agent循环。调用方必须把首次disposition持久化；只有可信pending唤醒可重评原ASK。 */
export function createPostgresImAttentionRuntime(options: {
  pool: Pick<Pool, 'query'>
  snapshot: ReturnType<typeof createPostgresRedisImAttentionSnapshot>
  pending: ReturnType<typeof createRedisImPendingAskStore>
  prepareVoice?(input: ImAttentionVoiceReadInput, signal: AbortSignal): Promise<readonly ImAttentionVoiceResult[]>
  now?(): number
}) {
  return {
    async evaluate(input: { scope: ImPendingAskScope; sessionId: number; candidates: readonly ImAttentionCandidate[]; resume?: ImPendingAskResume }, signal: AbortSignal): Promise<ImAttentionOutcome> {
      const { scope, sessionId, resume } = input
      signal.throwIfAborted()
      if (!['qq', 'feishu', 'telegram'].includes(scope.platform) || !scope.ownerId || !/^[1-9]\d*$/u.test(scope.botId)
        || !scope.groupId || !Number.isSafeInteger(sessionId) || sessionId < 1 || !input.candidates.length || input.candidates.length > 1000) throw invalid()
      const statement = `SELECT b.group_requires_at,b.group_read_enabled,b.group_attention_mode,b.group_attention_config_version,b.name
        FROM user_bots b JOIN users u ON u.id=b.user_id
        JOIN conversation_sessions s ON s.user_id=b.user_id AND s.source=b.platform AND s.bot_id=b.id::text
        WHERE b.user_id=$1 AND b.id=$2::integer AND b.platform=$3 AND b.enabled IS TRUE
          AND u.is_active IS TRUE AND COALESCE(u.account_status,'active')='active'
          AND (CASE WHEN b.platform='feishu' THEN COALESCE(b.feishu_group_chat_enabled,true) ELSE b.group_chat_enabled END) IS TRUE
          AND s.id=$4 AND s.chat_type='group' AND s.chat_id=$5`
      const parameters = [scope.ownerId, scope.botId, scope.platform, sessionId, scope.groupId]
      const policy = await options.pool.query(statement, parameters)
      const row = policy.rows[0]
      if (policy.rows.length !== 1 || !row || typeof row.group_requires_at !== 'boolean' || typeof row.group_read_enabled !== 'boolean'
        || !Number.isSafeInteger(row.group_attention_config_version) || row.group_attention_config_version < 0) throw invalid()
      const mode: AttentionMode = ['quiet', 'natural', 'active', 'autonomous'].includes(row.group_attention_mode) ? row.group_attention_mode : 'autonomous'
      const configVersion = row.group_attention_config_version as number
      const outcome = async (disposition: ImAttentionOutcome['disposition'], subject: ImAttentionCandidate | null, decision: AttentionDecision | null): Promise<ImAttentionOutcome> => {
        signal.throwIfAborted()
        const fresh = await options.pool.query(statement, parameters)
        if (fresh.rows.length !== 1 || JSON.stringify(fresh.rows[0]) !== JSON.stringify(row)) throw invalid()
        return { disposition, subject, decision, configVersion, mode, replyChoice: disposition === 'run' ? 'pending' : 'reply' }
      }
      const byId = new Map<string, ImAttentionCandidate>()
      const parsed: AttentionMessage[] = []
      for (const candidate of input.candidates) {
        const p = candidate.payload
        if (p.owner_user_id !== scope.ownerId || p.platform !== scope.platform || p.bot_id !== scope.botId || p.chat_type !== 'group' || p.chat_id !== scope.groupId
          || typeof p.platform_user_id !== 'string' || !p.platform_user_id || typeof p.text !== 'string') throw invalid()
        if (byId.has(candidate.eventId)) throw invalid()
        byId.set(candidate.eventId, candidate); parsed.push(attentionMessageFromPayload(candidate.eventId, p))
      }
      if (resume) {
        if (resume.scope.ownerId !== scope.ownerId || resume.scope.botId !== scope.botId || resume.scope.platform !== scope.platform
          || resume.scope.groupId !== scope.groupId || input.candidates.length !== 1
          || parsed[0]!.eventId !== resume.trigger.eventId || parsed[0]!.senderId !== resume.trigger.senderId
          || parsed[0]!.eventReceivedMs !== resume.trigger.eventMs || !await options.pending.isIssued(resume,signal) || !await options.pending.isCurrent(resume, signal)
          || await options.pending.isCancelled(resume, signal)) return outcome('passive', null, null)
      }
      if (!resume) for (const [index, message] of parsed.entries()) {
        const payload = input.candidates[index]!.payload
        const directMention = payload.has_unresolved_mention !== true && (payload.native_bot_mentioned === true
          || payload.mentions_other_bot !== true && (payload.bot_mentioned === true || payload.group_mentioned === true))
        await options.pending.observe(scope, { eventMs: message.eventReceivedMs, senderId: message.senderId!,
          ownBotId: typeof payload.platform_bot_user_id === 'string' ? payload.platform_bot_user_id : undefined,
          replyTo: message.replyToPlatformMessageId ?? undefined, directMention }, signal)
      }
      // 仅原全量自动回复启用选择门；明确@及只读/仅@模式由正常Ingress处理。
      if (row.group_requires_at || row.group_read_enabled || input.candidates.some(c => c.payload.group_mentioned === true)) return outcome('bypass', null, null)
      let augmented = parsed
      // 对齐Python：非autonomous在完整批次评分前预转写，不能因后条DIRECT跳过前条语音。
      // prepareVoice只接受Host证明的附件；此处仅投影内存消息，subject及持久原载荷不变。
      if (mode !== 'autonomous' && options.prepareVoice) {
        const transcripts = await options.prepareVoice({ scope, sessionId, candidates: input.candidates }, signal)
        signal.throwIfAborted()
        if (!Array.isArray(transcripts) || transcripts.length > input.candidates.length * 100) throw invalid()
        const seen = new Set<string>(), byEvent = new Map<string, string[]>()
        for (const result of transcripts) {
          const candidate = result && byId.get(result.eventId)
          const attachments = candidate?.payload.attachments
          if (!candidate || typeof result.attachId !== 'string' || !result.attachId || !Array.isArray(attachments)
            || !attachments.some(item => item === result.attachId || !!item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).attach_id === result.attachId)
            || result.text !== null && (typeof result.text !== 'string' || result.text.length > 200_000)) throw invalid()
          const key = JSON.stringify([result.eventId, result.attachId])
          if (seen.has(key)) throw invalid()
          seen.add(key)
          const text = result.text === null ? '' : strip(result.text)
          if (text) byEvent.set(result.eventId, [...(byEvent.get(result.eventId) ?? []), text])
        }
        augmented = parsed.map(message => {
          const texts = byEvent.get(message.eventId)
          if (!texts?.length) return message
          const value: Record<string, unknown> = { ...byId.get(message.eventId)!.payload,
            text: [message.rawText, ...texts].filter(Boolean).join('\n'), media_only: false }
          delete value.attention_raw_text
          return attentionMessageFromPayload(message.eventId, value)
        })
      }
      const messages = mode === 'autonomous' ? parsed : buildLogicalCandidates(augmented)
      const aliases = [...new Set(['咕咕', typeof row.name === 'string' ? row.name : ''].map(normalizeAttentionText).filter(Boolean))]
      const watermarkMs = resume?.trigger.eventMs ?? (options.now ?? Date.now)()
      const snapshot: AttentionSnapshot = mode === 'autonomous' ? { messages: [], complete: false }
        : await options.snapshot.load({ scope, sessionId, messages, watermarkMs }, signal)
      const scored = messages.map(message => ({ message, decision: decideAttention(message,
        { ...snapshot, messages: snapshot.messages.filter(m => m.eventId !== message.eventId && (!resume || m.eventReceivedMs <= message.eventReceivedMs)) }, mode, { botAliases: aliases }) }))
      const selected = selectAttentionCandidate(mode === 'autonomous' ? scored.slice(0, 1) : scored, mode)
      if (!selected) return outcome('passive', null, scored.sort((a, b) => (b.decision.score ?? 0) - (a.decision.score ?? 0))[0]?.decision ?? null)
      const { message, decision } = selected
      const subject = byId.get(message.eventId)!
      if (decision.kind === 'PROACTIVE' && decision.sceneType === 'ASK' && !resume
        && message.mentionedCurrentBot !== true && !aliases.some(a => normalizeAttentionText(message.candidateText || message.rawText).startsWith(a))) {
        if (!message.platformMessageId || !message.senderId) throw invalid()
        const registered = await options.pending.register(scope, { eventId: message.eventId, eventMs: message.eventReceivedMs,
          platformMessageId: message.platformMessageId, senderId: message.senderId, payload: { ...subject.payload, session_id: sessionId } }, signal)
        if (registered) return outcome('pending', subject, { ...decision, reasons: [...decision.reasons, 'pending_ask_waiting'] })
        return outcome('passive', null, decision)
      }
      if (!resume) await options.pending.cancel(scope, Math.max(...messages.map(m => m.eventReceivedMs)), signal)
      signal.throwIfAborted()
      return outcome('run', subject, decision)
    },
  }
}

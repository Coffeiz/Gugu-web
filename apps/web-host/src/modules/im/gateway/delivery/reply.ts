import { questionBatchText, readQuestionBatch } from '@gugu/core/agent'
import { resolveQqNoticeTarget } from '@gugu/gateway/qq'
import { createImRequestedReply } from '@gugu/gateway'
import { createHmac } from 'node:crypto'
import type { Pool } from 'pg'
import type { ImRunDeliveryPorts } from '@gugu/core/im/run-delivery'
import { createPostgresInteractionProjection } from '../../../agent/interactions/projection.js'
import { createImRunArtifactSender } from './artifacts.js'
import { createImRunScope } from '../agent/scope.js'
import type { createPostgresImControls } from '../attention/controls.js'
import { imAcceptedEvidence } from '../agent/evidence.js'
import { readTrustedQqMessageFormat } from '../reply-settings.js'

type ArtifactOptions = Parameters<typeof createImRunArtifactSender>[0]
const same = (a: ArtifactOptions['identity'], b: ArtifactOptions['identity']) => a.ownerId === b.ownerId && a.sessionId === b.sessionId && a.runId === b.runId
const invalid = () => new Error('IM 运行回复装配不可用')
function appOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password || url.search || url.hash) throw invalid()
    return url.origin
  } catch { throw invalid() }
}

/** 旧版无原生交互的平台仅展示安全文字；不把动作token或secret字段值拼进文案。 */
function interactionText(prompt: Awaited<ReturnType<ReturnType<typeof createPostgresInteractionProjection>['interaction']>>, publicAppUrl: string | null, platform: string, group: boolean): string {
  const title = typeof prompt.title === 'string' && prompt.title ? prompt.title : '需要确认', body = typeof prompt.body === 'string' ? prompt.body : ''
  const questions = readQuestionBatch({ questions: prompt.questions })
  if (questions) return `${title}
${questionBatchText(questions, 0)}`
  const prefix = prompt.task_paused ? '⏸️ 任务已暂停，等待确认。\n' : ''
  if (prompt.options.length) return `${prefix}${title}\n${body}\n${prompt.options.map((option, index) => `${index + 1}. ${option.label || option.id || '选项'}`).join('\n')}\n${prompt.allow_text_input
    ? '请回复选项序号或选项文字；如需其他回答，请回复“自定义回复”后发送内容。' : '请直接回复选项序号或选项文字。'}`
  if (prompt.secret_fields.length) {
    let link = ''
    if (publicAppUrl) {
      link = `${appOrigin(publicAppUrl)}/?mcp_credential_prompt=${prompt.prompt_id}`
    }
    return `${title}\n${body}\n${group ? '群聊不接收凭据。请在登录后的私密网页表单中填写，或改用 Bot 私聊。' : '请打开网页继续补全 MCP 凭据。'}${link ? '\n' + link : ''}`
  }
  return `${prefix}${title}\n${body}\n${['wechat', 'feishu'].includes(platform) ? '请直接回复你的答案。' : '请在网页中填写后提交。'}`
}

/** 一个Run的正式出站资源；共享Core receipts独占幂等，不在这里新增另一份发送账本。 */
export async function createImRunSender(options: ArtifactOptions & {
  pool: Pick<Pool, 'query' | 'connect'>
  nativeInteraction: ImRunDeliveryPorts<unknown>['sender']['interaction']
  controls: Pick<ReturnType<typeof createPostgresImControls>, 'authorizeNativeTarget'>
  publicAppUrl: string | null
}): Promise<ImRunDeliveryPorts<unknown>['sender']> {
  const proof = createImRunScope(options), { identity, actor, scope, payload, binding } = proof
  const projection = createPostgresInteractionProjection(options.pool, options.secretKey)
  if (typeof options.nativeInteraction !== 'function' || typeof options.controls?.authorizeNativeTarget !== 'function') throw invalid()
  if (options.publicAppUrl) appOrigin(options.publicAppUrl)
  async function qqFormat(): Promise<'compat' | 'markdown'> {
    return readTrustedQqMessageFormat(options.pool, binding, scope.chatType)
  }
  const source = await proof.read()
  const format = scope.platform === 'qq' ? await qqFormat() : null
  const guard = async () => { try { await proof.read(); return format === null || await qqFormat() === format } catch { return false } }
  async function text(input: Parameters<ImRunDeliveryPorts<unknown>['sender']['text']>[0], extraAuthorize?: () => Promise<boolean>, kind: 'text' | 'interaction' | 'tool' | 'compaction' = 'text'): ReturnType<ImRunDeliveryPorts<unknown>['sender']['text']> {
    try {
      if (!same(input.identity, identity)) return 'rejected'
      const sourceMessage = scope.platform === 'qq' ? payload.message_id : payload.platform_message_id ?? payload.message_id
      const reply = createImRequestedReply(scope, { ownerId: input.identity.ownerId, deliveryId: input.deliveryId, text: input.text },
        typeof sourceMessage === 'string' ? sourceMessage : undefined)
      if (!reply) return 'rejected'
      const authorize = async () => await guard() && (!extraAuthorize || await extraAuthorize())
      if (!await authorize()) return 'rejected'
      const wire = options.sender(binding)
      if (!wire || wire.platform !== scope.platform) return 'rejected'
      const { recipient, originalMessageId: original } = reply
      const evidence = (receipt: Parameters<typeof imAcceptedEvidence>[0]['receipt']) => kind === 'tool' || kind === 'compaction' ? receipt.outcome
        : imAcceptedEvidence({ scope, source, recipient, kind, text: reply.text, receipt })
      if (wire.platform === 'telegram') return evidence(await wire.sender.text({ chatId: recipient, chatType: scope.chatType,
        ...(typeof original === 'string' ? { replyToMessageId: original } : {}) }, reply.text, { authorize }))
      if (wire.platform === 'feishu') return evidence(await wire.sender.text(recipient, reply.text, undefined, authorize))
      if (wire.platform === 'qq') {
        const target = kind === 'tool' || kind === 'compaction'
          ? resolveQqNoticeTarget(kind, original) : undefined
        if (target?.mode === 'rejected') return 'rejected'
        const members = scope.chatType === 'group' && /[@＠]/u.test(reply.text)
          ? await options.pool.query<{ id: string; name: string | null }>(`SELECT id,name FROM (
              SELECT DISTINCT ON (m.platform_user_id) m.platform_user_id AS id,
                NULLIF(btrim(m.platform_user_name),'') AS name,m.conversation_seq
              FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
              WHERE s.id=$1 AND s.user_id=$2 AND s.source='qq' AND s.bot_id=$3 AND s.chat_id=$4 AND s.chat_type='group'
                AND m.role='user' AND m.platform_user_id IS NOT NULL AND m.im_sender_is_bot IS NOT TRUE
              ORDER BY m.platform_user_id,m.conversation_seq DESC
            ) members ORDER BY conversation_seq DESC LIMIT 256`,
            [identity.sessionId, identity.ownerId, scope.botId, scope.chatId]).then(result => result.rows, () => [])
          : []
        const name = members.find(member => member.id === actor.platformUserId)?.name
        const mentionUserName = name && members.filter(member => member.name === name).length === 1 ? name : undefined
        return evidence(await wire.sender.text({ id: recipient, chatType: scope.chatType,
          messageFormat: format!, messageId: target?.mode === 'active' ? undefined : original,
          ...(scope.chatType === 'group' ? { mentionUserId: actor.platformUserId, mentionUserName,
            knownMemberIds: members.map(member => member.id) } : {}) }, reply.text, undefined, authorize))
      }
      if (scope.chatType !== 'c2c' || typeof payload.context_token !== 'string' || !payload.context_token) return 'rejected'
      return evidence(await wire.sender.text({ userId: scope.platformUserId, contextToken: payload.context_token }, reply.text, undefined, authorize))
    } catch { return 'unknown' }
  }
  return {
    text,
    compactionNotice: input => text(input, undefined, 'compaction'),
    toolNotice: input => scope.chatType === 'c2c' && (scope.platform === 'qq' || scope.platform === 'wechat')
      ? text(input, undefined, 'tool') : Promise.resolve('rejected'),
    artifact: createImRunArtifactSender(options),
    async interaction(input) {
      try {
        if (!same(input.identity, identity) || !same(input.event.identity, identity) || input.event.type !== 'interaction_required' || !await guard()) return 'rejected'
        if (scope.platform !== 'wechat') {
          const native = await options.nativeInteraction(input)
          if (native !== 'rejected' && !(typeof native === 'object' && native.outcome === 'rejected')) return native // 未知不能回退发第二条。
        }
        const rows = (await options.pool.query(`SELECT b.prompt_id,clock_timestamp()::text AS cutoff FROM agent_interaction_bindings b
          JOIN interaction_prompts p ON p.id=b.prompt_id AND p.user_id=b.user_id AND p.session_id=b.session_id
          WHERE b.user_id=$1 AND b.session_id=$2 AND b.run_id=$3 AND b.interaction_id=$4 AND b.tool_call_id=$5`,
        [identity.ownerId, identity.sessionId, identity.runId, input.event.payload.interactionId, input.event.payload.toolCallId])).rows
        if (rows.length !== 1) return 'rejected'
        const row = rows[0]!, target = { identity, promptId: Number(row.prompt_id), toolCallId: String(input.event.payload.toolCallId) }
        const eventId = createHmac('sha256', options.secretKey).update('gugu-im-outbound-prompt-v1\0').update(input.deliveryId).digest('hex')
        const controlScope = { ...scope, eventId, admissionCutoff: String(row.cutoff) }
        const authorize = () => options.controls.authorizeNativeTarget(controlScope, target, new AbortController().signal)
        if (!await authorize()) return 'rejected'
        const prompt = await projection.interaction(input.event)
        if (prompt.prompt_id !== target.promptId || prompt.resolved || !await authorize()) return 'rejected'
        return await text({ identity, deliveryId: input.deliveryId, text: interactionText(prompt, options.publicAppUrl, scope.platform, scope.chatType === 'group') }, authorize, 'interaction')
      } catch { return 'unknown' }
    },
  }
}

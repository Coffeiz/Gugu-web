import { createHmac, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { stableJson, type CancellationPort, type RunIdentity } from '@gugu/core/agent'
import type { ImPreflightScope } from '@gugu/core/im/inbound-preflight'
import { resolveImAccess } from '@gugu/core/im/access'
import { normalizeOwnerId } from '../../../../shared/owner-context.js'
import { withPostgresTransaction } from '../../../../adapters/database/postgres-transaction.js'
import { agentDispatchSource, decryptAgentDispatchInput } from '../../../agent/run/dispatch.js'
import { lockAgentRunSession } from '../../../agent/run/start.js'
import { createPostgresImAccess } from '../inbound/access.js'

export interface ImShortcutState {
  state: 'idle' | 'thinking' | 'waiting_confirm'; awaiting: boolean
  initiatorIds: readonly string[]; cancelReference?: string
}
export class ImShortcutUnavailable extends Error {
  constructor() { super('IM 快捷控制暂不可用'); this.name = 'ImShortcutUnavailable' }
}
interface Target { session_id: number; run_id: string; sequence: string; nonce: Buffer; payload: Buffer; state: string; status: string | null; admitted: boolean }
interface Receipt { reference: string; session_id: number; run_id: string; dispatch_sequence: string; facts_hash: string; state: string }
const idle = (): ImShortcutState => ({ state: 'idle', awaiting: false, initiatorIds: [] })
const fail = () => new ImShortcutUnavailable()

/** PostgreSQL冻结精确目标；Redis仅唤醒，不承载取消成功事实。 */
export function createPostgresImShortcut(options: {
  pool: Pick<Pool, 'connect'>; secretKey: string
  supportedPlatforms(): readonly string[] | Promise<readonly string[]>
  cancellation: Pick<CancellationPort, 'request' | 'notify'>
  wake(): void | Promise<void>
  diagnose(code: 'shortcut_notification_pending'): void
}) {
  if (!options.secretKey) throw fail()
  const hash = (value: unknown) => createHmac('sha256', options.secretKey).update('gugu-im-shortcut-v1\0').update(stableJson(value)).digest('hex')
  const conversationScope = (scope: ImPreflightScope) => createHmac('sha256',options.secretKey).update('gugu-im-conversation-v1\0')
    .update(stableJson([scope.ownerId,scope.platform,scope.botId,scope.chatType,scope.chatId ?? scope.platformUserId])).digest('hex')
  function checked(scope: ImPreflightScope) {
    if (normalizeOwnerId(scope.ownerId) !== scope.ownerId || !/^[1-9]\d{0,9}$/.test(scope.botId) || Number(scope.botId) > 2147483647
      || !['feishu','qq','wechat','telegram'].includes(scope.platform) || !['group','c2c'].includes(scope.chatType)
      || scope.chatType === 'c2c' && scope.chatId !== null
      || !scope.admissionCutoff || scope.admissionCutoff.length > 64) throw fail()
    for (const value of [scope.platformUserId, scope.eventId, ...(scope.chatType === 'group' ? [scope.chatId] : [])]) {
      if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x1f\x7f]/u.test(value)) throw fail()
    }
    return hash([scope.ownerId,scope.platform,scope.botId,scope.chatType,scope.chatId,scope.platformUserId,scope.eventId,scope.admissionCutoff])
  }
  async function authorized(client: PoolClient, scope: ImPreflightScope) {
    // 持锁至控制事务提交，避免权限检查后Bot/账户撤销与取消提交交错。
    await client.query(`SELECT b.id FROM user_bots b JOIN users u ON u.id=b.user_id WHERE b.id=$1 AND b.user_id=$2 AND b.platform=$3 FOR SHARE OF b,u`,[scope.botId,scope.ownerId,scope.platform])
    const bot = await createPostgresImAccess({ query: (q,p) => client.query(q,p), supportedPlatforms: options.supportedPlatforms }).readBot(scope)
    return bot !== null && (scope.chatType === 'group' || resolveImAccess(scope,bot).role === 'owner')
  }
  async function facts(client: PoolClient, scope: ImPreflightScope, target: Target) {
    const identity = { ownerId: scope.ownerId, sessionId: String(target.session_id), runId: target.run_id }
    const input = decryptAgentDispatchInput(options.secretKey, identity, target.nonce, target.payload)
    if (agentDispatchSource(input) !== 'im' || input.v !== 3 || input.source !== 'im') throw fail()
    const im = input.im
    if (im.platform !== scope.platform || im.botId !== scope.botId || im.chatType !== scope.chatType || im.chatId !== scope.chatId
      || scope.chatType === 'c2c' && im.platformUserId !== scope.platformUserId || !target.admitted) throw fail()
    const ids = im.batch?.messageIds ?? [input.userMessageId]
    const rows = (await client.query(`SELECT m.id,m.platform_user_id,m.chat_type,
        m.created_at<=$4::timestamptz AS admitted,r.platform,r.bot_id,r.chat_type AS receipt_chat_type,r.state,r.scope_hash,r.event_hash
      FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=$1
      LEFT JOIN gugu_im_inbound_receipts r ON r.user_id=s.user_id AND r.session_id=m.session_id AND r.message_id=m.id AND r.run_id=m.run_id
      WHERE m.session_id=$2 AND m.run_id=$3 AND m.role='user' ORDER BY m.id`,
    [scope.ownerId,target.session_id,target.run_id,scope.admissionCutoff])).rows
    if (rows.length !== ids.length || new Set(rows.map(row => row.id)).size !== ids.length || rows.some(row => !ids.includes(Number(row.id))
      || row.admitted !== true || row.platform !== scope.platform || row.bot_id !== scope.botId || row.receipt_chat_type !== scope.chatType
      || row.chat_type !== scope.chatType || row.state !== 'dispatched' || typeof row.platform_user_id !== 'string' || !row.platform_user_id
      || scope.chatType === 'c2c' && row.platform_user_id !== scope.platformUserId)) throw fail()
    // scope_hash来自conversation相同purpose；不相信仅有platform/Bot的宽泛JOIN。
    const conversationHash = conversationScope(scope)
    if (rows.some(row => row.scope_hash !== conversationHash)) throw fail()
    return { identity, initiators: [...new Set(rows.map(row => row.platform_user_id as string))].sort(),
      digest: hash([target.sequence, ids, rows.map(row => [row.id,row.platform_user_id,row.scope_hash,row.event_hash])]) }
  }
  async function targetRows(client: PoolClient, scope: ImPreflightScope, receipt?: Receipt) {
    return (await client.query<Target>(`SELECT d.session_id,d.run_id,d.sequence::text,d.nonce,d.payload,d.state,c.status,
        a.created_at<=$5::timestamptz AS admitted
      FROM agent_run_dispatch d JOIN conversation_sessions s ON s.id=d.session_id AND s.user_id=d.user_id
      JOIN agent_run_startups a ON a.user_id=d.user_id AND a.session_id=d.session_id AND a.run_id=d.run_id AND a.status<>'failed'
      LEFT JOIN agent_run_checkpoints c ON c.user_id=d.user_id AND c.session_id=d.session_id AND c.run_id=d.run_id
      WHERE d.user_id=$1 AND ($2::integer IS NULL OR d.session_id=$2) AND ($3::text IS NULL OR d.run_id=$3)
        AND ($4::bigint IS NULL OR d.sequence=$4) AND (d.state='selected' OR c.status='waiting')
        AND (c.status IS NULL OR c.status IN ('preparing','running','waiting'))
        AND EXISTS(SELECT 1 FROM gugu_im_inbound_receipts r WHERE r.user_id=d.user_id AND r.session_id=d.session_id AND r.run_id=d.run_id
          AND r.platform=$6 AND r.bot_id=$7 AND r.chat_type=$8 AND r.scope_hash=$9)
      ORDER BY CASE WHEN d.state='selected' THEN 0 ELSE 1 END,d.sequence DESC LIMIT 129`,
    [scope.ownerId,receipt?.session_id ?? null,receipt?.run_id ?? null,receipt?.dispatch_sequence ?? null,scope.admissionCutoff,scope.platform,scope.botId,scope.chatType,conversationScope(scope)])).rows
  }
  async function notify(identity: RunIdentity, eventHash: string) {
    try {
      await options.cancellation.request(identity); await options.cancellation.notify(identity); await options.wake()
      await withPostgresTransaction(options.pool, async client => { await client.query(`UPDATE gugu_im_shortcut_controls SET notification_pending=false WHERE user_id=$1 AND event_hash=$2 AND state='requested'`,[identity.ownerId,eventHash]) },fail)
    } catch { try { options.diagnose('shortcut_notification_pending') } catch { /* 诊断失败不改变已提交取消。 */ } }
  }
  return {
    async read(scope: ImPreflightScope): Promise<ImShortcutState> {
      try {
        const eventHash = checked(scope)
        return await withPostgresTransaction(options.pool, async client => {
          if (!await authorized(client,scope)) throw fail()
          const existing = (await client.query<Receipt>('SELECT * FROM gugu_im_shortcut_controls WHERE user_id=$1 AND event_hash=$2',[scope.ownerId,eventHash])).rows[0]
          const candidates = await targetRows(client,scope,existing)
          const valid: { target: Target; facts: Awaited<ReturnType<typeof facts>> }[] = []
          for (const target of candidates) {
            // 查询已限定原生scope；坏密文/证据错误交调用方降回Run，不假报idle。
            valid.push({ target, facts: await facts(client,scope,target) })
          }
          const selected = valid.filter(item => item.target.state === 'selected')
          const choices = selected.length ? selected : valid
          if (!choices.length) return idle()
          if (choices.length !== 1) throw fail()
          const item = choices[0]!, reference = existing?.reference ?? randomUUID()
          if (existing && existing.facts_hash !== item.facts.digest) throw fail()
          await client.query(`INSERT INTO gugu_im_shortcut_controls(user_id,event_hash,reference,session_id,run_id,dispatch_sequence,facts_hash,state)
            VALUES($1,$2,$3,$4,$5,$6,$7,'observed') ON CONFLICT(user_id,event_hash) DO NOTHING`,
          [scope.ownerId,eventHash,reference,item.target.session_id,item.target.run_id,item.target.sequence,item.facts.digest])
          const frozen = (await client.query<Receipt>('SELECT * FROM gugu_im_shortcut_controls WHERE user_id=$1 AND event_hash=$2',[scope.ownerId,eventHash])).rows[0]
          if (!frozen || frozen.facts_hash !== item.facts.digest || frozen.run_id !== item.target.run_id || frozen.session_id !== item.target.session_id) throw fail()
          return { state: item.target.status === 'waiting' ? 'waiting_confirm' : 'thinking', awaiting: item.target.status === 'waiting', initiatorIds: item.facts.initiators, cancelReference: frozen.reference }
        },fail)
      } catch { throw fail() }
    },
    async cancel(scope: ImPreflightScope, reference: string, signal?: AbortSignal): Promise<boolean> {
      try {
        const eventHash = checked(scope)
        if (!/^[a-f0-9-]{36}$/.test(reference) || signal?.aborted) return false
        const identity = await withPostgresTransaction(options.pool, async client => {
          const receipt = (await client.query<Receipt>('SELECT * FROM gugu_im_shortcut_controls WHERE user_id=$1 AND event_hash=$2 AND reference=$3',[scope.ownerId,eventHash,reference])).rows[0]
          if (!receipt) return null
          const identity = { ownerId:scope.ownerId,sessionId:String(receipt.session_id),runId:receipt.run_id }
          if (!await lockAgentRunSession(client,identity) || !await authorized(client,scope) || signal?.aborted) return null
          if (receipt.state === 'requested') return identity
          const target = (await targetRows(client,scope,receipt))[0]
          if (!target) return null
          const current = await facts(client,scope,target)
          if (current.digest !== receipt.facts_hash || !current.initiators.includes(scope.platformUserId)) return null
          // 等待Run可能已释放selected；仅把冻结的原Run恢复入队，不触碰新selected。
          const changed = await client.query(`UPDATE agent_run_dispatch d SET cancel_requested=true,
            state=CASE WHEN d.state='done' THEN CASE WHEN EXISTS(SELECT 1 FROM agent_run_dispatch other WHERE other.user_id=d.user_id AND other.session_id=d.session_id AND other.state='selected') THEN 'queued' ELSE 'selected' END ELSE d.state END,
            token=CASE WHEN d.state='done' THEN NULL ELSE d.token END,lease_expires_at=CASE WHEN d.state='done' THEN NULL ELSE d.lease_expires_at END
            WHERE d.user_id=$1 AND d.session_id=$2 AND d.run_id=$3 AND d.sequence=$4`,[scope.ownerId,receipt.session_id,receipt.run_id,receipt.dispatch_sequence])
          if (changed.rowCount !== 1) throw fail()
          await client.query(`UPDATE conversation_sessions SET pending_message_count=(SELECT count(*) FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND state='queued') WHERE user_id=$1 AND id=$2`,[scope.ownerId,receipt.session_id])
          await client.query(`UPDATE gugu_im_shortcut_controls SET state='requested',notification_pending=true WHERE user_id=$1 AND event_hash=$2`,[scope.ownerId,eventHash])
          return identity
        },fail)
        if (!identity) return false
        await notify(identity,eventHash)
        return true
      } catch { throw fail() }
    },
  }
}

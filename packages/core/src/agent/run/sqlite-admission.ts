import { parseAgentCommand, parseAgentGoalArgument } from '../commands/menu.js'
import { isAgentCommandHelpArgument } from '../commands/help.js'
import { readAgentSessionContext, projectAgentSessionGoal } from '../sessions/list.js'
import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import { CoreError, dataContext } from '../../contracts/index.js'
import { databaseTime, nowUtc } from '../../data/codec.js'
import type { Database } from '../../data/schema.js'
import type { RunIdentity, RunStatus } from '../models.js'
import { terminalRunStates } from './lifecycle.js'
import { claimDesktopChatAttachments } from '../attachments/desktop-store.js'
import type { DesktopAgentChatReference } from '../../contracts/desktop.js'
import { resolveDesktopChatReferences } from '../sessions/desktop-references.js'

export type DesktopGroupSender = { id: string; name?: string }

export interface SqliteAgentChatInput {
  session_id: number
  message: string
  queueClaim?: { key: number; token: string }
  client_message_id?: string
  attachments?: string[]
  references?: DesktopAgentChatReference[]
  groupSender?: DesktopGroupSender
  /** Gateway 已确认的桌面群延迟唤醒可复用同一条被动历史消息。 */
  resumePassiveMessage?: boolean
}

interface SessionRow { session_context: string | null; active_run_id: string | null; execution_state: string; last_message_seq: number }

function sessionScope(ownerId: string, session: number) {
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  if (!Number.isSafeInteger(session) || session < 1) throw new CoreError('invalid_request', '会话 ID 无效')
  return { owner, session }
}

async function readSession(db: Kysely<Database>, owner: string, session: number) {
  // 旧版可能写入问候却遗漏更新会话序号，入队时以已提交消息补齐序号。
  return (await sql<SessionRow>`SELECT s.active_run_id, s.execution_state, s.session_context,
    max(s.last_message_seq, coalesce((SELECT max(m.conversation_seq) FROM conversation_messages m
      WHERE m.session_id=s.id), 0)) AS last_message_seq
    FROM conversation_sessions s WHERE s.user_id=${owner} AND s.id=${session}
      AND (s.source IS NULL OR s.source='web')`.execute(db)).rows[0]
}

/**
 * 会话最新的等待态运行。
 * 对齐 PG 侧 currentRunId 的第三段回退：等待子代理的运行已经归还会话执行位，
 * 但它仍是这个会话对外可见的当前运行。
 */
async function readWaitingSqliteAgentRun(db: Kysely<Database>, owner: string, session: number) {
  const { rows } = await sql<{ run_id: string }>`SELECT c.run_id FROM agent_run_checkpoints c
    WHERE c.user_id=${owner} AND c.session_id=${session} AND c.status='waiting'
      AND NOT EXISTS(SELECT 1 FROM agent_run_controls t WHERE t.user_id=c.user_id AND t.session_id=c.session_id
        AND t.run_id=c.run_id AND t.startup_failed=1)
    ORDER BY c.updated_at_ms DESC, c.run_id DESC LIMIT 1`.execute(db)
  return rows[0]?.run_id ?? null
}

async function isFinished(db: Kysely<Database>, owner: string, session: number, run: string) {
  const result = await sql<{ status: RunStatus | null; startup_failed: number | null }>`
    SELECT c.status, d.startup_failed FROM agent_run_admissions a
    LEFT JOIN agent_run_checkpoints c ON (c.user_id,c.session_id,c.run_id)=(a.user_id,a.session_id,a.run_id)
    LEFT JOIN agent_run_controls d ON (d.user_id,d.session_id,d.run_id)=(a.user_id,a.session_id,a.run_id)
    WHERE a.user_id=${owner} AND a.session_id=${session} AND a.run_id=${run}`.execute(db)
  const state = result.rows[0]
  return state?.startup_failed === 1 || (state?.status != null && terminalRunStates.has(state.status))
}

/**
 * 普通调度和重启恢复共用准入索引。
 * 等待子代理的运行已经归还会话执行位，这里按 checkpoint 状态一并读出，
 * 否则重启后这类运行既不占用会话也找不到恢复入口。
 */
export async function listActiveSqliteAgentRuns(db: Kysely<Database>, ownerId: string, source?: string) {
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  const filter = source === undefined ? sql`` : sql`AND s.source=${source}`
  const { rows } = await sql<{ session_id: number; run_id: string; source: string | null }>`
    SELECT a.session_id,a.run_id,s.source FROM agent_run_admissions a
    JOIN conversation_sessions s ON s.id=a.session_id AND s.user_id=a.user_id AND s.active_run_id=a.run_id
    WHERE a.user_id=${owner} ${filter}
    UNION
    SELECT c.session_id,c.run_id,s.source FROM agent_run_checkpoints c
    JOIN conversation_sessions s ON s.id=c.session_id AND s.user_id=c.user_id
    WHERE c.user_id=${owner} AND c.status='waiting' ${filter}`.execute(db)
  return rows.map(row => ({ identity: { ownerId, sessionId: String(row.session_id), runId: row.run_id }, source: row.source }))
}

/** 调用方已在同一事务验证会话归属并写入本次输入消息。 */
export async function registerSqliteAgentRun(tx: Transaction<Database>, identity: RunIdentity,
  userMessageId: number, sequence: number, timestamp: string) {
  const { owner, session } = sessionScope(identity.ownerId, Number(identity.sessionId))
  await sql`INSERT INTO agent_run_admissions(user_id,session_id,run_id,user_message_id)
    VALUES(${owner},${session},${identity.runId},${userMessageId})`.execute(tx)
  await sql`UPDATE conversation_sessions SET active_run_id=${identity.runId},execution_state='running',
    last_message_seq=${sequence},updated_at=${timestamp} WHERE id=${session} AND user_id=${owner}`.execute(tx)
}

/** SQLite 会话与用户消息同事务登记。执行器只接收已经提交的可信运行身份。 */
export function createSqliteAgentAdmission(
  db: Kysely<Database>,
  options: {
    /** 新的用户消息提交后通知宿主补读。 */
    onCommitted?: (identity: RunIdentity) => void
    /** 宿主在同一事务冻结非公开运行配置；禁止在这里执行网络请求。 */
    bindRun?: (tx: Transaction<Database>, identity: RunIdentity, input: SqliteAgentChatInput, messageId: number) => Promise<void>
  } = {},
) {
  return {
    async prepare(ownerId: string, input: SqliteAgentChatInput) {
      const { owner, session } = sessionScope(ownerId, input.session_id)
      const message = typeof input.message === 'string' ? input.message.trim() : ''
      const clientId = input.client_message_id
      if (typeof input.message !== 'string' || (!message && !input.attachments?.length && !input.references?.length) || message.length > 32_000 || (clientId != null && !/^[A-Za-z0-9:_-]{1,64}$/.test(clientId)))
        throw new CoreError('invalid_request', '聊天请求无效')
      if (input.resumePassiveMessage !== undefined && typeof input.resumePassiveMessage !== 'boolean'
        || input.resumePassiveMessage === true && (!clientId || !input.groupSender || input.attachments?.length || input.references?.length))
        throw new CoreError('invalid_request', '群聊延迟唤醒参数无效')
      const prepared = await db.transaction().execute(async tx => {
        const current = await readSession(tx, owner, session)
        if (!current) throw new CoreError('not_found', '会话不存在')
        const sender = input.groupSender
        if (sender !== undefined) {
          if (!sender || typeof sender.id !== 'string' || !sender.id.trim() || sender.id.length > 256
            || (sender.name !== undefined && (typeof sender.name !== 'string' || sender.name.length > 256)))
            throw new CoreError('invalid_request', '群发言人资料无效')
          const group = await sql`SELECT 1 FROM desktop_im_sessions im JOIN conversation_sessions s
            ON s.id=im.session_id AND s.user_id=im.owner_id
            WHERE im.owner_id=${owner} AND im.session_id=${session} AND s.chat_type='group'`.execute(tx)
          if (!group.rows.length) throw new CoreError('invalid_request', '发言人资料仅适用于群会话')
        }
        let passiveMessageId: number | undefined
        if (clientId != null) {
          const previous = (await sql<{ run_id: string | null; id: number; content: string; files: string | null; references_json: string | null; platform_user_id: string | null; platform_user_name: string | null }>`
            SELECT a.run_id,m.id,m.content,m.files,m.references_json,m.platform_user_id,m.platform_user_name FROM conversation_messages m
            LEFT JOIN agent_run_admissions a ON a.session_id=m.session_id AND a.user_id=${owner} AND a.user_message_id=m.id
            WHERE m.session_id=${session} AND m.client_message_id=${clientId}`.execute(tx)).rows[0]
          if (previous) {
            const previousIds = previous.files ? (JSON.parse(previous.files) as Array<{ attach_id?: string }>).map(file => file.attach_id).filter(Boolean) : []
            const requestedIds = [...new Set(input.attachments ?? [])]
            const previousReferences = previous.references_json ? JSON.parse(previous.references_json) : []
            if (previous.run_id && previous.content === message && JSON.stringify(previousIds) === JSON.stringify(requestedIds)
              && JSON.stringify(previousReferences) === JSON.stringify(input.references ?? []))
              return { identity: { ownerId, sessionId: String(session), runId: previous.run_id }, userMessageId: previous.id, replay: true }
            const sessionType = (await sql<{ chat_type: string | null }>`SELECT chat_type FROM conversation_sessions
              WHERE id=${session} AND user_id=${owner}`.execute(tx)).rows[0]?.chat_type
            if (input.resumePassiveMessage !== true || sessionType !== 'group' || previous.run_id
              || previous.content !== message || previous.platform_user_id !== input.groupSender?.id
              || (input.groupSender?.name !== undefined && previous.platform_user_name !== input.groupSender.name)
              || previousIds.length || requestedIds.length || JSON.stringify(previousReferences) !== '[]'
              || (input.references?.length ?? 0) > 0)
              throw new CoreError('conflict', '消息标识已被使用')
            passiveMessageId = previous.id
          }
        }
        if (current.execution_state === 'baseline_updating'
          || current.active_run_id && !await isFinished(tx, owner, session, current.active_run_id))
          throw new CoreError('conflict', '会话已有运行中的任务')
        const identity = { ownerId, sessionId: String(session), runId: randomUUID() }
        const at = databaseTime(nowUtc(), 'sqlite')
        const sequence = passiveMessageId === undefined ? current.last_message_seq + 1 : current.last_message_seq
        const references = input.references ?? []
        if (references.length > 50) throw new CoreError('invalid_request', '引用数量超出限制')
        const referencedText = await resolveDesktopChatReferences(tx, ownerId, references, message)
        const contentJson = referencedText === message ? null : JSON.stringify([{ type: 'text', text: referencedText }])
        const { rows } = passiveMessageId === undefined ? await sql<{ id: number }>`INSERT INTO conversation_messages
          (session_id,conversation_seq,role,content,client_message_id,references_json,content_json,created_at,platform_user_id,platform_user_name)
          VALUES(${session},${sequence},'user',${message},${clientId ?? null},${references.length ? JSON.stringify(references) : null},${contentJson},${at},${sender?.id ?? null},${sender?.name ?? null}) RETURNING id`.execute(tx) : { rows: [{ id: passiveMessageId }] }
        const userMessageId = rows[0]!.id
        const files = await claimDesktopChatAttachments(tx, ownerId, userMessageId, input.attachments ?? [], session, clientId)
        if (!message && referencedText === message && !files.some(file => file.kind === 'text' || file.kind === 'image'
          || (file.kind === 'voice' && typeof file.transcript === 'string' && file.transcript.trim())))
          throw new CoreError('invalid_request', '此附件暂不能单独发送，请补充文字说明')
        if (files.length) await sql`UPDATE conversation_messages SET files=${JSON.stringify(files)} WHERE id=${userMessageId} AND session_id=${session}`.execute(tx)
        await registerSqliteAgentRun(tx, identity, userMessageId, sequence, at)
        const context = readAgentSessionContext(current.session_context, 'sqlite')
        const command = parseAgentCommand(message)
        if (command?.recognized && command.name === 'goal' && !isAgentCommandHelpArgument(command.argument)
          && parseAgentGoalArgument(command.argument) === 'create') {
          Object.assign(context, { goal_text: command.argument, goal_mode: true, goal_status: 'active' })
          await sql`UPDATE conversation_sessions SET session_context=${JSON.stringify(context)}
            WHERE id=${session} AND user_id=${owner}`.execute(tx)
        }
        await options.bindRun?.(tx, identity, input, userMessageId)
        return { identity, userMessageId, goalMode: projectAgentSessionGoal(context).goalActive }
      })
      if (!prepared.replay) {
        try { options.onCommitted?.(prepared.identity) } catch { /* 通知失败不影响已提交的消息。 */ }
      }
      return prepared
    },
    async requestCancel(ownerId: string, sessionId: number, runId: string) {
      const { owner, session } = sessionScope(ownerId, sessionId)
      const cancel = async (tx: Kysely<Database>) => {
        const admitted = await sql`SELECT 1 FROM agent_run_admissions WHERE user_id=${owner}
          AND session_id=${session} AND run_id=${runId}`.execute(tx)
        if (!admitted.rows.length) throw new CoreError('not_found', '会话或运行不存在')
        // 等待子代理的运行已经归还会话执行位，取消必须仍能命中它；
        // 只有已终态的运行才视为结束。
        const { rows } = await sql`INSERT INTO agent_run_controls(user_id,session_id,run_id,cancel_requested)
          SELECT user_id,id,${runId},1 FROM conversation_sessions
          WHERE user_id=${owner} AND id=${session} AND (active_run_id=${runId}
            OR NOT EXISTS(SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=${owner} AND c.session_id=${session}
              AND c.run_id=${runId} AND c.status IN (${sql.join([...terminalRunStates].map(status => sql`${status}`))})))
          ON CONFLICT(user_id,session_id,run_id) DO UPDATE SET cancel_requested=1 RETURNING run_id`.execute(tx)
        return { ok: true, outcome: rows.length ? 'requested' : 'already_completed' } as const
      }
      return db.isTransaction ? cancel(db) : db.transaction().execute(cancel)
    },
    async active(ownerId: string, sessionId: number, runId?: string) {
      const { owner, session } = sessionScope(ownerId, sessionId)
      const current = await readSession(db, owner, session)
      if (!current) return null
      if (runId !== undefined) {
        const existing = await sql`SELECT 1 FROM agent_run_admissions WHERE user_id=${owner} AND session_id=${session} AND run_id=${runId}`.execute(db)
        if (!existing.rows.length) return { identity: null, executionState: current.execution_state }
        return { identity: { ownerId, sessionId: String(session), runId }, executionState: current.execution_state }
      }
      // 正在执行的运行优先；它结束或归还会话后，回退到最新的等待态运行，
      // 界面才能继续读到等待子代理的那一轮输出。
      if (current.active_run_id && !await isFinished(db, owner, session, current.active_run_id))
        return { identity: { ownerId, sessionId: String(session), runId: current.active_run_id }, executionState: current.execution_state }
      const waiting = await readWaitingSqliteAgentRun(db, owner, session)
      if (!waiting) return { identity: null, executionState: current.execution_state }
      return { identity: { ownerId, sessionId: String(session), runId: waiting }, executionState: current.execution_state }
    },
  }
}

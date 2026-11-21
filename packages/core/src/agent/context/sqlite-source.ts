import { parseAgentCommand } from '../commands/menu.js'
import { GOAL_DONE_MARKER } from '../run/lifecycle.js'
import { readAgentSessionContext, projectAgentSessionGoal } from '../sessions/list.js'
import { sql, type Kysely, type Transaction } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import { databaseTime, integer, utc } from '../../data/codec.js'
import type { Database } from '../../data/schema.js'
import type { CanonicalRunContext, Json, RunIdentity } from '../models.js'
import type { ContextSourcePorts } from '../ports.js'
import { requireCanonicalSnapshotEffect } from './snapshot-effect.js'
import { resolveCurrentTurnTextAttachments, type CurrentTurnAttachment } from '../attachments/current-turn.js'
import { readDesktopTurnReferences, resolveDesktopChatReferences } from '../sessions/desktop-references.js'

function scope(ownerId: string, sessionId: string) {
  if (!/^[1-9]\d*$/.test(sessionId) || !Number.isSafeInteger(Number(sessionId))) throw new TypeError('Agent 会话身份无效')
  return { owner: dataContext(ownerId).ownerId.replaceAll('-', ''), session: Number(sessionId) }
}

type HistoryRow = {
  baseline: number; baseline_hash: string | null; snapshot_hash: string | null; source: string | null
  id: number | null; conversation_seq: number; history_anchor_seq: number | null; role: string; content: string
  content_json: string | null; covers_until_seq: number | null; run_id: string | null; round_id: string | null
  canonical_batch_id: number | null; created_at: string; sent_at: string | null; quoted_text: string | null; files: string | null
}

function json(value: string): Json {
  return JSON.parse(value) as Json
}

function historyContent(row: HistoryRow, files: Json[] | null): Json | undefined {
  const content = row.content_json === null ? undefined : json(row.content_json)
  if (row.role !== 'user' || !files) return content

  const transcripts = files.flatMap(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file) || file.kind !== 'voice'
      || typeof file.transcript !== 'string' || !file.transcript.trim()) return []
    return [{ type: 'text', text: `语音转写：${file.transcript.trim()}` }]
  })
  if (!transcripts.length) return content
  const existing = content == null
    ? (row.content ? [{ type: 'text', text: row.content }] : [])
    : (Array.isArray(content) ? content : [content])
  return [...existing, ...transcripts]
}

/** 本机来源只读取可信 owner 的会话。当前输入由已准入的 Run 定位。 */
export function createSqliteAgentSessionSource(
  db: Kysely<Database>,
  options: {
    readAttachmentText?(identity: RunIdentity, attachment: CurrentTurnAttachment): Promise<string>
    readReferencedFile?(id: string, signal?: AbortSignal): Promise<{ name: string; path: string; relativePath?: string; text: string | null } | null>
  } = {},
): Pick<ContextSourcePorts, 'historyReader' | 'readSnapshot' | 'currentTurn'> {
  return {
    historyReader: {
      async read(identity, signal) {
        signal?.throwIfAborted()
        const { owner, session } = scope(identity.ownerId, identity.sessionId)
        const { rows } = await sql<HistoryRow>`
          SELECT s.baseline_message_seq AS baseline,s.baseline_message_hash AS baseline_hash,s.snapshot_hash,s.source,
            m.id,m.conversation_seq,m.history_anchor_seq,m.role,m.content,m.content_json,m.covers_until_seq,
            m.run_id,m.round_id,m.canonical_batch_id,coalesce(anchor.created_at,m.created_at) AS created_at,
            m.sent_at,m.quoted_text,m.files
          FROM conversation_sessions s LEFT JOIN conversation_messages m ON m.session_id=s.id
          LEFT JOIN conversation_messages anchor ON anchor.session_id=s.id AND anchor.conversation_seq=m.history_anchor_seq
            AND anchor.role='user' AND anchor.run_id=m.run_id
          WHERE s.user_id=${owner} AND s.id=${session} AND (s.source IS NULL OR s.source='web')`.execute(db)
        signal?.throwIfAborted()
        const first = rows[0]
        if (!first) throw new Error('Agent 会话不存在')
        const baselineSeq = integer(first.baseline)
        return {
          baselineSeq,
          baselineIdentity: { baselineSeq, baselineHash: first.baseline_hash, snapshotHash: first.snapshot_hash },
          rows: rows.flatMap(row => {
            if (row.id === null) return []
            const files = row.files === null ? null : json(row.files)
            if (files !== null && !Array.isArray(files)) throw new Error('Agent 历史附件格式无效')
            return [{
              ...identity, id: String(row.id), conversationSeq: integer(row.conversation_seq), historyAnchorSeq: row.history_anchor_seq,
              role: row.role, content: row.content, contentJson: historyContent(row, files),
              coversUntilSeq: row.covers_until_seq, runId: row.run_id, roundId: row.round_id,
              canonicalBatchId: row.canonical_batch_id === null ? null : String(row.canonical_batch_id),
              createdAt: utc(row.created_at), sentAt: row.sent_at === null ? null : utc(row.sent_at),
              quote: row.quoted_text, files: files ?? undefined, source: row.source,
            }]
          }),
        }
      },
    },
    async readSnapshot(identity, signal) {
      signal?.throwIfAborted()
      const { owner, session } = scope(identity.ownerId, identity.sessionId)
      const { rows } = await sql<{
        context_epoch: number; session_context: string | null; snapshot_hash: string | null; session_info_hash: string | null
        snapshot_expires_at: string | null; baseline_message_seq: number
      }>`SELECT context_epoch,session_context,snapshot_hash,session_info_hash,snapshot_expires_at,baseline_message_seq
        FROM conversation_sessions WHERE user_id=${owner} AND id=${session} AND (source IS NULL OR source='web')`.execute(db)
      const row = rows[0]
      signal?.throwIfAborted()
      if (!row) return null
      const context = row.session_context === null ? null : json(row.session_context)
      if (context !== null && (typeof context !== 'object' || Array.isArray(context))) throw new Error('会话快照无效')
      return {
        ownerId: identity.ownerId, sessionId: identity.sessionId, contextEpoch: integer(row.context_epoch), context,
        snapshotHash: row.snapshot_hash, sessionInfoHash: row.session_info_hash,
        snapshotExpiresAt: row.snapshot_expires_at === null ? null : Date.parse(utc(row.snapshot_expires_at).replace(' ', 'T')),
        baselineMessageSeq: integer(row.baseline_message_seq),
      }
    },
    async currentTurn(identity, signal) {
      signal?.throwIfAborted()
      const { owner, session } = scope(identity.ownerId, identity.sessionId)
      const { rows } = await sql<{ id: number; content: string; files: string | null; session_context: string | null; created_at: string }>`
        SELECT m.id,m.content,m.files,s.session_context,m.created_at FROM agent_run_admissions a
        JOIN conversation_sessions s ON s.id=a.session_id AND s.user_id=a.user_id
        JOIN conversation_messages m ON m.id=a.user_message_id AND m.session_id=s.id AND m.role='user'
        WHERE a.user_id=${owner} AND a.session_id=${session} AND a.run_id=${identity.runId}
          AND (s.source IS NULL OR s.source='web')`.execute(db)
      signal?.throwIfAborted()
      const row = rows[0]
      if (!row) throw new Error('用户消息不存在')
      const cards = row.files === null ? [] : json(row.files)
      if (!Array.isArray(cards)) throw new Error('当前消息附件格式无效')
      const files = cards.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('当前消息附件格式无效')
        const card = value as Record<string, unknown>
        return { ...card, size: card.size ?? card.size_bytes } as unknown as CurrentTurnAttachment
      })
      const context = readAgentSessionContext(row.session_context, 'sqlite')
      const goal = projectAgentSessionGoal(context)
      const command = parseAgentCommand(row.content)
      const text = goal.goalActive && command?.name === 'goal' && command.argument === context.goal_text
        ? `请立即开始执行目标任务：${command.argument}` : row.content
      const prepared = await resolveCurrentTurnTextAttachments(text, files, attachment =>
        options.readAttachmentText ? options.readAttachmentText(identity, attachment) : Promise.resolve(''))
      const { references, inherited } = await readDesktopTurnReferences(db, identity)
      const imageIds = files.filter(file => file.kind === 'image').map(file => file.attach_id)
        .filter(id => /^[0-9a-f]{32}$/u.test(id))
      const input = imageIds.length
        ? [prepared.rawText, `用户上传了图片，可用 view_image 查看（attach_id：${imageIds.join('、')}）。`].filter(Boolean).join('\n\n')
        : prepared.rawText
      const rawText = await resolveDesktopChatReferences(db, identity.ownerId, references, input,
        options.readReferencedFile ? id => options.readReferencedFile!(id, signal) : undefined, inherited)
      return { currentUser: { persistedMessageId: String(row.id), rawText, messageTimestamp: utc(row.created_at),
        message: { role: 'user', content: goal.goalActive
          ? `${rawText}\n\n[目标任务] ${String(context.goal_text)}。仅当完整目标完成时，在答复末尾单独输出 ${GOAL_DONE_MARKER}，不要解释标记。`
          : rawText }, files: prepared.cards } }
    },
  }
}

export async function applySqliteAgentSnapshot(tx: Transaction<Database>, identity: RunIdentity, context: CanonicalRunContext) {
  const { effect, baseline } = requireCanonicalSnapshotEffect(identity, context)
  const { owner, session } = scope(identity.ownerId, identity.sessionId)
  const state = effect.state
  const expires = state.snapshotExpiresAt === null ? null : databaseTime(new Date(state.snapshotExpiresAt).toISOString(), 'sqlite')
  const snapshot = await preserveSqliteSessionGoal(tx, owner, session, state.context)
  const { rows } = await sql`UPDATE conversation_sessions SET session_context=${snapshot === null ? null : JSON.stringify(snapshot)},
    context_epoch=${state.contextEpoch},snapshot_hash=${state.snapshotHash},session_info_hash=${state.sessionInfoHash},snapshot_expires_at=${expires}
    WHERE user_id=${owner} AND id=${session} AND active_run_id=${identity.runId} AND context_epoch=${effect.expectedEpoch}
      AND snapshot_hash IS ${effect.expectedSnapshotHash} AND baseline_message_seq=${baseline.baselineSeq}
      AND baseline_message_hash IS ${baseline.baselineHash} RETURNING id`.execute(tx)
  if (!rows.length) throw new Error('会话快照已变化，拒绝提交')
}

/** 压缩和普通快照提交都保留事务内最新的目标控制状态。 */
export async function preserveSqliteSessionGoal(tx: Transaction<Database>, owner: string, session: number,
  snapshot: Record<string, Json> | null): Promise<Record<string, Json> | null> {
  if (snapshot === null) return null
  const { rows: [current] } = await sql<{ session_context: string | null }>`
    SELECT session_context FROM conversation_sessions WHERE user_id=${owner} AND id=${session}`.execute(tx)
  const control = current?.session_context ? JSON.parse(current.session_context) as Record<string, Json> | null : null
  const next = { ...snapshot }
  for (const key of ['goal_text', 'goal_status', 'goal_mode']) {
    if (control && Object.hasOwn(control, key)) next[key] = control[key]!
    else delete next[key]
  }
  return next
}

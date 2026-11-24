import { desktopDisplayMessage } from './data.js'
import { sql, type Kysely, type Transaction } from 'kysely'
import { CoreError, dataContext } from '../../contracts/index.js'
import { MAX_AGENT_RESPONSE, type DesktopAgentHistoryPage, type DesktopAgentMessage, type DesktopAgentSession } from '../../contracts/desktop.js'
import type { Database } from '../../data/schema.js'
import { databaseTime, nowUtc, utc } from '../../data/codec.js'
import { normalizeAgentSessionTitle } from './application.js'
import { createSqliteAgentAdmission } from '../run/sqlite-admission.js'
import { enqueueAgentRagRebuildInTransaction } from '../rag/rebuild-worker.js'
import { applyAgentGoalCommand, createSqlAgentSessionLister, projectAgentSessionGoal, readAgentSessionContext } from './list.js'
import { createSqlAgentInteractionHistory, readDelegatedPromptBindings } from './interaction-history.js'
import { projectAgentTimelineEvents } from './message-projection.js'
import { extractPlatformMentionIds, replacePlatformMentionIds } from '../context/messages/mentions.js'
import { createSqlAgentGroupNames } from './group-names.js'
import type { DesktopAgentChatReference } from '../../contracts/desktop.js'
export { resolveDesktopChatReferences } from './desktop-references.js'

/**
 * 会话当前运行：对齐 PG 侧 currentRunId。
 * 未终态的 active_run_id 优先；否则取最新的等待态运行——等待子代理的父运行
 * 已经归还会话执行位，但它仍是这个会话对外可见的当前运行。
 */
const currentRun = sql`COALESCE(
  CASE WHEN s.active_run_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM agent_run_checkpoints t WHERE t.user_id=s.user_id AND t.session_id=s.id
      AND t.run_id=s.active_run_id AND t.status IN ('completed','cancelled','failed','unknown'))
  THEN s.active_run_id END,
  (SELECT c.run_id FROM agent_run_checkpoints c WHERE c.user_id=s.user_id AND c.session_id=s.id
    AND c.status='waiting' ORDER BY c.updated_at_ms DESC, c.run_id DESC LIMIT 1))`

const isRunning = sql<boolean>`((s.execution_state='baseline_updating' AND s.active_run_id IS NOT NULL) OR EXISTS (
  SELECT 1 FROM agent_run_admissions admission
  LEFT JOIN agent_run_checkpoints checkpoint USING (user_id,session_id,run_id)
  LEFT JOIN agent_run_controls control USING (user_id,session_id,run_id)
  WHERE admission.user_id=s.user_id AND admission.session_id=s.id AND admission.run_id=${currentRun}
    AND COALESCE(control.startup_failed,0)=0 AND (checkpoint.status IS NULL OR checkpoint.status IN ('preparing','running')
      OR (checkpoint.status='waiting' AND (
        EXISTS (SELECT 1 FROM agent_subagent_waits w WHERE replace(w.owner_id,'-','')=s.user_id
          AND w.parent_session_id=CAST(s.id AS TEXT) AND w.parent_run_id=${currentRun})
        OR EXISTS (SELECT 1 FROM agent_inbox_waits w WHERE replace(w.owner_id,'-','')=s.user_id
          AND w.session_id=CAST(s.id AS TEXT) AND w.run_id=${currentRun})
      )))
))`

export async function listDesktopAgentSessions(db: Kysely<Database>, owner: string): Promise<DesktopAgentSession[]> {
  const list = createSqlAgentSessionLister(db, 'sqlite', {
    async activeStatuses(ids, ownerId) {
      const user = ownerId.replaceAll('-', '')
      const { rows } = await sql<{ id: number }>`SELECT s.id FROM conversation_sessions s
        WHERE s.user_id=${user} AND s.id IN (${sql.join(ids)}) AND ${isRunning}`.execute(db)
      return new Map(rows.map(row => [row.id, true]))
    },
    filesystemAuthorizationEnabled: () => false,
    workspaceShellSupported: () => false,
    sqliteWorkspace: 'unavailable',
    desktopImSessions: true,
  })
  const sessions = await list(owner)
  const ids = sessions.map(row => Number(row.id)).filter(Number.isSafeInteger)
  const bindings = ids.length ? (await sql<{ id: number; session_context: string | null }>`SELECT id,session_context
    FROM conversation_sessions WHERE user_id=${dataContext(owner).ownerId.replaceAll('-', '')} AND id IN (${sql.join(ids)})`.execute(db)).rows : []
  const workspaceNames = new Map(bindings.map(row => {
    const state = readAgentSessionContext(row.session_context, 'sqlite')
    const binding = state.workspace_binding
    const name = binding && typeof binding === 'object' && !Array.isArray(binding)
      && typeof (binding as Record<string, unknown>).workspace_name === 'string'
      ? (binding as Record<string, unknown>).workspace_name as string : null
    return [row.id, name] as const
  }))
  return sessions.map(row => ({
    id: Number(row.id), title: String(row.title), updatedAt: String(row.updatedAt),
    ...(typeof row.source === 'string' ? { source: row.source } : {}),
    ...(typeof row.chatType === 'string' ? { chatType: row.chatType } : {}),
    workspaceName: workspaceNames.get(Number(row.id)) ?? null,
    goalActive: row.goalActive === true,
    goalStatus: row.goalStatus === 'active' || row.goalStatus === 'paused' ? row.goalStatus : null,
    isRunning: row.isRunning === true, lastAssistantId: Number(row.lastAssistantId ?? 0),
  }))
}

export async function manageDesktopSessionGoal(db: Kysely<Database>, owner: string, id: number,
  action: 'status' | 'pause' | 'cancel' | 'resume', im?: { platform: string; connectionId: string; groupSenderId?: string }) {
  const user = dataContext(owner).ownerId.replaceAll('-', '')
  return db.transaction().execute(async tx => {
    const chat = im?.groupSenderId ? sql`chat_type='group' AND platform_user_id=${im.groupSenderId}`
      : sql`COALESCE(chat_type,'c2c')='c2c'`
    const scope = im ? sql`${chat} AND EXISTS (SELECT 1 FROM desktop_im_sessions im
      WHERE im.owner_id=${user} AND im.session_id=${id} AND im.platform=${im.platform} AND im.connection_id=${im.connectionId})`
      : sql`(source IS NULL OR source='web')`
    const { rows: [row] } = await sql<{ session_context: string | null; active_run_id: string | null }>`
      SELECT session_context,active_run_id FROM conversation_sessions WHERE user_id=${user} AND id=${id}
        AND ${scope}`.execute(tx)
    if (!row) throw new CoreError('not_found', '当前会话不存在')
    const context = readAgentSessionContext(row.session_context, 'sqlite')
    const interruptRunId = (action === 'pause' || action === 'cancel') && projectAgentSessionGoal(context).goalActive ? row.active_run_id : null
    const result = applyAgentGoalCommand(context, action)
    if (!result.changed) return { text: result.text }
    await sql`UPDATE conversation_sessions SET session_context=${JSON.stringify(context)}
      WHERE user_id=${user} AND id=${id}`.execute(tx)
    const cancelled = interruptRunId
      ? await createSqliteAgentAdmission(tx).requestCancel(owner, id, interruptRunId) : null
    return { interruptRunId: cancelled?.outcome === 'requested' ? interruptRunId : null, text: result.text }
  })
}

export interface DesktopSessionWorkspaceDirectory { id: string; name: string; commandNumber?: number }

function sessionWorkspaceDirectories(value: unknown): DesktopSessionWorkspaceDirectory[] {
  if (!Array.isArray(value)) throw new CoreError('storage_error', '桌面工作区目录列表无效')
  const ids = new Set<string>()
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new CoreError('storage_error', '桌面工作区目录记录无效')
    const row = item as Record<string, unknown>
    if (row.id === 'personal') return []
    if (typeof row.id !== 'string' || !/^desktop:[a-f0-9-]{36}$/u.test(row.id)
      || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 100 || ids.has(row.id))
      throw new CoreError('storage_error', '桌面工作区目录记录无效')
    ids.add(row.id)
    return [{ id: row.id, name: row.name, ...(typeof row.commandNumber === 'number' && Number.isSafeInteger(row.commandNumber) && row.commandNumber > 0 ? { commandNumber: row.commandNumber } : {}) }]
  })
}

function workspaceBinding(directory: DesktopSessionWorkspaceDirectory) {
  return {
    workspace_id: directory.id, workspace_name: directory.name, kind: 'directory', space: 'workspace',
    project_id: null, directory_id: directory.id, directory_name: directory.name,
  }
}

/** 桌面把会话绑定保存在 session_context；它不授予或修改 Shell 文件系统权限。 */
export async function manageDesktopSessionWorkspace(db: Kysely<Database>, owner: string, id: number,
  action: 'list' | 'show' | 'bind' | 'unlink', directoryId?: unknown,
  readDirectories?: () => Promise<unknown>, im?: { platform: string; connectionId: string }) {
  const user = dataContext(owner).ownerId.replaceAll('-', '')
  if (im) {
    const scoped = await sql`SELECT 1 FROM desktop_im_sessions im
      JOIN conversation_sessions s ON s.id=im.session_id AND s.user_id=im.owner_id
      WHERE im.owner_id=${user} AND im.session_id=${id} AND im.platform=${im.platform} AND im.connection_id=${im.connectionId}
        AND COALESCE(s.chat_type,'c2c')='c2c'`.execute(db)
    if (!scoped.rows.length) throw new CoreError('not_found', '会话不存在')
  }
  const directories = sessionWorkspaceDirectories(await readDirectories?.() ?? [])
  if (action === 'list') return { workspaces: directories }
  const selector = typeof directoryId === 'string' ? directoryId.trim() : ''
  const matches = action === 'bind' ? directories.filter(item => String(item.commandNumber ?? '') === selector || item.id === selector || item.name === selector
    || item.id.slice('desktop:'.length, 'desktop:'.length + 8) === selector.toLowerCase()) : []
  if (action === 'bind' && matches.length !== 1)
    throw new CoreError(matches.length ? 'conflict' : 'not_found', matches.length
      ? '找到多个工作区，请使用列表中的短 ID 或完整 ID' : '工作区不存在或已失效')
  const read = async (connection: Kysely<Database>) => (await sql<{
    session_context: string | null; active_run_id: string | null; chat_type: string | null
  }>`SELECT s.session_context,s.active_run_id,s.chat_type FROM conversation_sessions s
      WHERE s.user_id=${user} AND s.id=${id} AND (${Boolean(im)} OR s.source IS NULL OR s.source='web')`.execute(connection)).rows[0]
  if (action === 'show') {
    const row = await read(db)
    if (!row) throw new CoreError('not_found', '会话不存在')
    const context = readAgentSessionContext(row.session_context, 'sqlite')
    const binding = context.workspace_binding
    const boundId = binding && typeof binding === 'object' && !Array.isArray(binding)
      ? (binding as Record<string, unknown>).directory_id : undefined
    const current = directories.find(item => item.id === boundId)
    return { workspace: current ? workspaceBinding(current) : null }
  }
  const update = async (tx: Kysely<Database>) => {
    const row = await read(tx)
    if (!row) throw new CoreError('not_found', '会话不存在')
    if (row.chat_type === 'group') throw new CoreError('invalid_request', '群聊不能绑定工作区')
    if (row.active_run_id) throw new CoreError('conflict', '会话运行期间不能修改工作区绑定')
    const context = readAgentSessionContext(row.session_context, 'sqlite')
    if (action === 'unlink') delete context.workspace_binding
    else {
      context.workspace_binding = workspaceBinding(matches[0]!)
    }
    const current = readAgentSessionContext(row.session_context, 'sqlite').workspace_binding
    if (JSON.stringify(current ?? null) === JSON.stringify(context.workspace_binding ?? null))
      return { workspace: action === 'unlink' ? null : context.workspace_binding }
    await sql`UPDATE conversation_sessions SET session_context=${JSON.stringify(context)},context_epoch=context_epoch+1
      WHERE user_id=${user} AND id=${id}`.execute(tx)
    return { workspace: action === 'unlink' ? null : context.workspace_binding }
  }
  return db.isTransaction ? update(db) : db.transaction().execute(update)
}

/** 工作区登记已从宿主移除后，只解绑匹配的本用户会话。 */
export async function clearDesktopWorkspaceBindings(tx: Kysely<Database>, ownerId: string, directoryId: string) {
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  await sql`UPDATE conversation_sessions
    SET session_context=json_remove(session_context,'$.workspace_binding'),context_epoch=context_epoch+1,
      snapshot_hash=NULL,snapshot_expires_at=NULL,session_info_hash=NULL
    WHERE user_id=${owner} AND CASE WHEN json_valid(session_context)
      THEN json_extract(session_context,'$.workspace_binding.directory_id')=${directoryId} ELSE false END`.execute(tx)
}

export async function createDesktopAgentSession(tx: Transaction<Database>, owner: string, title: unknown, greeting?: unknown): Promise<DesktopAgentSession> {
  if (typeof title !== 'string' || !title.trim() || title.length > 200)
    throw new CoreError('invalid_request', '会话标题无效')
  if (greeting !== undefined && (typeof greeting !== 'string' || greeting.length > 2000))
    throw new CoreError('invalid_request', '会话问候无效')
  const user = dataContext(owner).ownerId.replaceAll('-', '')
  const time = databaseTime(nowUtc(), 'sqlite')
  const opening = greeting?.trim()
  const row = await sql<{ id: number }>`
    INSERT INTO conversation_sessions (user_id, title, title_locked, summary, source, context_epoch, last_message_seq, created_at, updated_at)
    VALUES (${user}, ${title.trim()}, 0, '', 'web', 0, ${opening ? 1 : 0}, ${time}, ${time})
    RETURNING id`.execute(tx)
  const id = Number(row.rows[0]!.id)
  if (opening) await sql`INSERT INTO conversation_messages
    (session_id, conversation_seq, role, content, created_at, sent_at)
    VALUES (${id}, 1, 'assistant', ${opening}, ${time}, ${time})`.execute(tx)
  return { id, title: title.trim(), updatedAt: utc(time).replace(' ', 'T') }
}

export async function readDesktopAgentMessages(db: Kysely<Database>, owner: string, id: number): Promise<DesktopAgentMessage[]> {
  return (await readDesktopAgentHistoryPage(db, owner, id)).messages
}

/** 旧桌面 IM 消息把 JSON 引用拼到了正文开头。读取时拆开，保留原始历史。 */
function splitLegacyDesktopQuote(text: string) {
  const prefix = '引用消息：'
  const boundary = text.indexOf('\n\n')
  if (!text.startsWith(prefix)) return { text }
  try {
    const quote: unknown = JSON.parse(text.slice(prefix.length, boundary < 0 ? undefined : boundary))
    if (typeof quote === 'string' && quote.trim())
      return { text: boundary < 0 ? '' : text.slice(boundary + 2), quotedText: quote }
  } catch { /* 不是旧版引用格式，按原正文显示。 */ }
  return { text }
}

export async function readDesktopAgentHistoryPage(
  db: Kysely<Database>, owner: string, id: number, before?: number,
  loadInteractionSecret?: () => Promise<string>,
): Promise<DesktopAgentHistoryPage> {
  const user = dataContext(owner).ownerId.replaceAll('-', '')
  const result = await sql<{
    execution_state: string; session_context: string | null; active: number; id: number | null; seq: number | null; role: DesktopAgentMessage['role'] | null; text: string | null; createdAt: string | null; timeline: string | null
    client_message_id: string | null; run_id: string | null; status: string | null
    files: string | null; references_json: string | null; quoted_text: string | null; is_im: number
    chat_type: string | null; owner_platform_user_id: string | null; platform_user_id: string | null; platform_user_name: string | null
  }>`
    SELECT s.execution_state, s.session_context, ${isRunning} AS active, m.id, m.conversation_seq AS seq, m.role, m.content AS text, m.created_at AS "createdAt", m.display_timeline AS timeline,
      s.chat_type, CASE WHEN s.chat_type='group' AND EXISTS (SELECT 1 FROM desktop_im_sessions im
        WHERE im.session_id=s.id AND im.owner_id=s.user_id AND im.platform='qq') THEN s.platform_user_id END AS owner_platform_user_id,
      m.files,m.references_json,m.quoted_text,m.platform_user_id,m.platform_user_name,
      EXISTS (SELECT 1 FROM desktop_im_sessions im WHERE im.session_id=s.id AND im.owner_id=s.user_id) AS is_im,
      m.client_message_id, coalesce(a.run_id,m.run_id) AS run_id, CASE WHEN d.startup_failed=1 THEN 'failed' ELSE c.status END AS status
    FROM conversation_sessions s
    LEFT JOIN conversation_messages m ON m.session_id = s.id
      AND ${desktopDisplayMessage}
      AND (${before ?? null} IS NULL OR m.conversation_seq < ${before ?? null})
    LEFT JOIN agent_run_admissions a ON a.user_id=s.user_id AND a.session_id=s.id AND a.user_message_id=m.id
    LEFT JOIN agent_run_checkpoints c ON (c.user_id,c.session_id,c.run_id)=(a.user_id,a.session_id,a.run_id)
    LEFT JOIN agent_run_controls d ON (d.user_id,d.session_id,d.run_id)=(a.user_id,a.session_id,a.run_id)
    WHERE s.user_id = ${user} AND s.id = ${id} AND (s.source IS NULL OR s.source = 'web')
    ORDER BY m.conversation_seq DESC LIMIT 21`.execute(db)
  if (!result.rows.length) throw new CoreError('not_found', '会话不存在')
  const page = result.rows.slice(0, 20)
  const mentionNames = new Map<string, string>()
  if (result.rows[0]!.chat_type === 'group' && result.rows[0]!.is_im) {
    const ids = [...new Set(page.flatMap(row => [...extractPlatformMentionIds(row.text), ...extractPlatformMentionIds(row.quoted_text)]))]
    const names = await createSqlAgentGroupNames(db, 'sqlite')(owner, id, ids)
    for (const [key, value] of names) mentionNames.set(key, value)
    if (ids.length) {
      const bots = await sql<{ platform_bot_user_id: string }>`SELECT DISTINCT m.platform_bot_user_id FROM conversation_messages m
        JOIN conversation_sessions s ON s.id=m.session_id
        WHERE s.id=${id} AND s.user_id=${user} AND m.platform_bot_user_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`.execute(db)
      for (const bot of bots.rows) if (!mentionNames.has(bot.platform_bot_user_id)) mentionNames.set(bot.platform_bot_user_id, '咕咕')
      const unresolved = ids.filter(candidate => !mentionNames.has(candidate))
      if (unresolved.length) {
        const observed = await sql<{ id: string; name: string }>`WITH ranked AS (
          SELECT json_extract(bot.value,'$.id') AS id, json_extract(bot.value,'$.name') AS name,
            ROW_NUMBER() OVER (PARTITION BY json_extract(bot.value,'$.id') ORDER BY m.conversation_seq DESC) AS rank
          FROM conversation_messages m JOIN desktop_im_sessions im ON im.session_id=m.session_id
          CROSS JOIN json_each(CASE WHEN json_valid(m.im_mention_facts) THEN m.im_mention_facts END,'$.otherBotNames') bot
          WHERE im.session_id=${id} AND im.owner_id=${user} AND im.platform='qq' AND bot.type='object'
            AND json_extract(bot.value,'$.id') IN (SELECT value FROM json_each(${JSON.stringify(unresolved)}))
            AND json_type(bot.value,'$.name')='text'
        ) SELECT id,name FROM ranked WHERE rank=1`.execute(db)
        for (const bot of observed.rows) if (bot.name) mentionNames.set(bot.id, bot.name)
      }
    }
  }
  const runIds = page.flatMap(row => row.role === 'user' && row.run_id ? [row.run_id] : [])
  const bindings = runIds.length ? (await sql<{ prompt_id: number; run_id: string }>`
    SELECT prompt_id,run_id FROM agent_interaction_bindings
    WHERE user_id=${user} AND session_id=${id} AND run_id IN (${sql.join(runIds)})`.execute(db)).rows : []
  if (loadInteractionSecret && runIds.length) {
    const pageRuns = new Set(runIds)
    bindings.push(...(await readDelegatedPromptBindings(db, 'sqlite', dataContext(owner).ownerId, id))
      .filter(route => pageRuns.has(route.run_id)))
  }
  const secret = bindings.length && before === undefined ? await loadInteractionSecret?.() : undefined
  const prompts = await createSqlAgentInteractionHistory(db, 'sqlite', undefined, secret, Boolean(loadInteractionSecret))(owner, id, {
    restoreActive: secret !== undefined, promptIds: bindings.map(binding => binding.prompt_id),
  })
  const runByPrompt = new Map(bindings.map(binding => [binding.prompt_id, binding.run_id]))
  const promptsByRun = new Map<string, NonNullable<DesktopAgentMessage['interactions']>>()
  for (const prompt of prompts) {
    const runId = runByPrompt.get(prompt.id)
    if (!runId) continue
    const projected = { ...prompt, run_id: runId }
    const existing = promptsByRun.get(runId)
    if (existing) existing.push(projected)
    else promptsByRun.set(runId, [projected])
  }
  const messages: DesktopAgentMessage[] = []
  let remainingBytes = MAX_AGENT_RESPONSE - 512
  let oldestId: number | null = null
  for (const row of page) {
    if (row.id === null) continue
    const timeline = row.timeline === null ? [] : projectAgentTimelineEvents([{
      id: row.id, displayTimeline: JSON.parse(row.timeline),
    }]) as NonNullable<DesktopAgentMessage['toolTimeline']>
    const toolTimeline = timeline.filter(item => item.kind === 'tool')
    const assistantTimeline = timeline.filter(item => item.kind === 'assistant' && (item.text || item.files?.length || item.linkButtons))
    const interactions = row.role === 'user' && row.run_id ? promptsByRun.get(row.run_id) : undefined
    const body = row.quoted_text ? { text: row.text!, quotedText: row.quoted_text }
      : row.role === 'user' && row.is_im ? splitLegacyDesktopQuote(row.text!) : { text: row.text! }
    const message: DesktopAgentMessage = {
      id: row.id, role: row.role!, ...body,
      text: replacePlatformMentionIds(body.text, mentionNames) ?? body.text,
      ...('quotedText' in body && body.quotedText ? { quotedText: replacePlatformMentionIds(body.quotedText, mentionNames) ?? body.quotedText } : {}),
      createdAt: utc(row.createdAt!).replace(' ', 'T'),
      ...(row.platform_user_id ? { platformUserId: row.platform_user_id } : {}),
      ...(row.platform_user_name ? { platformUserName: row.platform_user_name } : {}),
      ...(row.files ? { files: JSON.parse(row.files) as DesktopAgentMessage['files'] } : {}),
      ...(row.references_json ? { references: JSON.parse(row.references_json) as DesktopAgentChatReference[] } : {}),
      ...(row.client_message_id ? { clientMessageId: row.client_message_id } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.run_id && row.status && ['failed', 'unknown', 'cancelled'].includes(row.status)
        ? { runOutcome: { status: row.status === 'cancelled' ? 'interrupted' : 'failed', runId: row.run_id } } : {}),
      ...(toolTimeline.length ? { toolTimeline } : {}),
      ...(assistantTimeline.length ? { assistantTimeline } : {}),
      ...(interactions?.length ? { interactions } : {}),
    }
    remainingBytes -= Buffer.byteLength(JSON.stringify(message)) + 1
    if (remainingBytes < 0) {
      if (!messages.length) throw new CoreError('storage_error', '历史消息超出桌面响应限制')
      break
    }
    messages.push(message)
    oldestId = row.seq
  }
  return {
    ...(before === undefined ? { active: Boolean(result.rows[0]!.active), executionState: result.rows[0]!.execution_state,
      session: { ...projectAgentSessionGoal(readAgentSessionContext(result.rows[0]!.session_context, 'sqlite')),
        workspaceName: typeof (readAgentSessionContext(result.rows[0]!.session_context, 'sqlite').workspace_binding as Record<string, unknown> | undefined)?.workspace_name === 'string'
          ? (readAgentSessionContext(result.rows[0]!.session_context, 'sqlite').workspace_binding as Record<string, unknown>).workspace_name as string : null,
        ...(result.rows[0]!.chat_type ? { chatType: result.rows[0]!.chat_type } : {}),
        ...(result.rows[0]!.owner_platform_user_id ? { ownerPlatformUserId: result.rows[0]!.owner_platform_user_id } : {}) } } : {}),
    messages: messages.reverse(),
    pagination: { oldestId, hasMore: oldestId !== null && result.rows.length > messages.length },
  }
}

/** 完整问答同事务追加。模型失败时由宿主保留输入草稿。 */
export async function appendDesktopAgentTurn(tx: Transaction<Database>, owner: string, id: number, text: unknown, reply: unknown, clientId?: string, trustedIm = false) {
  if (typeof text !== 'string' || !text.trim() || text.length > 32_000
    || typeof reply !== 'string' || !reply.trim() || reply.length > 1_000_000)
    throw new CoreError('invalid_request', '对话消息无效')
  const user = dataContext(owner).ownerId.replaceAll('-', '')
  const at = databaseTime(nowUtc(), 'sqlite')
  const { rows } = await sql<{ seq: number }>`
    SELECT coalesce(max(m.conversation_seq),0) AS seq
    FROM conversation_sessions s LEFT JOIN conversation_messages m ON m.session_id=s.id
    WHERE s.id=${id} AND s.user_id=${user} AND (${Number(trustedIm)} OR s.source IS NULL OR s.source='web')
    GROUP BY s.id`.execute(tx)
  if (!rows[0]) throw new CoreError('not_found', '会话不存在')
  const seq = Number(rows[0].seq)
  const inserted = await sql<{ id: number }>`INSERT INTO conversation_messages(session_id,conversation_seq,role,content,created_at,client_message_id)
    VALUES(${id},${seq+1},'user',${text},${at},${clientId ?? null}),(${id},${seq+2},'assistant',${reply},${at},NULL) RETURNING id`.execute(tx)
  await sql`UPDATE conversation_sessions SET updated_at=${at},last_message_seq=${seq+2} WHERE id=${id} AND user_id=${user}`.execute(tx)
  return { saved: true, ...(clientId ? { userMessageId: inserted.rows[0]!.id } : {}) }
}

export async function renameDesktopAgentSession(tx: Transaction<Database>, owner: string, id: number, value: unknown): Promise<DesktopAgentSession> {
  const title = normalizeAgentSessionTitle(value)
  const user = dataContext(owner).ownerId.replaceAll('-', '')
  const { rows } = await sql<{ updated_at: string }>`
    UPDATE conversation_sessions SET title=${title}, title_locked=1
    WHERE id=${id} AND user_id=${user} AND (source IS NULL OR source='web')
    RETURNING updated_at`.execute(tx)
  if (!rows[0]) throw new CoreError('not_found', '会话不存在')
  return { id, title, updatedAt: utc(rows[0].updated_at).replace(' ', 'T') }
}

export async function deleteDesktopAgentSession(tx: Transaction<Database>, owner: string, id: number): Promise<null> {
  const active = await createSqliteAgentAdmission(tx).active(owner, id)
  if (active?.identity) throw new CoreError('conflict', '请先停止会话中正在运行的任务')
  const user = dataContext(owner).ownerId.replaceAll('-', '')
  const { rows } = await sql`
    DELETE FROM conversation_sessions
    WHERE id=${id} AND user_id=${user} AND (source IS NULL OR source='web')
    RETURNING id`.execute(tx)
  if (!rows.length) throw new CoreError('not_found', '会话不存在')
  await enqueueAgentRagRebuildInTransaction(tx, 'sqlite', owner, 'conversation')
  await sql`
    UPDATE knowledge_index_entries
    SET deleted_at=CURRENT_TIMESTAMP, indexed_at=CURRENT_TIMESTAMP,
        title='', summary='', content='', content_hash='', metadata_json='{}'
    WHERE owner_user_id=${user} AND source_type='conversation'
      AND CAST(json_extract(metadata_json, '$.session_id') AS TEXT)=${String(id)}`.execute(tx)
  return null
}

import type { ProviderConfig } from '#core-source/agent/providers/contracts.js'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { dataContext } from '#core-source/contracts/index.js'
import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import type { Json, RunIdentity } from '#core-source/agent/models.js'
import type { AgentObservationPort } from '#core-source/agent/observation.js'
import type { AgentProviderAuxiliaryPorts } from '#core-source/agent/runtime.js'
import type { ContextSourcePorts } from '#core-source/agent/ports.js'
import type { DesktopMemoryFiles } from '#core-source/agent/memory/desktop-files.js'
import { applyReflectionFileWrite, IM_REFLECTION_IDLE_SECONDS, PRIVATE_REFLECTION_IDLE_SECONDS, qualifiesReflectionTurn } from '#core-source/agent/memory/reflection/window.js'
import { desktopImGroupRunEvent } from '#core-source/im/desktop-inbox.js'
import { desktopGroupMemoryContext } from './im-memory-context.js'
import { dateKeyInTimeZone } from '#core-source/shared/date-time.js'
import { readSqliteAgentMemorySnapshot } from '#core-source/agent/memory/sqlite.js'
import { readAgentPrompt } from '#core-source/agent/context/prompts.js'
import { formatOwnerReflectionEvidence } from '#core-source/agent/scenes/reflection/index.js'
import { runPrivateReflection } from '#core-source/agent/memory/reflection.js'
import { applyOwnerReflectionOutput } from '#core-source/agent/memory/owner-reflection.js'
import { applyImMaintenanceOutput } from '#core-source/memory/im-maintenance-apply.js'
import { enqueueAgentRagRebuildInTransaction } from '#core-source/agent/rag/index.js'

export function createDesktopReflectionWork(options: {
  db: SqlDataRuntime['db']
  ownerId: string
  sessionId: number | null
  modelId: string | undefined
  modelIdentity: string
  timezone: string
  promptDirectory: string
  groupChat: boolean
  memoryFiles: DesktopMemoryFiles | undefined
  observation: AgentObservationPort | undefined
  sessionSource: Pick<ContextSourcePorts, 'currentTurn'>
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  reflection: { signal: AbortSignal }
  scheduleReflectionRecovery: (delay: number) => void
  getProvider: () => AgentProviderAuxiliaryPorts | undefined
  runAccessScope: (identity: RunIdentity) => string
  digest: (value: unknown) => string
}) {
  const { db, ownerId, sessionId, modelId, modelIdentity, timezone, promptDirectory, groupChat, memoryFiles,
    observation, sessionSource, hostRequest, reflection, scheduleReflectionRecovery, getProvider, runAccessScope, digest } = options
  async function enqueueReflection(identity: RunIdentity, text: string, modelIdentity: string, hadTools: boolean) {
    if (!text.trim() || text.length > 1_000_000) return
    const turn = await sessionSource.currentTurn(identity)
    if (!turn.currentUser || !qualifiesReflectionTurn({ userMessage: turn.currentUser.rawText ?? '', usedTools: hadTools })) return
    const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
    await sql`INSERT INTO desktop_agent_reflection_jobs
      (user_id,session_id,run_id,user_message_id,model_identity,assistant_text,status,attempts,created_at_ms)
      VALUES(${owner},${Number(identity.sessionId)},${identity.runId},${Number(turn.currentUser.persistedMessageId)},
        ${modelIdentity},${text},'queued',0,${Date.now()})
      ON CONFLICT(user_id,session_id,run_id) DO NOTHING`.execute(db)
    scheduleReflectionRecovery(PRIVATE_REFLECTION_IDLE_SECONDS * 1000)
  }
  async function enqueueImReflection(identity: RunIdentity, text: string, modelIdentity: string) {
    if (!groupChat || !memoryFiles || !text.trim() || text.length > 1_000_000) return
    const receipt = await desktopImGroupRunEvent(db, identity, 'completed')
    if (!receipt) return
    const authorization = desktopGroupMemoryContext(await hostRequest('agent.im.readGroupMemoryContext',
      { ...receipt, ownerId }, reflection.signal), ownerId)
    if (!authorization) return
    const actor = authorization.actor
    if (!actor.verifiedOwner && actor.role === 'owner') return
    const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
    const { rows: [source] } = await sql<{ id: number; platform_user_id: string | null; content: string }>`
      SELECT m.id,m.platform_user_id,m.content FROM agent_run_admissions a
      JOIN conversation_messages m ON m.id=a.user_message_id AND m.session_id=a.session_id AND m.role='user'
      WHERE a.user_id=${owner} AND a.session_id=${Number(identity.sessionId)} AND a.run_id=${identity.runId}`.execute(db)
    if (!source || source.platform_user_id !== actor.platformUserId || source.content.length > 32_000) return
    const scopes: Array<{ type: 'owner' | 'group' | 'platform-user'; id: string }> = []
    if (authorization.groupMemoryEnabled) scopes.push({ type: 'group', id: actor.chatId! })
    if (actor.role === 'member' && authorization.memberMemoryEnabled)
      scopes.push({ type: 'platform-user', id: `${actor.chatId}:${actor.platformUserId}` })
    if (actor.role === 'owner' && actor.verifiedOwner && authorization.groupOwnerMemoryEnabled)
      scopes.push({ type: 'owner', id: owner })
    const observedAt = Date.now()
    if (!scopes.length) return
    const idleDue = observedAt + IM_REFLECTION_IDLE_SECONDS * 1000
    await db.transaction().execute(async tx => {
      for (const scope of scopes) await sql`INSERT INTO desktop_im_reflection_jobs
        (owner_id,session_id,run_id,user_message_id,platform,connection_id,event_key,scope_type,scope_id,model_identity,status,attempts,created_at_ms)
        VALUES(${owner},${Number(identity.sessionId)},${identity.runId},${source.id},${receipt.platform},${receipt.connectionId},${receipt.eventKey},
          ${scope.type},${scope.id},${modelIdentity},'queued',0,${observedAt})
        ON CONFLICT(owner_id,session_id,run_id,scope_type,scope_id) DO NOTHING`.execute(tx)
      await sql`INSERT INTO desktop_im_reflection_triggers(owner_id,session_id,idle_due_at_ms)
        VALUES(${owner},${Number(identity.sessionId)},${idleDue})
        ON CONFLICT(owner_id,session_id) DO UPDATE SET idle_due_at_ms=excluded.idle_due_at_ms`.execute(tx)
    })
    scheduleReflectionRecovery(IM_REFLECTION_IDLE_SECONDS * 1000)
  }
  async function drainImReflections(signal = reflection.signal) {
    const provider = getProvider()
    if (!provider || !memoryFiles || !groupChat) return
    const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
    const { rows: [request] } = await sql<{ requested_sequence: number }>`SELECT requested_sequence FROM desktop_im_reflection_triggers
      WHERE owner_id=${owner} AND session_id=${Number(sessionId)}`.execute(db)
    const requested = request?.requested_sequence ?? 0
    const { rows: [threshold] } = await sql<{ sequence: number | null }>`SELECT MAX(through_sequence) AS sequence
      FROM desktop_im_reflection_thresholds WHERE owner_id=${owner} AND session_id=${Number(sessionId)}`.execute(db)
    const ownerRequested = Math.max(requested, threshold?.sequence ?? 0)
    const requestedAfter = (table: 'j' | 'desktop_im_reflection_jobs') => sql`CASE WHEN ${sql.ref(table + '.scope_type')}='owner' THEN ${ownerRequested} ELSE ${requested} END > COALESCE((
      SELECT last_sequence FROM desktop_im_reflection_positions p
      WHERE p.owner_id=${sql.ref(table + '.owner_id')} AND p.session_id=${sql.ref(table + '.session_id')}
        AND p.scope_type=${sql.ref(table + '.scope_type')} AND p.scope_id=${sql.ref(table + '.scope_id')}),0)`
    const dueBefore = Date.now() - IM_REFLECTION_IDLE_SECONDS * 1000
    if (requested > 0) {
      const { rows: [anchor] } = await sql<{ run_id: string; connection_id: string; event_key: string; sealed_event: Buffer }>`
        SELECT j.run_id,j.connection_id,j.event_key,e.sealed_event FROM desktop_im_reflection_jobs j
        JOIN desktop_im_inbox e ON e.owner_id=j.owner_id AND e.platform=j.platform AND e.connection_id=j.connection_id AND e.event_key=j.event_key
        WHERE j.owner_id=${owner} AND j.session_id=${Number(sessionId)} AND j.model_identity=${modelIdentity}
          AND j.scope_type='group' AND e.run_id=j.run_id AND e.state='completed'
        ORDER BY j.created_at_ms DESC,j.run_id DESC LIMIT 1`.execute(db)
      if (anchor) {
        const context = desktopGroupMemoryContext(await hostRequest('agent.im.readGroupMemoryContext', {
          ownerId, connectionId: anchor.connection_id, eventKey: anchor.event_key,
          sealedEvent: anchor.sealed_event.toString('base64'),
        }, signal), ownerId)
        if (context?.groupMemoryEnabled && context.memberMemoryEnabled && context.ownerPlatformUserId) {
          await sql`INSERT INTO desktop_im_reflection_jobs
            (owner_id,session_id,run_id,user_message_id,platform,connection_id,event_key,scope_type,scope_id,model_identity,status,attempts,created_at_ms)
            SELECT DISTINCT j.owner_id,j.session_id,j.run_id,j.user_message_id,j.platform,j.connection_id,j.event_key,
              'platform-user',${context.chatId} || ':' || m.platform_user_id,j.model_identity,'queued',0,j.created_at_ms
            FROM desktop_im_reflection_jobs j JOIN conversation_messages m ON m.session_id=j.session_id
            WHERE j.owner_id=${owner} AND j.session_id=${Number(sessionId)} AND j.run_id=${anchor.run_id} AND j.scope_type='group'
              AND m.role='user' AND m.canonical_batch_id IS NULL AND m.conversation_seq<=${requested}
              AND m.platform_user_id IS NOT NULL AND m.platform_user_id<>${context.ownerPlatformUserId}
              AND m.conversation_seq>COALESCE((SELECT p.last_sequence FROM desktop_im_reflection_positions p
                WHERE p.owner_id=j.owner_id AND p.session_id=j.session_id AND p.scope_type='platform-user'
                  AND p.scope_id=${context.chatId} || ':' || m.platform_user_id),0)
            ON CONFLICT(owner_id,session_id,run_id,scope_type,scope_id) DO NOTHING`.execute(db)
        }
      }
    }
    const { rows: pending } = await sql<{ run_id: string; session_id: number; scope_type: 'owner' | 'group' | 'platform-user'; scope_id: string }>`
      SELECT j.run_id,j.session_id,j.scope_type,j.scope_id FROM desktop_im_reflection_jobs j
      LEFT JOIN desktop_agent_run_models m ON m.user_id=j.owner_id AND m.session_id=j.session_id AND m.run_id=j.run_id
      WHERE j.owner_id=${owner} AND j.session_id=${Number(sessionId)} AND j.model_identity=${modelIdentity}
        AND m.model_id IS ${modelId ?? null}
        AND EXISTS(SELECT 1 FROM conversation_sessions s WHERE s.user_id=j.owner_id AND s.id=j.session_id AND s.active_run_id IS NULL)
        AND (${requestedAfter('j')} OR NOT EXISTS (SELECT 1 FROM desktop_im_reflection_jobs recent
          WHERE recent.owner_id=j.owner_id AND recent.session_id=j.session_id AND recent.created_at_ms > ${dueBefore}))
        AND (j.status='queued' OR (j.status='processing' AND j.claimed_at_ms < ${Date.now() - 300_000}))
      ORDER BY j.created_at_ms,j.run_id,j.scope_type,j.scope_id`.execute(db)
    for (const candidate of pending) {
      signal.throwIfAborted()
      const claimTime = Date.now()
      const { rows: [job] } = await sql<{ run_id: string; session_id: number; user_message_id: number; platform: string;
        connection_id: string; event_key: string; scope_type: 'owner' | 'group' | 'platform-user'; scope_id: string;
        model_identity: string; attempts: number }>`
        UPDATE desktop_im_reflection_jobs SET status='processing',claimed_at_ms=${claimTime},attempts=attempts+1
        WHERE owner_id=${owner} AND session_id=${candidate.session_id} AND run_id=${candidate.run_id}
          AND scope_type=${candidate.scope_type} AND scope_id=${candidate.scope_id}
          AND (${requestedAfter('desktop_im_reflection_jobs')} OR NOT EXISTS (SELECT 1 FROM desktop_im_reflection_jobs recent
            WHERE recent.owner_id=${owner} AND recent.session_id=${candidate.session_id}
              AND recent.created_at_ms > ${Date.now() - IM_REFLECTION_IDLE_SECONDS * 1000}))
          AND EXISTS(SELECT 1 FROM conversation_sessions s WHERE s.user_id=${owner} AND s.id=${candidate.session_id} AND s.active_run_id IS NULL)
          AND NOT EXISTS (SELECT 1 FROM desktop_im_reflection_jobs active
            WHERE active.owner_id=${owner} AND active.session_id=${candidate.session_id}
              AND active.scope_type=${candidate.scope_type} AND active.scope_id=${candidate.scope_id}
              AND active.run_id<>${candidate.run_id} AND (active.status='processing' OR EXISTS (
                SELECT 1 FROM desktop_im_reflection_plans prepared WHERE prepared.owner_id=active.owner_id
                  AND prepared.session_id=active.session_id AND prepared.run_id=active.run_id
                  AND prepared.scope_type=active.scope_type AND prepared.scope_id=active.scope_id
                  AND active.status='queued')))
          AND (status='queued' OR (status='processing' AND claimed_at_ms < ${claimTime - 300_000}))
        RETURNING run_id,session_id,user_message_id,platform,connection_id,event_key,scope_type,scope_id,model_identity,attempts`.execute(db)
      if (!job) continue
      const identity: RunIdentity = { ownerId, sessionId: String(job.session_id), runId: job.run_id }
      try {
        const { rows: [event] } = await sql<{ sealed_event: Buffer }>`SELECT sealed_event FROM desktop_im_inbox
          WHERE owner_id=${owner} AND platform=${job.platform} AND connection_id=${job.connection_id} AND event_key=${job.event_key}
            AND session_id=${job.session_id} AND run_id=${job.run_id} AND state IN ('running','completed')`.execute(db)
        if (!event) throw new Error('reflection_authorization_changed')
        const receipt = { connectionId: job.connection_id, eventKey: job.event_key,
          sealedEvent: event.sealed_event.toString('base64') }
        const authorize = async () => desktopGroupMemoryContext(await hostRequest('agent.im.readGroupMemoryContext',
          { ...receipt, ownerId }, signal), ownerId)
        const context = await authorize()
        if (!context || context.actor.platform !== job.platform || context.actor.chatType !== 'group')
          throw new Error('reflection_authorization_changed')
        const actor = context.actor
        const prefix = `${actor.chatId}:`
        const member = job.scope_id.startsWith(prefix) ? job.scope_id.slice(prefix.length) : ''
        const canReflectMember = (current: NonNullable<typeof context>) => current.memberMemoryEnabled && !!member
          && (member === current.actor.platformUserId ? current.actor.role === 'member'
            : current.groupMemoryEnabled && current.ownerPlatformUserId !== null && member !== current.ownerPlatformUserId)
        if (job.scope_type === 'group' && (!context.groupMemoryEnabled || job.scope_id !== actor.chatId)
          || job.scope_type === 'platform-user' && !canReflectMember(context)
          || job.scope_type === 'owner' && (!context.groupOwnerMemoryEnabled || actor.role !== 'owner' || !actor.verifiedOwner))
          throw new Error('reflection_authorization_changed')
        const { rows: [source] } = await sql<{ id: number; conversation_seq: number; content: string; platform_user_id: string | null; platform_user_name: string | null }>`
          SELECT m.id,m.conversation_seq,m.content,m.platform_user_id,m.platform_user_name FROM agent_run_admissions a
          JOIN conversation_messages m ON m.id=a.user_message_id AND m.session_id=a.session_id AND m.role='user'
          WHERE a.user_id=${owner} AND a.session_id=${job.session_id} AND a.run_id=${job.run_id}`.execute(db)
        if (!source || source.id !== job.user_message_id || source.platform_user_id !== actor.platformUserId
          || !source.content.trim() || source.content.length > 32_000)
          throw new Error('reflection_source_unavailable')

        const position = sql<{ last_sequence: number }>`SELECT last_sequence FROM desktop_im_reflection_positions
          WHERE owner_id=${owner} AND session_id=${job.session_id} AND scope_type=${job.scope_type} AND scope_id=${job.scope_id}`
        const saved = (await sql<{ through_sequence: number; payload: string | null }>`SELECT through_sequence,payload FROM desktop_im_reflection_plans
          WHERE owner_id=${owner} AND session_id=${job.session_id} AND run_id=${job.run_id}
            AND scope_type=${job.scope_type} AND scope_id=${job.scope_id}`.execute(db)).rows[0]
        const after = Number((await position.execute(db)).rows[0]?.last_sequence ?? 0)
        const dueSequence = job.scope_type === 'owner' ? ownerRequested : requested
        const through = saved?.through_sequence ?? (dueSequence > after ? dueSequence : source.conversation_seq)
        if (!saved) {
          const freeze = await sql`INSERT INTO desktop_im_reflection_plans
            (owner_id,session_id,run_id,scope_type,scope_id,through_sequence)
            SELECT owner_id,session_id,run_id,scope_type,scope_id,${through} FROM desktop_im_reflection_jobs
            WHERE owner_id=${owner} AND session_id=${job.session_id} AND run_id=${job.run_id}
              AND scope_type=${job.scope_type} AND scope_id=${job.scope_id} AND status='processing' AND claimed_at_ms=${claimTime}
            RETURNING through_sequence`.execute(db)
          if (!freeze.rows.length) throw new Error('reflection_memory_changed')
        }
        const sender = job.scope_type === 'group' ? null : job.scope_type === 'platform-user' ? member : actor.platformUserId
        const { rows: evidence } = await sql<{ content: string; platform_user_id: string; platform_user_name: string | null }>`
          SELECT m.content,m.platform_user_id,m.platform_user_name FROM conversation_messages m
          JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=${owner}
          WHERE m.session_id=${job.session_id} AND m.role='user' AND m.conversation_seq>${after}
            AND m.conversation_seq<=${through} AND m.platform_user_id IS NOT NULL AND m.canonical_batch_id IS NULL
            AND (${sender} IS NULL OR m.platform_user_id=${sender})
            AND NOT EXISTS (SELECT 1 FROM desktop_im_reflection_jobs legacy
              WHERE legacy.owner_id=${owner} AND legacy.session_id=m.session_id AND legacy.user_message_id=m.id
                AND legacy.scope_type=${job.scope_type} AND legacy.scope_id=${job.scope_id} AND legacy.status='completed')
          ORDER BY m.conversation_seq LIMIT 1001`.execute(db)
        if (evidence.length > 1000) throw new Error('reflection_source_unavailable')
        const finish = async (tx: typeof db) => {
          const done = await sql`UPDATE desktop_im_reflection_jobs SET status='completed',claimed_at_ms=NULL,last_error=NULL
            WHERE owner_id=${owner} AND session_id=${job.session_id} AND run_id=${job.run_id}
              AND scope_type=${job.scope_type} AND scope_id=${job.scope_id} AND status='processing' AND claimed_at_ms=${claimTime}
            RETURNING status`.execute(tx)
          if (!done.rows.length) throw new Error('reflection_memory_changed')
          await sql`INSERT INTO desktop_im_reflection_positions(owner_id,session_id,scope_type,scope_id,last_sequence)
            VALUES(${owner},${job.session_id},${job.scope_type},${job.scope_id},${through})
            ON CONFLICT(owner_id,session_id,scope_type,scope_id) DO UPDATE SET last_sequence=excluded.last_sequence
            WHERE desktop_im_reflection_positions.last_sequence < excluded.last_sequence`.execute(tx)
          await sql`DELETE FROM desktop_im_reflection_plans WHERE owner_id=${owner} AND session_id=${job.session_id}
            AND run_id=${job.run_id} AND scope_type=${job.scope_type} AND scope_id=${job.scope_id}`.execute(tx)
        }
        if (!saved?.payload && !evidence.length) {
          await db.transaction().execute(finish)
          continue
        }
        const now = Date.now(), nowSeconds = Math.floor(now / 1000), date = dateKeyInTimeZone(new Date(now), timezone)
        const signalWithTimeout = AbortSignal.any([signal, AbortSignal.timeout(90_000)])
        const scope = job.scope_type === 'owner' ? { type: 'owner' as const, id: owner }
          : job.scope_type === 'group' ? { type: 'group' as const, id: actor.chatId! }
            : { type: 'platform-user' as const, id: job.scope_id }
        let current: Record<string, Json>, snapshot: Awaited<ReturnType<typeof readSqliteAgentMemorySnapshot>> | undefined
        let rawFiles: Record<string, string | null> = {}
        if (scope.type === 'owner') {
          snapshot = await readSqliteAgentMemorySnapshot(db, ownerId, undefined, memoryFiles)
          const decode = (key: string, fallback: Json): Json => {
            const raw = snapshot!.files[key]
            if (raw === undefined) return fallback
            return JSON.parse(raw) as Json
          }
          current = { profile: decode('profile', []), pattern: decode('pattern', []), summary: decode('summary', {}),
            daily: snapshot.files.daily ?? '', stance: decode('stance', {}), lens: decode('lens', {}) }
        } else {
          const fileScope = { owner_user_id: owner, platform: actor.platform, bot_id: actor.botId,
            scope_type: scope.type, scope_id: scope.id }
          const fields = scope.type === 'group' ? ['profile', 'summary', 'daily', 'members'] as const
            : ['profile', 'pattern', 'summary', 'daily', 'memory'] as const
          current = {}
          for (const field of fields) {
            const filename = field === 'daily' || field === 'memory' ? `${field}.md` : `${field}.json`
            const raw = await memoryFiles.readImScope(fileScope, filename)
            rawFiles[field] = raw
            if (field === 'daily' || field === 'memory') current[field] = raw ?? ''
            else if (raw === null) current[field] = field === 'profile' || field === 'pattern' ? [] : {}
            else {
              const parsed: unknown = JSON.parse(raw)
              if (!parsed || typeof parsed !== 'object' || (field === 'profile' || field === 'pattern') !== Array.isArray(parsed))
                throw new Error('reflection_source_unavailable')
              current[field] = parsed as Json
            }
          }
          const { rows: tombstone } = await sql`SELECT 1 FROM desktop_im_memory_tombstones
            WHERE owner_id=${owner} AND platform=${actor.platform} AND bot_id=${actor.botId}
              AND scope_type=${scope.type} AND scope_id=${scope.id}`.execute(db)
          if (tombstone.length) throw new Error('reflection_authorization_changed')
        }
        const prompt = scope.type === 'group' ? readAgentPrompt('im/group_reflection.md', promptDirectory)
          : scope.type === 'platform-user' ? readAgentPrompt('im/member_reflection.md', promptDirectory)
            : readAgentPrompt('reflection.md', promptDirectory)
        const delta = scope.type === 'owner'
          ? formatOwnerReflectionEvidence({ date, userName: '', profile: current.profile, pattern: current.pattern, summary: current.summary },
            evidence.map(message => [message.content, '']))
          : JSON.stringify({ date, current, target_scope: scope,
            messages: evidence.map(message => ({ platform_user_id: message.platform_user_id, platform_user_name: message.platform_user_name ?? '', text: message.content })) })
        let changes: Record<string, Json>
        if (saved?.payload) {
          const plan = JSON.parse(saved.payload) as { changes: Record<string, Json>; rawFiles: Record<string, string | null> }
          changes = plan.changes
          rawFiles = plan.rawFiles
        } else {
          if (Buffer.byteLength(delta) > 1_048_576) throw new Error('reflection_source_unavailable')
          const reflection = await runPrivateReflection({ ...identity, stableSystem: prompt.trim(), delta, scope: runAccessScope(identity) },
          { outputMode: 'json', maxRetries: 1, maxOutputTokens: 1600 }, {
            provider: provider.reflectionProvider(job.model_identity), digest, nextId: randomUUID,
            async pauseBeforeRetry() {}, diagnostic: () => {},
          }, signalWithTimeout, observation, { trigger: 'idle', scope: 'group' })
          signal.throwIfAborted()
          if (!reflection.ok || reflection.output === null) throw new Error(`reflection_${reflection.reason}`)
          if (scope.type === 'owner') changes = applyOwnerReflectionOutput({ current, output: reflection.output,
            now, date, nextId: randomUUID })
          else changes = applyImMaintenanceOutput({ scopeType: scope.type, current, output: reflection.output,
            now: nowSeconds, date }) as Record<string, Json>

        }

        const freshAuthorization = await authorize()
        if (!freshAuthorization || freshAuthorization.actor.botId !== actor.botId
          || freshAuthorization.actor.chatId !== actor.chatId || freshAuthorization.actor.platformUserId !== actor.platformUserId
          || freshAuthorization.actor.role !== actor.role || freshAuthorization.actor.verifiedOwner !== actor.verifiedOwner
          || scope.type === 'group' && !freshAuthorization.groupMemoryEnabled
          || scope.type === 'platform-user' && !canReflectMember(freshAuthorization)
          || scope.type === 'owner' && !freshAuthorization.groupOwnerMemoryEnabled)
          throw new Error('reflection_authorization_changed')
        if (scope.type === 'owner') {
          await db.transaction().execute(async tx => {
            signal.throwIfAborted()
            const { rows: [claimed] } = await sql`SELECT 1 FROM desktop_im_reflection_jobs
              WHERE owner_id=${owner} AND session_id=${job.session_id} AND run_id=${job.run_id}
                AND scope_type='owner' AND scope_id=${job.scope_id} AND status='processing' AND claimed_at_ms=${claimTime}`.execute(tx)
            if (!claimed) return
            const fresh = await readSqliteAgentMemorySnapshot(tx, ownerId, undefined, memoryFiles)
            if (fresh.revision !== snapshot?.revision) throw new Error('reflection_memory_changed')
            for (const [target, value] of Object.entries(changes)) {
              const body = typeof value === 'string' ? value : JSON.stringify(value)
              if (target === 'profile' || target === 'pattern')
                await sql`INSERT INTO desktop_agent_memory(user_id,target,body) VALUES(${owner},${target},${body})
                  ON CONFLICT(user_id,target) DO UPDATE SET body=excluded.body`.execute(tx)
              else await sql`INSERT INTO desktop_agent_memory_documents(user_id,target,body) VALUES(${owner},${target},${body})
                  ON CONFLICT(user_id,target) DO UPDATE SET body=excluded.body`.execute(tx)
            }
            if (Object.keys(changes).length) await enqueueAgentRagRebuildInTransaction(tx, 'sqlite', ownerId, 'memory')
            await finish(tx)
          })
        } else {
          const fileScope = { owner_user_id: owner, platform: actor.platform, bot_id: actor.botId,
            scope_type: scope.type, scope_id: scope.id }
          if (!saved?.payload) {
            const planned = await sql`UPDATE desktop_im_reflection_plans SET payload=${JSON.stringify({ changes, rawFiles })}
              WHERE owner_id=${owner} AND session_id=${job.session_id} AND run_id=${job.run_id}
                AND scope_type=${job.scope_type} AND scope_id=${job.scope_id} AND payload IS NULL
                AND EXISTS(SELECT 1 FROM desktop_im_reflection_jobs j WHERE j.owner_id=${owner}
                  AND j.session_id=${job.session_id} AND j.run_id=${job.run_id} AND j.scope_type=${job.scope_type}
                  AND j.scope_id=${job.scope_id} AND j.status='processing' AND j.claimed_at_ms=${claimTime})
              RETURNING through_sequence`.execute(db)
            if (!planned.rows.length) throw new Error('reflection_memory_changed')
          }
          for (const [field, value] of Object.entries(changes)) {
            if (!['profile', 'pattern', 'summary', 'daily', 'memory', 'members'].includes(field)) continue
            const latestAuthorization = await authorize()
            if (!latestAuthorization || scope.type === 'group' && !latestAuthorization.groupMemoryEnabled
              || scope.type === 'platform-user' && !canReflectMember(latestAuthorization))
              throw new Error('reflection_authorization_changed')
            const filename = field === 'daily' || field === 'memory' ? `${field}.md` : `${field}.json`
            const body = field === 'daily' || field === 'memory' ? String(value) : `${JSON.stringify(value, null, 2)}\n`
            signal.throwIfAborted()
            const { rows: [claim] } = await sql`SELECT 1 FROM desktop_im_reflection_jobs
              WHERE owner_id=${owner} AND session_id=${job.session_id} AND run_id=${job.run_id}
                AND scope_type=${job.scope_type} AND scope_id=${job.scope_id} AND status='processing' AND claimed_at_ms=${claimTime}`.execute(db)
            if (!claim) throw new Error('reflection_memory_changed')
            const { rows: tombstone } = await sql`SELECT 1 FROM desktop_im_memory_tombstones
              WHERE owner_id=${owner} AND platform=${actor.platform} AND bot_id=${actor.botId}
                AND scope_type=${scope.type} AND scope_id=${scope.id}`.execute(db)
            if (tombstone.length) throw new Error('reflection_authorization_changed')
            if (!await applyReflectionFileWrite(rawFiles[field] ?? null, body,
              () => memoryFiles.readImScope(fileScope, filename),
              value => memoryFiles.writeImScope(fileScope, filename, value))) throw new Error('reflection_memory_changed')
          }
          const finalAuthorization = await authorize()
          if (!finalAuthorization || scope.type === 'group' && !finalAuthorization.groupMemoryEnabled
            || scope.type === 'platform-user' && !canReflectMember(finalAuthorization))
            throw new Error('reflection_authorization_changed')
          await db.transaction().execute(finish)
        }
        if (scope.type === 'owner') await memoryFiles.flush()
      } catch (error) {
        const reason = error instanceof Error && /^reflection_(?:provider_error|output_empty|schema_invalid|source_unavailable|memory_changed|authorization_changed)$/u.test(error.message)
          ? error.message : signal.aborted ? 'reflection_interrupted' : 'reflection_unavailable'
        const prepared = await sql`SELECT 1 FROM desktop_im_reflection_plans WHERE owner_id=${owner} AND session_id=${job.session_id}
          AND run_id=${job.run_id} AND scope_type=${job.scope_type} AND scope_id=${job.scope_id} AND payload IS NOT NULL`.execute(db)
        const failed = reason === 'reflection_authorization_changed' || (!prepared.rows.length && job.attempts >= 3)
        await sql`UPDATE desktop_im_reflection_jobs SET status=${failed ? 'failed' : 'queued'},claimed_at_ms=NULL,last_error=${reason}
          WHERE owner_id=${owner} AND session_id=${job.session_id} AND run_id=${job.run_id}
            AND scope_type=${job.scope_type} AND scope_id=${job.scope_id}
            AND status='processing' AND claimed_at_ms=${claimTime}`.execute(db)
      }
    }
  }
  async function drainReflections(signal = reflection.signal) {
    const provider = getProvider()
    if (!provider) return
    const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
    const claimTime = Date.now()
    const dueBefore = claimTime - PRIVATE_REFLECTION_IDLE_SECONDS * 1000
    const { rows: jobs } = await sql<{ run_id: string; session_id: number; user_message_id: number;
      model_identity: string; assistant_text: string; attempts: number; created_at_ms: number }>`
      WITH eligible AS MATERIALIZED (
        SELECT job.run_id FROM desktop_agent_reflection_jobs job
        WHERE job.user_id=${owner} AND job.session_id=${Number(sessionId)}
          AND job.model_identity=${modelIdentity} AND job.status='queued'
          AND (SELECT model_id FROM desktop_agent_run_models m
            WHERE m.user_id=job.user_id AND m.session_id=job.session_id AND m.run_id=job.run_id) IS ${modelId ?? null}
          AND NOT EXISTS (SELECT 1 FROM desktop_agent_reflection_jobs newer
            WHERE newer.user_id=job.user_id AND newer.session_id=job.session_id
              AND (newer.created_at_ms > ${dueBefore} OR newer.status='processing'))
      )
      UPDATE desktop_agent_reflection_jobs
      SET status='processing',claimed_at_ms=${claimTime},attempts=attempts+1
      WHERE user_id=${owner} AND session_id=${Number(sessionId)} AND run_id IN (SELECT run_id FROM eligible)
      RETURNING run_id,session_id,user_message_id,model_identity,assistant_text,attempts,created_at_ms`.execute(db)
    jobs.sort((left, right) => left.user_message_id - right.user_message_id)
    const job = jobs.at(-1)
    if (job) {
      const jobIds = JSON.stringify(jobs.map(row => row.run_id))
      const identity: RunIdentity = { ownerId, sessionId: String(job.session_id), runId: job.run_id }
      try {
        const turns = []
        for (const row of jobs) {
          const turn = await sessionSource.currentTurn({ ...identity, runId: row.run_id })
          if (Number(turn.currentUser?.persistedMessageId) !== row.user_message_id || !turn.currentUser)
            throw new Error('reflection_source_unavailable')
          turns.push({ userMessage: turn.currentUser.rawText ?? '', assistantReply: row.assistant_text,
            timestamp: new Date(row.created_at_ms).toISOString() })
        }
        const snapshot = await readSqliteAgentMemorySnapshot(db, ownerId, undefined, memoryFiles)
        const decode = (key: string, fallback: Json): Json => {
          const raw = snapshot.files[key]
          if (raw === undefined) return fallback
          return JSON.parse(raw) as Json
        }
        const current: Record<string, Json> = {
          profile: decode('profile', []), pattern: decode('pattern', []),
          summary: decode('summary', {}), daily: snapshot.files.daily ?? '',
          stance: decode('stance', {}), lens: decode('lens', {}),
        }
        const now = new Date()
        const timeout = AbortSignal.timeout(90_000)
        const reflection = await runPrivateReflection({
          ...identity, stableSystem: readAgentPrompt('reflection.md', promptDirectory).trim(),
          delta: formatOwnerReflectionEvidence({ date: dateKeyInTimeZone(now, timezone), userName: '',
            profile: current.profile, pattern: current.pattern, summary: current.summary }, turns),
          scope: runAccessScope(identity),
        }, { outputMode: 'json', maxOutputTokens: 1024 }, {
          provider: provider.reflectionProvider(job.model_identity), digest, nextId: randomUUID,
          async pauseBeforeRetry() {}, diagnostic: () => {},
        }, AbortSignal.any([signal, timeout]), observation, { trigger: 'idle' })
        signal.throwIfAborted()
        if (reflection.usage && typeof reflection.usage === 'object' && !Array.isArray(reflection.usage) && reflection.usage.incomplete_reason)
          throw new Error('reflection_output_empty')
        if (!reflection.ok) throw new Error(`reflection_${reflection.reason}`)
        const changes = applyOwnerReflectionOutput({ current, output: reflection.output,
          now: now.getTime(), date: dateKeyInTimeZone(now, timezone), nextId: randomUUID })
        await db.transaction().execute(async tx => {
          signal.throwIfAborted()
          const { rows: [owned] } = await sql`SELECT 1 FROM desktop_agent_reflection_jobs
            WHERE user_id=${owner} AND session_id=${job.session_id} AND run_id=${job.run_id}
              AND status='processing' AND claimed_at_ms=${claimTime}`.execute(tx)
          if (!owned) return
          const fresh = await readSqliteAgentMemorySnapshot(tx, ownerId, undefined, memoryFiles)
          if (fresh.revision !== snapshot.revision) {
            await sql`UPDATE desktop_agent_reflection_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
              claimed_at_ms=NULL,last_error='stale_memory_snapshot'
              WHERE user_id=${owner} AND session_id=${job.session_id} AND run_id IN (SELECT value FROM json_each(${jobIds}))
                AND status='processing' AND claimed_at_ms=${claimTime}`.execute(tx)
            return
          }
          for (const [target, value] of Object.entries(changes)) {
            const body = typeof value === 'string' ? value : JSON.stringify(value)
            if (target === 'profile' || target === 'pattern') {
              await sql`INSERT INTO desktop_agent_memory(user_id,target,body) VALUES(${owner},${target},${body})
                ON CONFLICT(user_id,target) DO UPDATE SET body=excluded.body`.execute(tx)
            } else {
              await sql`INSERT INTO desktop_agent_memory_documents(user_id,target,body) VALUES(${owner},${target},${body})
                ON CONFLICT(user_id,target) DO UPDATE SET body=excluded.body`.execute(tx)
            }
          }
          if (Object.keys(changes).length)
            await enqueueAgentRagRebuildInTransaction(tx, 'sqlite', ownerId, 'memory')
          await sql`UPDATE desktop_agent_reflection_jobs SET status='completed',claimed_at_ms=NULL,last_error=NULL
            WHERE user_id=${owner} AND session_id=${job.session_id} AND run_id IN (SELECT value FROM json_each(${jobIds}))
                AND status='processing' AND claimed_at_ms=${claimTime}`.execute(tx)
        })
      } catch (error) {
        const errorCode = signal.aborted ? 'reflection_interrupted' : error instanceof Error && /^reflection_(?:provider_error|output_empty|schema_invalid|source_unavailable)$/u.test(error.message)
          ? error.message : 'reflection_unavailable'
        await sql`UPDATE desktop_agent_reflection_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
          claimed_at_ms=NULL,last_error=${errorCode}
          WHERE user_id=${owner} AND session_id=${job.session_id} AND run_id IN (SELECT value FROM json_each(${jobIds}))
            AND status='processing' AND claimed_at_ms=${claimTime}`.execute(db)
      }
    }
    await drainImReflections(signal)
  }
  return { enqueueReflection, enqueueImReflection, drainReflections }
}

export function createDesktopReflectionRecovery(options: {
  db: SqlDataRuntime['db']
  ownerId: string
  memoryFiles: DesktopMemoryFiles | undefined
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  reflectionModelIdentity: (config: ProviderConfig) => string
  prepareRecovery: (sessionId: number, config: ProviderConfig, modelId?: string) => Promise<{
    agent: { close(): Promise<void> }
    recoverReflections(signal: AbortSignal): Promise<unknown>
  }>
}) {
  const { db, ownerId, memoryFiles, hostRequest, reflectionModelIdentity, prepareRecovery } = options
  const reflectionAbort = new AbortController()
  let reflectionRecovery: Promise<void> | undefined
  let reflectionTimer: ReturnType<typeof setTimeout> | undefined
  let reflectionTimerDue = Infinity
  let reflectionRecoveryRequested = false
  // 新回合唤醒闲置调度。认领时仍从持久化记录核对整段会话的闲置时间。
  function scheduleReflectionRecovery(delay: number) {
    if (reflectionAbort.signal.aborted) return
    const due = Date.now() + delay
    if (reflectionTimer && reflectionTimerDue <= due) return
    if (reflectionTimer) clearTimeout(reflectionTimer)
    reflectionTimerDue = due
    reflectionTimer = setTimeout(() => {
      reflectionTimer = undefined
      reflectionTimerDue = Infinity
      resumeReflections()
    }, delay)
    reflectionTimer.unref()
  }

  function resumeReflections() {
    if (reflectionAbort.signal.aborted) return
    if (reflectionRecovery) {
      reflectionRecoveryRequested = true
      return
    }
    const signal = reflectionAbort.signal
    reflectionRecovery = (async () => {
      const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
      // 每次闲置窗口只冻结一次，所有 scope 共用同一个上界。
      await sql`UPDATE desktop_im_reflection_triggers AS t SET idle_due_at_ms=NULL,passive_count=0,
        requested_sequence=MAX(t.requested_sequence,COALESCE((
          SELECT MAX(m.conversation_seq) FROM conversation_messages m
          WHERE m.session_id=t.session_id AND m.role='user' AND m.canonical_batch_id IS NULL),0))
        WHERE t.owner_id=${owner} AND t.idle_due_at_ms<=${Date.now()}
          AND EXISTS(SELECT 1 FROM conversation_sessions s WHERE s.user_id=t.owner_id AND s.id=t.session_id
            AND s.active_run_id IS NULL)`.execute(db)
      const now = Date.now()
      await db.transaction().execute(async tx => {
        await sql`UPDATE desktop_im_reflection_triggers AS t
          SET requested_sequence=MAX(t.requested_sequence,COALESCE((SELECT MAX(w.through_sequence)
            FROM desktop_im_reflection_thresholds w WHERE w.owner_id=t.owner_id AND w.session_id=t.session_id AND w.due_at_ms<=${now}),0))
          WHERE t.owner_id=${owner}`.execute(tx)
        await sql`DELETE FROM desktop_im_reflection_thresholds WHERE owner_id=${owner} AND due_at_ms<=${now}`.execute(tx)
      })
      await sql`UPDATE desktop_im_reflection_jobs AS j SET status='queued',attempts=0,last_error=NULL
        WHERE j.owner_id=${owner} AND j.status='completed'
          AND EXISTS(SELECT 1 FROM desktop_im_reflection_triggers t WHERE t.owner_id=j.owner_id AND t.session_id=j.session_id
            AND MAX(t.requested_sequence,CASE WHEN j.scope_type='owner' THEN COALESCE((SELECT MAX(w.through_sequence)
              FROM desktop_im_reflection_thresholds w WHERE w.owner_id=j.owner_id AND w.session_id=j.session_id),0) ELSE 0 END)
            >COALESCE((SELECT p.last_sequence FROM desktop_im_reflection_positions p
              WHERE p.owner_id=j.owner_id AND p.session_id=j.session_id AND p.scope_id=j.scope_id AND p.scope_type=j.scope_type),0))
          AND NOT EXISTS(SELECT 1 FROM desktop_im_reflection_jobs newer
            WHERE newer.owner_id=j.owner_id AND newer.session_id=j.session_id AND newer.scope_type=j.scope_type AND newer.scope_id=j.scope_id
              AND (newer.created_at_ms,newer.run_id)>(j.created_at_ms,j.run_id))`.execute(db)
      const { rows } = await sql<{ session_id: number; model_identity: string; model_id: string | null }>`
        SELECT DISTINCT jobs.session_id,jobs.model_identity,m.model_id FROM (
          SELECT user_id,session_id,run_id,model_identity FROM desktop_agent_reflection_jobs WHERE user_id=${owner} AND status='queued'
          UNION ALL
          SELECT owner_id AS user_id,session_id,run_id,model_identity FROM desktop_im_reflection_jobs WHERE owner_id=${owner} AND status='queued'
        ) jobs LEFT JOIN desktop_agent_run_models m
          ON m.user_id=jobs.user_id AND m.session_id=jobs.session_id AND m.run_id=jobs.run_id
        ORDER BY jobs.session_id,jobs.model_identity,m.model_id`.execute(db)
      for (const row of rows) {
        signal.throwIfAborted()
        try {
          const config = await hostRequest('agent.memory.resolveReflectionModel', { modelIdentity: row.model_identity, modelId: row.model_id }, signal) as ProviderConfig | null
          if (!config || reflectionModelIdentity(config) !== row.model_identity) continue
          const { agent, recoverReflections } = await prepareRecovery(row.session_id, config, row.model_id ?? undefined)
          try { await recoverReflections(signal); await memoryFiles?.flush() }
          finally { await agent.close() }
        } catch {
          signal.throwIfAborted()
        }
      }
    })().catch(() => {}).finally(async () => {
      reflectionRecovery = undefined
      if (reflectionAbort.signal.aborted) return
      if (reflectionRecoveryRequested) {
        reflectionRecoveryRequested = false
        scheduleReflectionRecovery(0)
        return
      }
      const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
      const { rows: [pending] } = await sql<{ due: number | null }>`
        SELECT MIN(due) AS due FROM (
          SELECT MAX(created_at_ms) + ${PRIVATE_REFLECTION_IDLE_SECONDS * 1000} AS due
          FROM desktop_agent_reflection_jobs WHERE user_id=${owner}
          GROUP BY session_id HAVING SUM(status='queued') > 0
          UNION ALL
          SELECT MAX(created_at_ms) + ${IM_REFLECTION_IDLE_SECONDS * 1000} AS due
          FROM desktop_im_reflection_jobs WHERE owner_id=${owner}
          GROUP BY session_id HAVING SUM(status='queued') > 0
          UNION ALL
          SELECT idle_due_at_ms AS due FROM desktop_im_reflection_triggers WHERE owner_id=${owner}
            AND idle_due_at_ms IS NOT NULL
          UNION ALL
          SELECT due_at_ms AS due FROM desktop_im_reflection_thresholds WHERE owner_id=${owner}
        )`.execute(db).catch(() => ({ rows: [] }))
      const unstaged = await sql`SELECT 1 FROM desktop_im_reflection_jobs j
        JOIN desktop_im_reflection_triggers t ON t.owner_id=j.owner_id AND t.session_id=j.session_id
        WHERE j.owner_id=${owner} AND j.status='completed'
          AND MAX(t.requested_sequence,CASE WHEN j.scope_type='owner' THEN COALESCE((SELECT MAX(w.through_sequence)
              FROM desktop_im_reflection_thresholds w WHERE w.owner_id=j.owner_id AND w.session_id=j.session_id),0) ELSE 0 END)
            >COALESCE((SELECT p.last_sequence FROM desktop_im_reflection_positions p
            WHERE p.owner_id=j.owner_id AND p.session_id=j.session_id AND p.scope_id=j.scope_id AND p.scope_type=j.scope_type),0)
          AND NOT EXISTS(SELECT 1 FROM desktop_im_reflection_jobs newer WHERE newer.owner_id=j.owner_id
            AND newer.session_id=j.session_id AND newer.scope_type=j.scope_type AND newer.scope_id=j.scope_id
            AND (newer.created_at_ms,newer.run_id)>(j.created_at_ms,j.run_id))
        LIMIT 1`.execute(db).catch(() => ({ rows: [] }))
      if (unstaged.rows.length) {
        scheduleReflectionRecovery(0)
        return
      }
      if (pending?.due != null) {
        const remaining = pending.due - Date.now()
        scheduleReflectionRecovery(remaining > 0 ? remaining : 30_000)
      }
    })
  }

  return {
    signal: reflectionAbort.signal,
    scheduleReflectionRecovery,
    resumeReflections,
    async close() {
      reflectionAbort.abort()
      if (reflectionTimer) clearTimeout(reflectionTimer)
      await reflectionRecovery
    },
  }
}

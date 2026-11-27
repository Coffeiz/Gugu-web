import { loadSqliteAgentRunSecret } from '#core-source/agent/run/sqlite-secret.js'
import type { AgentObservationPort } from '#core-source/agent/observation.js'
import type { CanonicalRunContext, RunCheckpoint, RunIdentity, InteractionResolution } from '#core-source/agent/models.js'
import { desktopFileReferenceKey, droppedFileReferenceId, readDesktopTurnReferences, workspaceFileReferenceId } from '#core-source/agent/sessions/desktop-references.js'
import { createKyselyPreferenceDocumentStore } from '#core-source/preferences/document-store.js'
import { CoreError, dataContext, DEFAULT_LLM_CONTEXT_TOKENS } from '#core-source/contracts/index.js'
import { sql, type Kysely } from 'kysely'
import { readAgentSessionContext } from '#core-source/agent/sessions/list.js'
import { createSubagentDeliveryStore } from '#core-source/agent/subagent/delivery-store.js'
import { createAgentInbox } from '#core-source/agent/subagent/inbox.js'
import { createSubagentService } from '#core-source/agent/subagent/service.js'
import { createSqliteAgentRunLeasePort, createSqliteAgentRunStore } from '#core-source/agent/run/sqlite-store.js'
import { createSqliteAgentRunCoordination } from '#core-source/agent/run/sqlite-coordination.js'
import { createDesktopContinuationStore } from '#core-source/runtime/desktop-continuation.js'
import type { DelegatedAgentLaunch } from '#core-source/agent/subagent/contracts.js'
import type { ProviderConfig, ProviderTransport } from '#core-source/agent/providers/contracts.js'
import { createDesktopAppearanceService } from '#core-source/preferences/desktop-appearance.js'
import { createNodeProviderTransport, desktopTransportOptions, createNodeProviderTransportFactory, desktopModelTransportOptions, type ProxyEndpoint } from '#core-source/agent/providers/transport/node.js'
import { createWebSearchTool } from '#core-source/agent/tools/search/index.js'
import { createSearcherReferenceSearch, createSearcherReferenceShell } from '#core-source/agent/subagent/searcher/references.js'
import { createHttpGetTool } from '#core-source/agent/tools/web/index.js'
import { createAgentHttpGetPort } from '#core-source/agent/tools/web/http-get.js'
import { createSubagentServiceTools } from '#core-source/agent/tools/subagent/index.js'
import type { Database } from '#core-source/data/schema.js'
import { isAbsolute } from 'node:path'
import { createDesktopShellTool } from '#core-source/runtime/desktop-shell.js'
import { createSqliteToolConfirmation, describeSqliteDelegatedConfirmation } from '#core-source/agent/interactions/sqlite-confirmation.js'
import { readDroppedFileExcerpt } from '#core-source/runtime/desktop-file-excerpt.js'
import { createAgentShellTool } from '#core-source/agent/tools/shell/index.js'
import { createToolRegistry } from '#core-source/agent/tools/registry.js'
import type { CanonicalContextPorts } from '#core-source/agent/ports.js'
import { randomUUID } from 'node:crypto'
import { connectProviderHarness } from '#core-source/agent/providers/runtime.js'
import { createDelegatedAgentHarness, delegatedTerminalOutcome } from '#core-source/agent/subagent/runner.js'
import { searcherPreset } from '#core-source/agent/subagent/searcher/context.js'
import { createSqliteInteractionActivator } from '#core-source/agent/interactions/sqlite-activate.js'
import { createAgentInteractionDescription } from '#core-source/agent/interactions/prompt-description.js'
import { describeSqliteMcpCredential } from '#core-source/agent/interactions/sqlite-credential.js'
import { ProviderStreamSanitizer, stripThinking } from '#core-source/agent/providers/sanitize.js'
import { ProviderError, providerErrorMessage } from '#core-source/agent/providers/errors.js'
import { consumeSqliteInteraction } from '#core-source/agent/interactions/sqlite-consume.js'
import { AgentRunError } from '#core-source/agent/models.js'
import { settleCancelledSqliteSubagentWait, settleStoppedSqliteAgentRun } from '#core-source/agent/run/sqlite-recovery.js'
import { listActiveSqliteAgentRuns } from '#core-source/agent/run/sqlite-admission.js'
import type { SqlDataRuntime } from '#core-source/data/runtime.js'
import type { createAgentWorkspaceQueries } from '#core-source/workspaces/workspace-list.js'
import type { desktopTrashTarget } from '#core-source/runtime/desktop-shell-trash.js'

export function createDesktopSubagentRuntime(options: {
  db: SqlDataRuntime['db']
  ownerId: string
  databasePath: string
  signal: AbortSignal
  running: Map<number, { runId: string; cancel(): Promise<unknown>; done: Promise<void> }>
  runTasks: Set<Promise<void>>
  scheduleSubagentWake: (parent: RunIdentity) => void
  agentWorkspaces: ReturnType<typeof createAgentWorkspaceQueries>
  digest: (value: unknown) => string
  runModel: (sessionId: number, runId: string) => Promise<string | null>
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  reflectionModelIdentity: (config: ProviderConfig) => string
  scheduledAgentProxy: (url: URL, signal?: AbortSignal) => Promise<ProxyEndpoint | undefined>
  configuredAgentTools: (names: readonly string[], signal?: AbortSignal) => Promise<string[]>
  moveShellTargetToTrash: (target: Awaited<ReturnType<typeof desktopTrashTarget>>, cwd: string, workspace: string | undefined, signal: AbortSignal) => Promise<unknown>
  resolveReferencedFile: (id: string, signal?: AbortSignal) => Promise<{ path: string; fileIdentity: string } | null>
  readDesktopShellPreferences: () => Promise<{ automaticMode: boolean; shellEnabled: boolean; dangerousEnabled: boolean }>
  observation: AgentObservationPort | undefined
  unavailable: () => Promise<never>
  notify: (sessionId: number, runId: string, interactionChanged?: true) => void
}) {
  const { db, ownerId, databasePath, signal, running, runTasks, scheduleSubagentWake, agentWorkspaces,
    digest, runModel, hostRequest, reflectionModelIdentity, scheduledAgentProxy, configuredAgentTools,
    moveShellTargetToTrash, resolveReferencedFile, readDesktopShellPreferences, observation, unavailable, notify } = options
  let subagents: ReturnType<typeof createSubagentService> | undefined
  let childScan: Promise<void> | undefined
  let childScanRequested = false
  const interactionExpirations = new Map<string, ReturnType<typeof setTimeout>>()

  function scheduleAdmittedRuns(secret: string) {
    if (signal.aborted) return
    childScanRequested = true
    if (childScan) return
    childScan = Promise.resolve().then(async () => {
      while (childScanRequested && !signal.aborted) {
        childScanRequested = false
        for (const { identity } of await listActiveSqliteAgentRuns(db, ownerId, 'subagent'))
          await dispatchAdmittedChild(secret, identity)
      }
    }).finally(() => {
      if (childScan) runTasks.delete(childScan)
      childScan = undefined
      if (childScanRequested) scheduleAdmittedRuns(secret)
    })
    runTasks.add(childScan)
    void childScan.catch(() => {})
  }

  async function searcherFileReferences(parent: RunIdentity, selected: readonly string[]) {
    if (parent.ownerId !== ownerId || !selected.length) return []
    const { references, inherited } = await readDesktopTurnReferences(db, parent)
    if (inherited) return []
    const allowed = new Set(selected)
    return references.flatMap(reference => {
      if (!reference || reference.type !== 'file' || typeof reference.id !== 'string' || typeof reference.label !== 'string'
        || (!workspaceFileReferenceId.test(reference.id) && !droppedFileReferenceId.test(reference.id))) return []
      const ref = desktopFileReferenceKey(reference.id)
      return allowed.has(ref) ? [{ id: reference.id, ref, label: reference.label }] : []
    })
  }

  async function parentWorkspace(parent: RunIdentity, reader = db) {
    const owner = dataContext(parent.ownerId).ownerId.replaceAll('-', '')
    const { rows: [session] } = await sql<{ session_context: string | null }>`SELECT session_context FROM conversation_sessions
      WHERE user_id=${owner} AND id=${Number(parent.sessionId)} AND (source IS NULL OR source='web')`.execute(reader)
    if (!session) throw new CoreError('not_found', '父会话不存在')
    const binding = readAgentSessionContext(session.session_context, 'sqlite').workspace_binding
    const directoryId = binding && typeof binding === 'object' && 'directory_id' in binding ? binding.directory_id : undefined
    const workspace = typeof directoryId === 'string' ? await agentWorkspaces.get(parent.ownerId, directoryId) : null
    return { directoryId: typeof directoryId === 'string' ? directoryId : null, available: Boolean(workspace),
      fingerprint: digest([directoryId ?? null, workspace?.workspace_id ?? null, workspace?.directory_name ?? null]) }
  }

  function desktopSubagents(secret: string) {
    if (subagents) return subagents
    const { store, cancellation } = desktopChildRunPorts(secret)
    const deliveries = createSubagentDeliveryStore(db, secret, undefined, 'sqlite')
    const inbox = createAgentInbox(db, secret, { onMessageCommitted: scheduleSubagentWake })
    subagents = createSubagentService({
      deliveries, childCheckpoints: store, inbox,
      async schedule() { scheduleAdmittedRuns(secret) },
      async requestCancellation(identity) {
        await cancellation.request(identity)
        const active = running.get(Number(identity.sessionId))
        if (active?.runId === identity.runId) await active.cancel()
        scheduleAdmittedRuns(secret)
      },
      async parentBinding(identity) {
        if (identity.ownerId !== ownerId) return null
        const { rows } = await sql`SELECT 1 FROM agent_run_admissions a
          JOIN conversation_sessions s ON s.id=a.session_id AND s.user_id=a.user_id
          WHERE a.user_id=${dataContext(ownerId).ownerId.replaceAll('-', '')} AND a.session_id=${Number(identity.sessionId)}
            AND a.run_id=${identity.runId} AND (s.source IS NULL OR s.source='web')
            AND (COALESCE(s.chat_type,'c2c')='c2c' OR NOT EXISTS(
              SELECT 1 FROM desktop_im_sessions im WHERE im.session_id=s.id AND im.owner_id=s.user_id
            ))`.execute(db)
        const checkpoint = rows.length ? await store.read(identity) : null
        return checkpoint?.context ? { agentId: 'builtin:main', modelIdentity: checkpoint.context.modelIdentity, workspaceFingerprint: (await parentWorkspace(identity)).fingerprint } : null
      },
      async authorizeResources(identity, refs) {
        if (identity.ownerId !== ownerId) return false
        const authorized = new Set((await searcherFileReferences(identity, refs)).map(item => item.ref))
        return refs.every(ref => authorized.has(ref))
      },
    })
    return subagents
  }

  let childRunPorts: ReturnType<typeof createDesktopChildRunPorts> | undefined
  function desktopChildRunPorts(secret: string) {
    return childRunPorts ??= createDesktopChildRunPorts(secret)
  }

  function createDesktopChildRunPorts(secret: string) {
    const store = createDesktopChildRunStore(secret)
    const leases = createSqliteAgentRunLeasePort(db)
    const { cancellation } = createSqliteAgentRunCoordination(db, store)
    return { store, leases, cancellation }
  }

  function createDesktopChildRunStore(secret: string, persistPrivateContext?: ReturnType<typeof createDesktopContinuationStore>['persist']) {
    return createSqliteAgentRunStore<CanonicalRunContext>(db, secret, {
      persistPrivateContext,
      onSubagentDeliveryCommitted(parent) {
        scheduleSubagentWake(parent)
        scheduleAdmittedRuns(secret)
      },
      // 子运行只在自己的加密 checkpoint 中保留对话，不写主聊天历史。
      async writeHistory() {},
    })
  }

  async function prepareAdmittedChild(secret: string, launch: DelegatedAgentLaunch, signal: AbortSignal) {
    const { leases, cancellation } = desktopChildRunPorts(secret)
    const continuation = createDesktopContinuationStore(db, secret)
    const store = createDesktopChildRunStore(secret, continuation.persist)
    const { identity, parent, modelIdentity } = launch
    if (!parent || identity.ownerId !== ownerId) throw new CoreError('conflict', '子运行身份无效')
    if ((await store.read(parent))?.context?.modelIdentity !== modelIdentity)
      throw new CoreError('conflict', '父会话模型绑定已失效')
    const workspaceCurrent = async (reader = db) => launch.workspaceFingerprint === undefined || launch.workspaceFingerprint === (await parentWorkspace(parent, reader)).fingerprint
    if (!await workspaceCurrent()) throw new CoreError('conflict', '父工作区绑定已变化')
    const modelId = await runModel(Number(parent.sessionId), parent.runId)
    const config = await hostRequest('agent.memory.resolveReflectionModel', { modelIdentity, modelId }, signal) as ProviderConfig | null
    if (!config || reflectionModelIdentity(config) !== modelIdentity)
      throw new CoreError('conflict', 'Searcher 模型绑定已失效')
    const preferences = await createDesktopAppearanceService(createKyselyPreferenceDocumentStore(db, 'sqlite')).get(ownerId)
    const resolveProxy = preferences.useSystemProxy ? scheduledAgentProxy : undefined
    const egress = {
      async withTransport<T>(signal: AbortSignal, execute: (transport: ProviderTransport) => Promise<T>): Promise<T> {
        signal.throwIfAborted()
        const transport = createNodeProviderTransport(desktopTransportOptions(false, resolveProxy))
        try { return await execute(transport) }
        finally { await transport.close() }
      },
    }
    const webSearch = createWebSearchTool(config, { ...egress, digest })
    const resourceRefs = launch.input.resourceRefs ?? []
    const fileTools = resourceRefs.length ? [createSearcherReferenceSearch(async signal => {
      signal.throwIfAborted()
      return (await searcherFileReferences(parent, resourceRefs)).map(({ ref, label }) => ({ ref, label }))
    })] : []
    const definitions = [createHttpGetTool(createAgentHttpGetPort(egress)), ...(webSearch ? [webSearch] : []), ...fileTools,
      ...createSubagentServiceTools(desktopSubagents(secret), "child")]
    const matches = (candidate: RunIdentity) => candidate.ownerId === identity.ownerId
      && candidate.sessionId === identity.sessionId && candidate.runId === identity.runId
    const authorizedChildShell = async (tx: Kysely<Database>, candidate: RunIdentity, signal: AbortSignal) => {
      signal.throwIfAborted()
      if (!matches(candidate) || !await workspaceCurrent(tx) || !(await configuredAgentTools(['shell'], signal)).length) return false
      const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
      const result = await sql`SELECT 1 FROM agent_run_leases l JOIN agent_run_checkpoints p ON p.user_id=l.user_id
        AND p.session_id=${parent.sessionId} AND p.run_id=${parent.runId}
        WHERE l.user_id=${owner} AND l.session_id=${identity.sessionId} AND l.run_id=${identity.runId}
          AND l.expires_at_ms>${Date.now()} AND p.status IN ('running','waiting')
          AND NOT EXISTS (SELECT 1 FROM agent_run_controls c WHERE c.user_id=l.user_id AND c.cancel_requested=1
            AND ((c.session_id=p.session_id AND c.run_id=p.run_id) OR (c.session_id=l.session_id AND c.run_id=l.run_id)))`.execute(tx)
      signal.throwIfAborted()
      return result.rows.length === 1
    }
    const { directoryId: directory, available } = await parentWorkspace(parent)
    const readRoot = async () => {
      if (!directory || !available || !await workspaceCurrent()) return null
      const root = await hostRequest('agent.files.workspaceRoot', { directoryId: directory }, signal)
      return root && typeof root === 'object' && 'path' in root && typeof root.path === 'string' && isAbsolute(root.path)
        && 'identity' in root && typeof root.identity === 'string' ? { path: root.path, identity: root.identity } : null
    }
    const sharedRoot = launch.workspaceFingerprint && !resourceRefs.length ? await readRoot() : null
    const enabledShell = !resourceRefs.length && (!directory || sharedRoot)
      ? await createDesktopShellTool(db, createSqliteToolConfirmation(db, authorizedChildShell, "shell"), digest,
        async scope => await authorizedChildShell(db, scope.identity, scope.signal) ? await readDesktopShellPreferences() : null,
        sharedRoot ? async () => {
          const current = await readRoot()
          return current?.identity === sharedRoot.identity && current.path === sharedRoot.path ? current : null
        } : undefined, parent, moveShellTargetToTrash) : undefined
    const referenceShell = resourceRefs.length ? createSearcherReferenceShell(async (ref, scope, maxOutputChars) => {
      if (!await authorizedChildShell(db, scope.identity, scope.signal) || !(await readDesktopShellPreferences()).shellEnabled)
        return { kind: "completed", successful: false, executed: false, mutated: false, value: { error: "Shell 权限已失效" } }
      const reference = (await searcherFileReferences(parent, resourceRefs)).find(item => item.ref === ref)
      const selected = reference ? await resolveReferencedFile(reference.id, scope.signal) : null
      const file = selected ? await readDroppedFileExcerpt(selected.path, selected.fileIdentity, scope.signal) : null
      if (!file) return { kind: "completed", successful: false, executed: false, mutated: false,
        value: { error: "文件引用不存在或无权访问" } }
      if (file.text === null) return { kind: "completed", successful: false, executed: false, mutated: false,
        value: { error: "该文件没有可读取的正文" } }
      return { kind: "completed", successful: true, executed: true, mutated: false,
        value: { stdout: file.text.slice(0, maxOutputChars), name: file.name, truncated: file.text.length > maxOutputChars } }
    }) : undefined
    const shell = referenceShell ?? enabledShell ?? createAgentShellTool(async () => ({
      kind: "completed", successful: false, executed: false, mutated: false,
      value: { error: "当前工作区或 Shell 隔离环境不可用" },
    }), "按父会话权限执行 Shell。", false)
    const tools = createToolRegistry({
      tools: definitions, confirmationGatedDestructiveTools: [shell],
      authorize: async (candidate, name) => matches(candidate) && await workspaceCurrent() && (await configuredAgentTools([name])).length === 1,
    })
    const accessScopeHash = digest([identity, modelIdentity, ...(launch.workspaceFingerprint === undefined ? [] : [launch.workspaceFingerprint])])
    const context: CanonicalContextPorts = {
      digest, nextId: randomUUID,
      async load(candidate) {
        if (!matches(candidate)) throw new CoreError('conflict', '子运行身份无效')
        const available = await tools.capabilities(candidate)
        return { modelIdentity, accessScopeHash, contextWindow: typeof config.context_tokens === 'number' ? config.context_tokens : DEFAULT_LLM_CONTEXT_TOKENS,
          input: { ...candidate, fixedPrefix: [], history: [] },
          capabilities: { tools: available, toolNames: available.map(tool => tool.name) } }
      },
      preparation: { async buildRag() { return { tail: [] } } },
      references: { async hydrate(entry) { return entry.message }, async dehydrate(entry) { return entry.message } },
      async prepareRequest() { return { prefix: [], dynamicTail: [] } },
      currentRequest: () => null, stageContinuation: unavailable, async releaseContinuations() {},
      compaction: { summarize: unavailable },
      finalization: { async complete() {} }, diagnoseCompactionFailure() {},
    }
    const connected = connectProviderHarness(context, {
      continuationStore: continuation.store,
      async resolve(candidate) {
        if (!matches(candidate)) throw new CoreError('conflict', '子运行身份无效')
        return { config, modelIdentity, accessScopeHash, systemPrompt: '' }
      },
      transportFactory: createNodeProviderTransportFactory(desktopModelTransportOptions(config, resolveProxy)),
    })
    const harness = createDelegatedAgentHarness(searcherPreset, launch, {
      context: connected.context,
      executor: { authorize: unavailable, executor: { execute: unavailable } },
        runtime: { store, leases, observation, cancellation: {
          ...cancellation,
          async isRequested(candidate) {
            return await cancellation.isRequested(parent) || await cancellation.isRequested(candidate)
          },
        }, provider: connected.provider, tools: tools.tools,
        interactions: createSqliteInteractionActivator(db, createAgentInteractionDescription({
          confirmation: describeSqliteDelegatedConfirmation, credential: describeSqliteMcpCredential, authorization: unavailable,
        })), clock: { now: () => new Date().toISOString() },
        sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(),
        presentError: error => error instanceof ProviderError ? { code: error.code, text: providerErrorMessage(error) }
          : { code: 'agent_failed', text: '子任务生成失败' },
        presentToolResult: async value => value, async publish(event) {
          notify(Number(parent.sessionId), parent.runId,
            event.type === 'interaction_required' || event.type === 'interaction_resolved' ? true : undefined)
        }, diagnose() {} },
    })
    return { harness, async close() { await connected.provider.close() } }
  }

  async function dispatchAdmittedChild(secret: string, identity: RunIdentity) {
    const sessionId = Number(identity.sessionId)
    if (signal.aborted || running.has(sessionId)) return
    const { rows: [origin] } = await sql<{ parent_session_id: string; parent_run_id: string }>`
      SELECT d.parent_session_id,d.parent_run_id FROM agent_subagent_deliveries d
      JOIN agent_subagent_executions e USING(child_run_id)
      WHERE d.owner_id=${identity.ownerId} AND e.child_session_id=${sessionId} AND e.child_run_id=${identity.runId}
        AND d.status IN ('queued','running')`.execute(db)
    if (!origin || running.has(sessionId)) return
    const parent = { ownerId: identity.ownerId, sessionId: origin.parent_session_id, runId: origin.parent_run_id }
    const deliveries = createSubagentDeliveryStore(db, secret, undefined, 'sqlite')
    const { store, cancellation } = desktopChildRunPorts(secret)
    const checkpoint = await store.read(identity)
    let resolution: InteractionResolution | undefined
    if (checkpoint?.status === 'waiting' && checkpoint.pending && !await cancellation.isRequested(identity)) {
      const pending = checkpoint.pending
      const prompt = await deliveries.interactionPrompt(identity, pending.id)
      if (prompt?.status === 'resolved') {
        resolution = (await consumeSqliteInteraction(db, identity, prompt.id, null, '')).resolution ?? undefined
        if (!resolution) return
      } else if (prompt?.status === 'active' && Date.parse(String(prompt.expires_at)) > Date.now()) {
        if (!interactionExpirations.has(identity.runId)) {
          const timer = setTimeout(() => {
            interactionExpirations.delete(identity.runId)
            scheduleAdmittedRuns(secret)
          }, Math.max(1, Date.parse(String(prompt.expires_at)) - Date.now()))
          timer.unref()
          interactionExpirations.set(identity.runId, timer)
        }
        return
      } else {
        resolution = { status: prompt ? 'expired' : 'aborted', interactionId: pending.id,
          receiptId: `desktop-interaction-closed:${pending.id}`, value: null }
      }
    }
    clearTimeout(interactionExpirations.get(identity.runId))
    interactionExpirations.delete(identity.runId)
    if (running.has(sessionId)) return
    let waiting = false
    const done = Promise.resolve().then(async () => {
      const launch = await deliveries.readLaunch(parent, identity.runId)
      if (!launch) return
      try {
        const stored = checkpoint && delegatedTerminalOutcome(checkpoint)
        if (stored) {
          if (await deliveries.complete(parent, identity.runId, stored)) scheduleSubagentWake(parent)
          return
        }
        const runtime = await prepareAdmittedChild(secret, { ...launch, identity, parent }, AbortSignal.timeout(20_000))
        try {
          const stream = checkpoint ? runtime.harness.resume(identity, resolution) : runtime.harness.start(identity)
          for (;;) {
            const next = await stream.next()
            if (next.done) {
              waiting = next.value.status === 'waiting'
              break
            }
          }
        } finally { await runtime.close() }
      } catch (error) {
        if (error instanceof AgentRunError && ['conflict', 'lease_lost', 'persistence_unknown'].includes(error.code)) {
          await settleStoppedSqliteAgentRun(db, databasePath, identity, parent)
          scheduleSubagentWake(parent)
          notify(Number(parent.sessionId), parent.runId)
          return
        }
        const result = await cancellation.isRequested(identity) ? { status: 'cancelled', reasonCode: 'cancelled' } as const
          : { status: 'failed', reasonCode: 'subagent_execution_failed' } as const
        if (await deliveries.complete(parent, identity.runId, result)) scheduleSubagentWake(parent)
      }
    }).finally(() => {
      if (running.get(sessionId)?.runId === identity.runId) running.delete(sessionId)
      runTasks.delete(done)
      if (waiting) scheduleAdmittedRuns(secret)
    })
    running.set(sessionId, { runId: identity.runId, done, async cancel() {
      if (signal.aborted && (await store.read(identity))?.status === 'waiting') return
      await cancellation.request(identity)
      await cancellation.notify(identity)
    } })
    runTasks.add(done)
    void done.catch(() => {})
  }

  return {
    desktopSubagents, scheduleAdmittedRuns, dispatchAdmittedChild,
    async cancelChildren(identity: RunIdentity) { await subagents?.cancelChildren(identity) },
    clearInteractionTimers() {
      for (const timer of interactionExpirations.values()) clearTimeout(timer)
      interactionExpirations.clear()
    },
  }
}

/** 子代理交付后唤醒父运行：会话被用户的新一轮消息占用时退避重试，等待中的父运行不能就此搁置。 */
const SUBAGENT_WAKE_RETRY_MS = 1_500
const SUBAGENT_WAKE_MAX_RETRY_DELAY_MS = 5_000
const SUBAGENT_WAKE_MAX_ATTEMPTS = 40
/** 唤醒预算只覆盖运行时重建，真正的模型往返由运行自身控制。 */
const SUBAGENT_WAKE_RESUME_TIMEOUT_MS = 30_000


export function createDesktopSubagentWake(options: {
  db: SqlDataRuntime['db']
  databasePath: string
  ownerId: string
  signal: AbortSignal
  notify: (sessionId: number, runId: string) => void
  activeRunDone: (sessionId: number) => Promise<void> | undefined
  resumeCheckpoint: (checkpoint: RunCheckpoint<CanonicalRunContext>, signal: AbortSignal) => Promise<boolean>
}) {
  const { db, databasePath, ownerId, signal, notify, activeRunDone, resumeCheckpoint } = options
  const subagentWakes = new Map<string, Promise<void>>()

  async function attemptSubagentWake(parent: RunIdentity): Promise<void> {
    const sessionId = Number(parent.sessionId)
    const active = activeRunDone(sessionId)
    if (active) await Promise.allSettled([active])
    if (signal.aborted) return
    const { rows: [admission] } = await sql<{ run_id: string }>`SELECT a.run_id FROM agent_run_admissions a
      WHERE a.user_id=${dataContext(ownerId).ownerId.replaceAll('-', '')} AND a.session_id=${sessionId} AND a.run_id=${parent.runId}`.execute(db)
    if (!admission) return
    const recipient = { ...parent, runId: admission.run_id }
    const secret = await loadSqliteAgentRunSecret(db, databasePath)
    const store = createSqliteAgentRunStore<CanonicalRunContext>(db, secret, {
      async writeHistory() { throw new Error('只读子运行唤醒不接受历史写入') },
    })
    const checkpoint = await store.read(recipient)
    if (checkpoint?.status !== 'waiting') return
    const { rows: [control] } = await sql<{ cancel_requested: number }>`SELECT cancel_requested FROM agent_run_controls
      WHERE user_id=${dataContext(ownerId).ownerId.replaceAll('-', '')} AND session_id=${sessionId} AND run_id=${parent.runId}`.execute(db)
    if (control?.cancel_requested === 1) {
      // 用户已取消等待中的父运行：直接结算，不再续跑。
      if (await settleCancelledSqliteSubagentWait(db, databasePath, recipient)) {
        notify(sessionId, parent.runId)
        return
      }
      // 会话被用户的新一轮消息占用：退避重试，等会话收尾后再结算。
      throw new AgentRunError('conflict', '会话正在执行')
    }
    const ready = checkpoint.subagentWaitChildId
      ? !await store.isSubagentPending(recipient, checkpoint.subagentWaitChildId)
      : checkpoint.agentInboxWaiting && (checkpoint.phase === 'decision'
        ? !await store.hasPendingSubagents?.(recipient)
        : Boolean((await store.readAgentInbox?.(recipient))?.length || (await store.readSubagentFinals?.(recipient))?.length))
    if (!ready) return
    await resumeCheckpoint(checkpoint, AbortSignal.any([signal, AbortSignal.timeout(SUBAGENT_WAKE_RESUME_TIMEOUT_MS)]))
  }

  function scheduleSubagentWake(parent: RunIdentity) {
    if (parent.ownerId !== ownerId || signal.aborted) return
    const key = parent.sessionId
    const previous = subagentWakes.get(key)
    const wake = Promise.resolve(previous).then(async () => {
      for (let attempt = 0; attempt < SUBAGENT_WAKE_MAX_ATTEMPTS; attempt++) {
        if (signal.aborted) return
        try {
          await attemptSubagentWake(parent)
          return
        }
        catch (error) {
          // 会话被用户的新一轮消息占用：退避后重试，等待中的父运行不能就此搁置。
          if (!(error instanceof AgentRunError) || error.code !== 'conflict') throw error
          const delay = Math.min(SUBAGENT_WAKE_RETRY_MS * (attempt + 1), SUBAGENT_WAKE_MAX_RETRY_DELAY_MS)
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, delay)
            signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
          })
        }
      }
      // 重试预算用尽：父运行保留等待状态，交由下一次交付唤醒或独占启动恢复兜底。
      notify(Number(parent.sessionId), parent.runId)
    }).catch(() => {
      // 已提交的等待和终态继续保留，供独占启动恢复。
      notify(Number(parent.sessionId), parent.runId)
    }).finally(() => {
      if (subagentWakes.get(key) === wake) subagentWakes.delete(key)
    })
    subagentWakes.set(key, wake)
  }

  return {
    scheduleSubagentWake,
    async drain() { await Promise.allSettled([...subagentWakes.values()]) },
  }
}

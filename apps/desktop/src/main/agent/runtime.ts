import { AgentRunError } from '../../../../../packages/core/src/agent/models.js'
import type { DelegatedAgentLaunch } from '../../../../../packages/core/src/agent/subagent/contracts.js'
import { createAgentShellTool } from '../../../../../packages/core/src/agent/tools/shell.js'
import { desktopScheduleImDeliveryTargets, desktopScheduleImPlatforms, desktopScheduleImTarget, ownsDesktopScheduleImTarget, readDesktopScheduleImTargets, type DesktopScheduleImPlatform, type DesktopScheduleImTarget } from '../../../../../packages/core/src/scheduled-tasks/desktop-im.js'
import { createListScheduledTasksTool } from '../../../../../packages/core/src/agent/tools/scheduled-tasks.js'
import { appendWorkspaceAgentInstructions } from '../../../../../packages/core/src/agent/context/prompt-format.js'
import { mcpServiceReminder, type McpToolLookup } from '../../../../../packages/core/src/mcp/tool-directory.js'
import { createImSendFileTool } from '../../../../../packages/core/src/agent/tools/send-file.js'
import { cleanupDesktopDownloadStaging, createDesktopWebDownload } from '../../../../../packages/core/src/runtime/desktop-web-download.js'
import { openStreamedAgentGet } from '../../../../../packages/core/src/agent/tools/streamed-http-get.js'
import { createHttpGetTool } from '../../../../../packages/core/src/agent/tools/web.js'
import type { DesktopGroupSender } from '../../../../../packages/core/src/agent/run/sqlite-admission.js'
import { createDesktopGroupContextSearch } from '../../../../../packages/core/src/im/desktop-group-context.js'
import { desktopImAttachmentDelivery, desktopImGroupRunEvent } from '../../../../../packages/core/src/im/desktop-inbox.js'
import { createImMemoryContextSource, type ImMemoryReadAuthorization } from '../../../../../packages/core/src/im/memory-source.js'
import { imCanUseGroupOwnerMemory } from '../../../../../packages/core/src/im/access.js'
import { formatGroupMemory, formatPlatformUserMemory } from '../../../../../packages/core/src/im/memory-context.js'
import type { ImActor } from '../../../../../packages/core/src/im/access.js'
import { createGroupContextSearchTool } from '../../../../../packages/core/src/agent/tools/group-context.js'
import { validateMcpEndpoint } from '../../../../../packages/core/src/mcp/server-config.js'
import { isPublicAddress } from '../../../../../packages/core/src/agent/providers/transport/network.js'
import { desktopFileReferenceKey, droppedFileReferenceId, readDesktopTurnReferences, workspaceFileReferenceId } from '../../../../../packages/core/src/agent/sessions/desktop-references.js'
import { openDroppedFile, readDroppedFileExcerpt } from '../../../../../packages/core/src/runtime/desktop-file-excerpt.js'
import { createAgentToolBrief, projectAgentToolBrief } from '../../../../../packages/core/src/agent/capabilities/brief.js'
import { createDesktopContinuationStore } from '../../../../../packages/core/src/runtime/desktop-continuation.js'
import { createFirstTurnTitleWriter } from '../../../../../packages/core/src/agent/sessions/title.js'
import { createAgentLog } from '@gugu/log'
import { createWebLinkButtonDeliveryPort } from '../../../../../packages/core/src/agent/tools/link-buttons.js'
import { readPreferenceDocument } from '../../../../../packages/core/src/preferences/general.js'
import { createClientDeletePort } from '../../../../../packages/core/src/agent/tools/clients.js'
import type { ProjectFileOverview } from '../../../../../packages/core/src/agent/tools/projects.js'
import { createDesktopShellTool, desktopHostAuthorization } from '../../../../../packages/core/src/runtime/desktop-shell.js'
import { createSendEmailTool, createDurableAgentEmailDelivery } from '../../../../../packages/core/src/agent/tools/email.js'
import { createLocalPreferenceTextFiles } from '../../../../../packages/core/src/preferences/text-files.js'
import { createDesktopAppearanceService } from '../../../../../packages/core/src/preferences/desktop-appearance.js'
import { normalizeThemePalette } from '../../../../../packages/core/src/preferences/palette.js'
import { renderSmtpDraftMessage, sanitizeEmailHtml } from '../../../../../packages/core/src/email/smtp-test.js'
import { createKyselyPreferenceDocumentStore } from '../../../../../packages/core/src/preferences/document-store.js'
import type { DesktopMemoryFiles } from '../../../../../packages/core/src/agent/memory/desktop-files.js'
import { readAgentPrompt, readAgentPromptSet } from '../../../../../packages/core/src/agent/context/prompts.js'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drainAgentRuns } from '../../../../../packages/core/src/agent/run/shutdown.js'
import { constants as fsConstants } from 'node:fs'
import { publishDesktopKnowledgeFile } from '../../../../../packages/core/src/runtime/desktop-knowledge-files.js'
import { open as openFile, realpath, stat } from 'node:fs/promises'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../../../../../packages/core/src/data/schema.js'
import { desktopScheduledTasks } from '../../../../../packages/core/src/scheduled-tasks/desktop.js'
import { ScheduledTaskReferenceError } from '../../../../../packages/core/src/scheduled-tasks/task-write.js'
import { createSqliteToolConfirmation, describeSqliteDelegatedConfirmation } from '../../../../../packages/core/src/agent/interactions/sqlite-confirmation.js'
import { createScheduledTaskDeleteTool, createScheduledTaskWriteTools } from '../../../../../packages/core/src/agent/tools/scheduled-tasks.js'
import type { SqlDataRuntime } from '../../../../../packages/core/src/data/runtime.js'
import { createAgentCalendarReader } from '../../../../../packages/core/src/calendar/application/event-read.js'
import { createKyselyCalendarAgentReadPort, createKyselyCalendarReadPort } from '../../../../../packages/core/src/calendar/read-store.js'
import { createAgentPlaceableSearch, createSqlMindCanvasReader } from '../../../../../packages/core/src/mind/canvas-read.js'
import { createAgentWorkspaceQueries } from '../../../../../packages/core/src/workspaces/workspace-list.js'
import { createDesktopWorkspaceReadPort } from './workspace-queries.js'
import { readAgentSessionContext } from '../../../../../packages/core/src/agent/sessions/list.js'
import { createAgentMindReader } from '../../../../../packages/core/src/mind/note-read.js'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries } from '../../../../../packages/core/src/scheduled-tasks/task-list.js'
import { createGlobalSearchOperations } from '../../../../../packages/core/src/search/global-search.js'
import { createKyselySqliteGlobalSearchSources } from '../../../../../packages/core/src/search/sqlite.js'
import { CoreError, dataContext, DEFAULT_LLM_CONTEXT_TOKENS, DEFAULT_LLM_OUTPUT_TOKENS } from '../../../../../packages/core/src/contracts/index.js'
import { stableJson } from '../../../../../packages/core/src/agent/context/history/canonical-history.js'
import { applyOwnerReflectionOutput } from '../../../../../packages/core/src/agent/memory/owner-reflection.js'
import { applyImMaintenanceOutput } from '../../../../../packages/core/src/memory/im-maintenance-apply.js'
import { applyReflectionFileWrite, IM_REFLECTION_IDLE_SECONDS, PRIVATE_REFLECTION_IDLE_SECONDS, qualifiesReflectionTurn } from '../../../../../packages/core/src/agent/memory/reflection/window.js'
import { runReflection, runPrivateReflection } from '../../../../../packages/core/src/agent/memory/reflection.js'
import { dateKeyInTimeZone } from '../../../../../packages/core/src/shared/date-time.js'
import { formatOwnerReflectionEvidence } from '../../../../../packages/core/src/agent/scenes/reflection/owner.js'
import { createMainContextBuilder } from '../../../../../packages/core/src/agent/scenes/main/definition.js'
import { contextAccessScopeHash, createCanonicalSourceLoader, readSessionSnapshot } from '../../../../../packages/core/src/agent/context/prepare.js'
import type { AgentObservationPort } from '../../../../../packages/core/src/agent/observation.js'
import { agentContextSnapshotPrefix } from '../../../../../packages/core/src/agent/context/builder.js'
import { agentPromptPreferenceFields, buildAgentStaticPrompt, formatAgentMemory } from '../../../../../packages/core/src/agent/context/prompt-format.js'
import { createAgentCompactionPort, createLazyAgentCompactionPort } from '../../../../../packages/core/src/agent/context/compaction-runtime.js'
import type { AgentProviderAuxiliaryPorts } from '../../../../../packages/core/src/agent/runtime.js'
import { buildFixedRequestPrefix } from '../../../../../packages/core/src/agent/context/assemble.js'
import { formatSqliteAgentOverview, readSqliteAgentOverviewData, readSqliteOwnerStylePreferences, readSqliteAgentStylePreferences, type SqliteAgentOverviewData } from '../../../../../packages/core/src/agent/context/sqlite-overview.js'
import { createSqliteAgentSessionSource } from '../../../../../packages/core/src/agent/context/sqlite-source.js'
import type { RagQueryEmbeddingSettings } from '../../../../../packages/core/src/agent/rag/query-embedding.js'
import type { CanonicalRunContext, Json, RunCheckpoint, RunIdentity, InteractionResolution, PreparedToolDefinition } from '../../../../../packages/core/src/agent/models.js'
import type { DesktopAgentChatReference } from '../../../../../packages/core/src/contracts/desktop.js'
import type { ProviderConfig, ProviderTransport } from '../../../../../packages/core/src/agent/providers/contracts.js'
import { ProviderError, providerErrorMessage } from '../../../../../packages/core/src/agent/providers/errors.js'
import { adapterFor } from '../../../../../packages/core/src/agent/providers/registry.js'
import { ProviderStreamSanitizer, stripThinking } from '../../../../../packages/core/src/agent/providers/sanitize.js'
import { createNodeProviderTransport, desktopTransportOptions, createNodeProviderTransportFactory, desktopModelTransportOptions, type NodeProviderTransportOptions, type ProxyEndpoint } from '../../../../../packages/core/src/agent/providers/transport/node.js'
import { testMcp, type McpConfig } from '../../../../../packages/core/src/mcp/desktop-connection.js'
import { createMcpManagementTool, createMcpManagementEditOperations, createMcpManagementRemoveOperations, createMcpManagementCreateOperations, describeMcpManagementUpdate } from '../../../../../packages/core/src/agent/tools/mcp-management.js'
import { createMcpServerConfigLister } from '../../../../../packages/core/src/mcp/server-list.js'
import { createDesktopMcpAgentRuntime } from '../../../../../packages/core/src/mcp/desktop-agent-runtime.js'
import { createMcpAgentToolPorts } from '../../../../../packages/core/src/mcp/agent-tools.js'
import { createDesktopMcpCrypto } from '../../../../../packages/core/src/mcp/desktop-crypto.js'
import {
  createSqliteAgentMemoryRagStorage, createSqliteAgentMemoryRagVectors,
  createSqliteMemorySearch, createSqliteRememberMemory, readSqliteAgentMemory, readSqliteAgentMemorySnapshot,
} from '../../../../../packages/core/src/agent/memory/sqlite.js'
import { createAgentKnowledgeOverview } from '../../../../../packages/core/src/agent/knowledge/overview.js'
import { createLocalAgentKnowledgeWritePort, createLocalAgentKnowledgeDeletePort } from '../../../../../packages/core/src/agent/knowledge/local-write.js'
import { createLocalAgentKnowledgeReadStore } from '../../../../../packages/core/src/agent/knowledge/local-store.js'
import { createOwnerAgentKnowledgeReadPort } from '../../../../../packages/core/src/agent/knowledge/read-port.js'
import { createAgentHttpGetPort } from '../../../../../packages/core/src/agent/tools/http-get.js'
import { createSqlAgentConversationTextReader } from '../../../../../packages/core/src/agent/sessions/data.js'
import { createCoreAgentConversationSearchPort } from '../../../../../packages/core/src/agent/sessions/tool-search.js'
import { createBuiltinSkillDefinitions, formatBuiltinSkillIndex, type BuiltinSkillDefinition } from '../../../../../packages/core/src/agent/skills/builtin.js'
import { createBundledSkillDocuments } from '../../../../../packages/core/dist/agent/skills/bundled.js'
import { createAgentSkillRuntimePorts } from '../../../../../packages/core/src/agent/skills/runtime.js'
import { createSkillDeleteTool, createSkillManagementWriteTools } from '../../../../../packages/core/src/agent/tools/skill-management.js'
import { createDesktopSkillManager, desktopMcp, desktopMcpMaxServers } from '../../../../../packages/core/src/runtime/desktop-resources.js'
import { createSkillMetadataReader } from '../../../../../packages/core/src/agent/skills/user-read.js'
import { createUserSkillReader } from '../../../../../packages/core/src/agent/skills/user-body.js'
import { rejectAdapterCall, resolveCallTool } from '../../../../../packages/core/src/agent/tools/call-adapter.js'
import { createCanvasBatchPort, createCanvasCreationPort, createCanvasDeleteNotePort, createCanvasDeletePort, createCanvasDisconnectPort, createCanvasEditPort } from '../../../../../packages/core/src/agent/tools/canvas.js'
import { createCalendarDeletePort, createCalendarEventCreatePort, createCalendarEventUpdatePort, type CalendarReminderTargetPort } from '../../../../../packages/core/src/agent/tools/calendar.js'
import { createUndoLastActionTool } from '../../../../../packages/core/src/agent/tools/undo.js'
import { createAgentUndoLastActionPort } from '../../../../../packages/core/src/agent/tools/undo-port.js'
import { createRuntimeUndoTransactionPort, createUndoStateMachine, UndoError } from '../../../../../packages/core/src/undo/state-machine.js'
import { createCalendarUndoAdapter } from '../../../../../packages/core/src/calendar/undo-adapter.js'
import { createDesktopProjectUndoAdapter } from '../../../../../packages/core/src/runtime/desktop-project-undo.js'
import { createNoteLifecyclePort, createNoteWritePort } from '../../../../../packages/core/src/agent/tools/note.js'
import { createKyselyProjectCreateRuntime } from '../../../../../packages/core/src/projects/create-store.js'
import { createDurableProjectMutationPort } from '../../../../../packages/core/src/agent/tools/projects/mutation-port.js'
import { createKnowledgeDeleteTool } from '../../../../../packages/core/src/agent/tools/knowledge.js'
import { createOwnerToolRegistry } from '../../../../../packages/core/src/agent/tools/owner.js'
import { createSaveAttachmentTool } from '../../../../../packages/core/src/agent/tools/files.js'
import { createTimeTool } from '../../../../../packages/core/src/agent/tools/time.js'
import { createToolRegistry } from '../../../../../packages/core/src/agent/tools/registry.js'
import { projectRecentAttachments, type RecentAttachmentRow } from '../../../../../packages/core/src/agent/attachments/recent.js'
import { createDeepResearchTool, createSimilarImageSearchTool, createWebSearchTool } from '../../../../../packages/core/src/agent/tools/search.js'
import { desktopDeepResearchResult, MAX_DESKTOP_SEARCH_IMAGE_BYTES } from '../../../../../packages/core/src/agent/search-contracts.js'
import { createSqliteAgentAdmission, listActiveSqliteAgentRuns } from '../../../../../packages/core/src/agent/run/sqlite-admission.js'
import { createSqlAgentPendingQueue } from '../../../../../packages/core/src/agent/sessions/pending-queue.js'
import { createSqliteAgentRuntime } from '../../../../../packages/core/src/agent/run/sqlite-runtime.js'
import { createSqliteInteractionProjection } from '../../../../../packages/core/src/agent/interactions/sqlite-projection.js'
import { describeSqliteMcpCredential, stageSqliteMcpCredential } from '../../../../../packages/core/src/agent/interactions/sqlite-credential.js'
import { consumeSqliteInteraction } from '../../../../../packages/core/src/agent/interactions/sqlite-consume.js'
import { InteractionConsumeError } from '../../../../../packages/core/src/agent/interactions/consume-action.js'
import { InteractionTextError } from '../../../../../packages/core/src/agent/interactions/consume-text.js'
import { createSqliteInteractionActivator } from '../../../../../packages/core/src/agent/interactions/sqlite-activate.js'
import { createAgentInteractionDescription } from '../../../../../packages/core/src/agent/interactions/prompt-description.js'
import { createAgentInbox } from '../../../../../packages/core/src/agent/subagent/inbox.js'
import { createSubagentService } from '../../../../../packages/core/src/agent/subagent/service.js'
import { assembleSubagentCatalog, builtinSubagentCatalog } from '../../../../../packages/core/src/agent/context/modules/subagent-catalog.js'
import { createSearcherReferenceSearch, createSearcherReferenceShell } from '../../../../../packages/core/src/agent/subagent/searcher/references.js'
import { createDelegatedAgentHarness, delegatedTerminalOutcome } from '../../../../../packages/core/src/agent/subagent/runner.js'
import { searcherPreset } from '../../../../../packages/core/src/agent/subagent/searcher/context.js'
import { createSubagentServiceTools } from '../../../../../packages/core/src/agent/tools/subagent.js'
import { connectProviderHarness } from '../../../../../packages/core/src/agent/providers/runtime.js'
import { createSqliteAgentRunLeasePort } from '../../../../../packages/core/src/agent/run/sqlite-store.js'
import { createSqliteAgentRunCoordination } from '../../../../../packages/core/src/agent/run/sqlite-coordination.js'
import type { CanonicalContextPorts } from '../../../../../packages/core/src/agent/ports.js'
import { createSubagentDeliveryStore } from '../../../../../packages/core/src/agent/subagent/delivery-store.js'
import { createSqliteAgentRunStore } from '../../../../../packages/core/src/agent/run/sqlite-store.js'
import { cleanupSqliteAgentRunRetention, compactSqliteAgentRunStorage } from '../../../../../packages/core/src/agent/run/sqlite-retention.js'
import { createAgentRagContextBuilder } from '../../../../../packages/core/src/agent/rag/context-builder.js'
import {
  createCalendarRagSource, createCanvasRagSource, createConversationRagSource, createMemoryRagSource,
  createKnowledgeRagSource, createNoteRagSource, createProjectRagSource, createScheduledTaskRagSource,
  createSqlMemoryScopeStateReader, createSqlRagRebuildWorker, enqueueMissingAgentRagBaselines,
  enqueueAgentRagRebuildInTransaction,
} from '../../../../../packages/core/src/agent/rag/index.js'
import { createSqlMindNoteReader } from '../../../../../packages/core/src/mind/note-read.js'
import { createKyselyScheduledTaskRagReader } from '../../../../../packages/core/src/scheduled-tasks/task-list.js'
import { settleCancelledSqliteSubagentWait, settleClosedSqliteInteraction, settleExclusiveSqliteAgentRuns } from '../../../../../packages/core/src/agent/run/sqlite-recovery.js'
import { loadSqliteAgentRunSecret } from '../../../../../packages/core/src/agent/run/sqlite-secret.js'
import { openLocalFile } from '@gugu/fs/node'
import { canonicalAgentToolName, filterConfiguredAgentTools } from '../../../../../packages/core/src/agent/index.js'
import { createViewImageTool, withViewImageReferences } from '../../../../../packages/core/src/agent/tools/view-image.js'
import type { DesktopAgentRuntimeModule } from '../../../../../packages/core/src/runtime/desktop-agent-port.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
const reflectionModelIdentity = (config: ProviderConfig) =>
  digest([config.provider, config.api_format, config.base_url, config.model])
const unavailable = async (): Promise<never> => { throw new CoreError('conflict', '当前运行未配置该能力') }

/** Agent Run 保留期维护：启动后先跑一次，之后每 6 小时再回收一次。 */
const AGENT_RUN_RETENTION_FIRST_DELAY_MS = 30_000
const AGENT_RUN_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000

function desktopGroupMemoryContext(value: unknown, ownerId: string): (ImMemoryReadAuthorization & { actor: ImActor; ownerPlatformUserId: string | null }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>, actorValue = row.actor
  if (!actorValue || typeof actorValue !== 'object' || Array.isArray(actorValue)) return null
  const actor = actorValue as Record<string, unknown>
  if (actor.ownerId !== ownerId || !['feishu', 'qq', 'telegram'].includes(String(actor.platform)) || typeof actor.botId !== 'string'
    || !/^[A-Za-z0-9._:-]{1,256}$/u.test(actor.botId) || actor.chatType !== 'group' || typeof actor.chatId !== 'string' || !actor.chatId
    || typeof actor.platformUserId !== 'string' || !actor.platformUserId
    || !['owner', 'member', 'unknown'].includes(String(actor.role))
    || !Array.isArray(actor.allowedToolNames) && actor.allowedToolNames !== null
    || Array.isArray(actor.allowedToolNames) && actor.allowedToolNames.some(name => typeof name !== 'string')
    || actor.speakerRoles !== null && (!Array.isArray(actor.speakerRoles) || actor.speakerRoles.some(item => !item || typeof item !== 'object'
      || typeof (item as Record<string, unknown>).platformUserId !== 'string'
      || !['owner', 'member', 'unknown'].includes(String((item as Record<string, unknown>).role))))
    || typeof actor.verifiedOwner !== 'boolean' || typeof actor.ownerMentionAuthorized !== 'boolean'
    || typeof row.groupMemoryEnabled !== 'boolean' || typeof row.memberMemoryEnabled !== 'boolean'
    || typeof row.groupOwnerMemoryEnabled !== 'boolean') return null
  return { ownerId, botId: actor.botId, platform: actor.platform as ImActor['platform'], chatType: 'group', chatId: actor.chatId,
    platformUserId: actor.platformUserId, groupMemoryEnabled: row.groupMemoryEnabled, memberMemoryEnabled: row.memberMemoryEnabled,
    groupOwnerMemoryEnabled: row.groupOwnerMemoryEnabled,
    ownerPlatformUserId: typeof row.ownerPlatformUserId === 'string' && row.ownerPlatformUserId ? row.ownerPlatformUserId : null,
    actor: actor as unknown as ImActor }
}

type DesktopMailAccount = { id: string; email: string; version: string }
function desktopMailAccounts(value: unknown): DesktopMailAccount[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.id === 'string' && typeof item.email === 'string' && typeof item.version === 'string'
    && /^[a-f0-9]{64}$/u.test(item.version) ? [{ id: item.id, email: item.email, version: item.version }] : [])
}
function maskEmailAddress(value: string): string {
  const at = value.indexOf('@')
  if (at < 1) return '***'
  const local = [...value.slice(0, at)]
  return `${local[0]}${local.length > 2 ? '*'.repeat(Math.min(12, local.length - 2)) + local.at(-1) : '*'}${value.slice(at)}`
}

export { CoreError as DesktopAgentCoreError }

import { createDesktopScheduledAgent } from '../schedules/agent.js'
import { createDesktopScheduledImContext } from '../schedules/context.js'

export function createDesktopAgentRuns(core: SqlDataRuntime, databasePath: string, ownerId: string,
  notify: (sessionId: number, runId: string, interactionChanged?: true) => void,
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
  memoryFiles?: DesktopMemoryFiles, observation?: AgentObservationPort,
  promptDirectory = fileURLToPath(new URL('../agent-prompts/', import.meta.url))) {
  const { db } = core
  const preferenceFiles = createLocalPreferenceTextFiles(dirname(databasePath))
  const agentWorkspaces = createAgentWorkspaceQueries(createDesktopWorkspaceReadPort(hostRequest))
  let disabledAgentTools: Promise<ReadonlySet<string>> | undefined
  async function configuredAgentTools(names: readonly string[], signal?: AbortSignal) {
    disabledAgentTools ??= hostRequest('agent.tools.policy', {}).then(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !('disabledTools' in value) || !Array.isArray(value.disabledTools)
        || value.disabledTools.some(name => typeof name !== 'string' || !name.trim()))
        throw new CoreError('storage_error', '桌面 Agent 工具策略无效')
      return new Set(value.disabledTools as string[])
    })
    const disabled = await disabledAgentTools
    signal?.throwIfAborted()
    return filterConfiguredAgentTools(names).filter(name => !disabled.has(name))
  }
  const undoStateMachine = createUndoStateMachine(createRuntimeUndoTransactionPort(core), async () => {}, undefined,
    { calendar: createCalendarUndoAdapter('sqlite'), projects: createDesktopProjectUndoAdapter() })
  const admission = createSqliteAgentAdmission(db)
  async function authorizeSearchRecovery(identity: RunIdentity) {
    const session = Number(identity.sessionId)
    if (identity.ownerId !== ownerId || !Number.isSafeInteger(session) || session <= 0) return false
    return (await admission.active(ownerId, session))?.identity?.runId === identity.runId
  }
  async function resolveOwnedAttachment(identity: RunIdentity, attachId: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!/^[0-9a-f]{32}$/u.test(attachId) || !await authorizeSearchRecovery(identity)) return null
    const session = Number(identity.sessionId)
    if (!Number.isSafeInteger(session) || session <= 0) return null
    const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
    const { rows } = await sql<{ attach_id: string; name: string; ext: string; kind: string; size: number; storage_key: string }>`
      SELECT a.attach_id,a.name,a.ext,a.kind,a.size,a.storage_key
      FROM chat_attachments a
      JOIN agent_run_admissions r ON r.user_id=a.user_id AND r.user_message_id=a.message_id
        AND r.session_id=${session} AND r.run_id=${identity.runId}
      WHERE a.user_id=${owner} AND a.attach_id=${attachId} AND a.state='attached'
      LIMIT 1`.execute(db)
    signal.throwIfAborted()
    const attachment = rows[0]
    if (!attachment || attachment.storage_key !== `agent-attachments/${attachId}`
      || !Number.isSafeInteger(Number(attachment.size)) || Number(attachment.size) < 0
      || !await authorizeSearchRecovery(identity)) return null
    return {
      attach_id: attachment.attach_id,
      name: `${attachment.name}${attachment.ext ? `.${attachment.ext}` : ''}`,
      kind: attachment.kind,
      extension: attachment.ext,
      size_bytes: Number(attachment.size),
      root: join(dirname(databasePath), 'agent-attachments'),
      relativePath: attachId,
    }
  }

  function paidSearchTools(recoverySignal?: AbortSignal) {
    function paidSearchOperation(identity: RunIdentity, roundId: string, callId: string) {
      const hex = digest([identity.ownerId, identity.sessionId, identity.runId, roundId, callId])
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    }
    async function remotePaidSearch(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const result = desktopDeepResearchResult.safeParse(await hostRequest(method, params, signal))
      return result.success ? result.data : { kind: 'unknown' as const }
    }
    function researchParams(input: { query: string; maxResults?: number; depth: string }) {
      return { query: input.query, ...(input.maxResults === undefined ? {} : { max_results: input.maxResults }), depth: input.depth }
    }
    function imageParams(input: { attachmentId: string; url: string; maxResults?: number }) {
      return {
        ...(input.attachmentId ? { attach_id: input.attachmentId } : { image_url: input.url }),
        ...(input.maxResults === undefined ? {} : { max_results: input.maxResults }),
      }
    }
    const deepResearch = createDeepResearchTool({
      search(input, scope, call) {
        return remotePaidSearch('agent.search.deep_research', {
          operation_id: paidSearchOperation(scope.identity, scope.roundId, call.id), ...researchParams(input),
        }, scope.signal)
      },
      reconcile(input, identity, call) {
        return remotePaidSearch('agent.search.deep_research', {
          operation_id: paidSearchOperation(identity, identity.roundId, call.id), ...researchParams(input), reconcile_only: true,
        }, recoverySignal ?? AbortSignal.timeout(5_000))
      },
    })
    const similarImageSearch = createSimilarImageSearchTool({
      async search(input, scope, call) {
        if (input.attachmentId) {
          const image = await resolveOwnedAttachment(scope.identity, input.attachmentId, scope.signal)
          if (image?.kind !== 'image' || !['png', 'jpeg', 'jpg'].includes(image.extension.toLowerCase()))
            return { kind: 'completed', successful: false, mutated: false, value: { error: '当前消息没有可用的 JPG 或 PNG 附件' } }
        }
        return remotePaidSearch('agent.search.similar_image_search', {
          operation_id: paidSearchOperation(scope.identity, scope.roundId, call.id), ...imageParams(input),
        }, scope.signal)
      },
      async reconcile(input, identity, call) {
        const signal = recoverySignal ?? AbortSignal.timeout(5_000)
        let image: Record<string, unknown> = imageParams(input)
        if (input.attachmentId) {
          const file = await resolveOwnedAttachment(identity, input.attachmentId, signal)
          if (!file || file.kind !== 'image' || file.size_bytes > MAX_DESKTOP_SEARCH_IMAGE_BYTES) return { kind: 'unknown' }
          const opened = await openLocalFile(file.root, file.relativePath)
          if (!opened) return { kind: 'unknown' }
          try {
            if (opened.size !== file.size_bytes) return { kind: 'unknown' }
            const bytes = Buffer.alloc(file.size_bytes)
            const { bytesRead } = await opened.handle.read(bytes, 0, bytes.length, 0)
            signal.throwIfAborted()
            if (bytesRead !== bytes.length) return { kind: 'unknown' }
            image = { image_digest: createHash('sha256').update(bytes).digest('hex'),
              ...(input.maxResults === undefined ? {} : { max_results: input.maxResults }) }
          } finally { await opened.handle.close() }
        }
        return remotePaidSearch('agent.search.similar_image_search', {
          operation_id: paidSearchOperation(identity, identity.roundId, call.id), ...image, reconcile_only: true,
        }, signal)
      },
    })
    return { deepResearch, similarImageSearch }
  }
  const readConversation = createSqlAgentConversationTextReader(db, 'sqlite')
  const knowledgeStore = createLocalAgentKnowledgeReadStore(dirname(databasePath))
  const readKnowledgeOverview = createAgentKnowledgeOverview(knowledgeStore)
  const running = new Map<number, { runId: string; cancel(): Promise<unknown>; done: Promise<void> }>()
  const runTasks = new Set<Promise<void>>()
  const subagentWakes = new Map<string, Promise<void>>()
  const subagentWakeAbort = new AbortController()
  let childScan: Promise<void> | undefined
  let childScanRequested = false
  const interactionExpirations = new Map<string, ReturnType<typeof setTimeout>>()

  function scheduleAdmittedRuns(secret: string) {
    const signal = subagentWakeAbort.signal
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

  const responding = new Set<number>()
  const reflectionAbort = new AbortController()
  let reflectionRecovery: Promise<void> | undefined
  let reflectionTimer: ReturnType<typeof setTimeout> | undefined
  let reflectionTimerDue = Infinity
  let reflectionRecoveryRequested = false
  let builtinSkills: Promise<BuiltinSkillDefinition[]> | undefined
  let embeddingGeneration = 0
  let memoryEmbedding: {
    settings: RagQueryEmbeddingSettings
    resolveProxy: NodeProviderTransportOptions['resolveProxy']
    controller: AbortController
  } | undefined
  const memorySource = createMemoryRagSource({
    storage: createSqliteAgentMemoryRagStorage(db, memoryFiles),
    scopeState: { getMemoryScopeState: createSqlMemoryScopeStateReader(db) },
    scopes: async () => [],
  })
  let memoryWarmup: Promise<void> | undefined
  const ragSources = {
    project: createProjectRagSource(core),
    calendar: createCalendarRagSource(createKyselyCalendarReadPort(db, 'sqlite')),
    note: createNoteRagSource(createSqlMindNoteReader(db, 'sqlite')),
    scheduled_task: createScheduledTaskRagSource(createKyselyScheduledTaskRagReader(db, 'sqlite')),
    conversation: createConversationRagSource(db, 'sqlite'),
    canvas: createCanvasRagSource(createSqlMindCanvasReader(db, 'sqlite')),
    memory: async (...args: Parameters<typeof memorySource>) => {
      const documents = await memorySource(...args)
      const [owner, , signal] = args
      const config = memoryEmbedding
      if (config && signal && owner === ownerId && memoryFiles && !signal.aborted) {
        const warmupSignal = AbortSignal.any([signal, config.controller.signal])
        memoryWarmup = (memoryWarmup ?? Promise.resolve()).then(async () => {
          if (warmupSignal.aborted) return
          const vectors = await createSqliteAgentMemoryRagVectors(db, owner, config.settings, memoryFiles, config.resolveProxy)
          try { await vectors.warmDocuments(documents, warmupSignal) }
          finally { await vectors.close() }
        }).catch(() => {})
      }
      return documents
    },
    knowledge: createKnowledgeRagSource(knowledgeStore),
  }
  const rebuildRag = createSqlRagRebuildWorker(db, 'sqlite', ragSources)
  let ragWorkerStopped = false
  let ragBaselineEnqueued = false
  let lastMemoryRevision: string | number | undefined
  let pendingMemoryRebuild: { revision: string | number; generation: number } | undefined
  let ragWorkerTimer: ReturnType<typeof setTimeout> | undefined
  let ragWorkerResolveWait: (() => void) | undefined
  let ragWorkerTask: Promise<void> | undefined

  async function runRagWorker(signal: AbortSignal): Promise<void> {
    while (!ragWorkerStopped && !signal.aborted) {
      try {
        if (!ragBaselineEnqueued) {
          await enqueueMissingAgentRagBaselines(db, 'sqlite', Object.keys(ragSources))
          ragBaselineEnqueued = true
        }
        const pending = pendingMemoryRebuild
        if (pending) {
          await db.transaction().execute(async tx => {
            if (pending.generation === embeddingGeneration)
              await enqueueAgentRagRebuildInTransaction(tx, 'sqlite', ownerId, 'memory')
          })
          if (pending.generation === embeddingGeneration) lastMemoryRevision = pending.revision
          if (pendingMemoryRebuild === pending) pendingMemoryRebuild = undefined
        }
        const result = await rebuildRag(signal)
        if (result === 'ready' || result === 'superseded') continue
      } catch {
        if (signal.aborted) break
      }
      if (ragWorkerStopped || signal.aborted) break
      await new Promise<void>(resolve => {
        const finishWait = () => {
          ragWorkerResolveWait = undefined
          resolve()
        }
        ragWorkerResolveWait = finishWait
        ragWorkerTimer = setTimeout(finishWait, 1_000)
        ragWorkerTimer.unref?.()
      })
      ragWorkerTimer = undefined
    }
  }

  const ragWorkerAbort = new AbortController()
  ragWorkerTask = runRagWorker(ragWorkerAbort.signal)

  // Agent Run 的事件与检查点从建表起没有任何删除路径，桌面端按保留期回收并压缩磁盘。
  const retentionAbort = new AbortController()
  let retentionTimer: ReturnType<typeof setTimeout> | undefined
  async function runRetentionMaintenance(): Promise<void> {
    if (retentionAbort.signal.aborted) return
    try {
      const cleaned = await cleanupSqliteAgentRunRetention(db)
      if (cleaned.freedBytes > 0) await compactSqliteAgentRunStorage(db)
    } catch {
      /* 保留期清理失败只影响磁盘占用，不能影响运行正确性。 */
    }
  }
  function scheduleRetentionMaintenance(delay: number): void {
    if (retentionAbort.signal.aborted) return
    if (retentionTimer) clearTimeout(retentionTimer)
    retentionTimer = setTimeout(() => {
      retentionTimer = undefined
      void runRetentionMaintenance().finally(() => scheduleRetentionMaintenance(AGENT_RUN_RETENTION_INTERVAL_MS))
    }, delay)
    retentionTimer.unref?.()
  }
  scheduleRetentionMaintenance(AGENT_RUN_RETENTION_FIRST_DELAY_MS)

  const scheduledImContext = createDesktopScheduledImContext({ db, ownerId, memoryFiles, hostRequest })
  const currentScheduledIm = scheduledImContext.authorizeIm

  let subagents: ReturnType<typeof createSubagentService> | undefined

  async function resolveReferencedFile(id: string, signal?: AbortSignal) {
    const method = workspaceFileReferenceId.test(id) ? 'agent.files.resolveWorkspaceReference' : 'agent.files.resolveDroppedReference'
    const result = await hostRequest(method, { id }, signal)
    if (result === null) return null
    if (!result || typeof result !== 'object' || !('path' in result) || typeof result.path !== 'string'
      || !('fileIdentity' in result) || typeof result.fileIdentity !== 'string')
      throw new CoreError('storage_error', '本机文件引用结果无效')
    return { path: result.path, fileIdentity: result.fileIdentity,
      relativePath: 'relativePath' in result && typeof result.relativePath === 'string' ? result.relativePath : undefined }
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

  async function readDesktopShellPreferences() {
    const local = readPreferenceDocument(await createKyselyPreferenceDocumentStore(db, 'sqlite').read(ownerId))
    return {
      automaticMode: local.automatic_mode_enabled === true,
      shellEnabled: (local.shell_enabled ?? true) === true,
      dangerousEnabled: (local.shell_dangerous_enabled ?? true) === true,
    }
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
        } : undefined, parent) : undefined
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
      runtime: { store, leases, cancellation: {
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
          if (event.type === 'interaction_required' || event.type === 'interaction_resolved')
            notify(Number(parent.sessionId), parent.runId, true)
        }, diagnose() {} },
    })
    return { harness, async close() { await connected.provider.close() } }
  }

  async function dispatchAdmittedChild(secret: string, identity: RunIdentity) {
    const sessionId = Number(identity.sessionId)
    if (subagentWakeAbort.signal.aborted || running.has(sessionId)) return
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
        if (error instanceof AgentRunError && ['conflict', 'lease_lost', 'persistence_unknown'].includes(error.code)) return
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
      if (subagentWakeAbort.signal.aborted && (await store.read(identity))?.status === 'waiting') return
      await cancellation.request(identity)
      await cancellation.notify(identity)
    } })
    runTasks.add(done)
    void done.catch(() => {})
  }

  async function prepareRunRuntime(sessionId: number | null, config: ProviderConfig | null, embedding?: RagQueryEmbeddingSettings, interactive = false, resumeIdentity?: RunIdentity, modelId?: string, locale = 'zh-CN') {
    const imSession = sessionId === null ? null : (await sql<{ chat_type: string | null; platform: string }>`
      SELECT s.chat_type,im.platform FROM conversation_sessions s JOIN desktop_im_sessions im
        ON im.session_id=s.id AND im.owner_id=s.user_id
      WHERE s.id=${sessionId} AND s.user_id=${dataContext(ownerId).ownerId.replaceAll('-', '')}
    `.execute(db)).rows[0]
    const imChatType = imSession?.chat_type
    const singleChoiceOnly = Boolean(imSession)
    const groupChat = imChatType === 'group'
    if (groupChat) interactive = false
    const embeddingGenerationAtStart = embeddingGeneration
    // 当前运行身份必须按 RunRuntime 隔离；多个会话可以并行执行。
    let boundIdentity = resumeIdentity
    let overviewData: SqliteAgentOverviewData | undefined
    let ownerMemory: Awaited<ReturnType<typeof readSqliteAgentMemory>>['memory'] | undefined
    let stylePreferences: Record<string, Json> = {}
    let filesOverview: Record<string, Json> = {}
    let imChannels: Record<string, boolean> | undefined
    let memoryRevision: string | number = 0
    let contextRevision = 0
    if (config) {
      const endpoint = URL.parse(String(config.base_url ?? ''))
      if (!endpoint) throw new CoreError('invalid_request', '模型地址无效')
      const local = (config.provider === 'local' || config.provider === 'ollama')
        && (endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]')
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')))
        throw new CoreError('invalid_request', '模型地址无效')
    }
    let workspaceBinding: Record<string, Json> | null = null
    if (sessionId !== null && !groupChat) {
      const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
      const { rows: [session] } = await sql<{ session_context: string | null }>`SELECT session_context FROM conversation_sessions
        WHERE user_id=${owner} AND id=${sessionId} AND (source IS NULL OR source='web')`.execute(db)
      const context = readAgentSessionContext(session?.session_context, 'sqlite')
      const stored = context.workspace_binding
      const directoryId = stored && typeof stored === 'object' && !Array.isArray(stored)
        ? (stored as Record<string, unknown>).directory_id : undefined
      if (typeof directoryId === 'string') {
        const workspace = await agentWorkspaces.get(ownerId, directoryId)
        if (workspace) workspaceBinding = {
          workspace_id: workspace.workspace_id, workspace_name: workspace.name, kind: workspace.kind, space: 'workspace',
          project_id: null, folder_id: null, directory_id: workspace.directory_id!, directory_name: workspace.directory_name!,
        }
      }
    }
    const selection = {
      modelIdentity: config ? reflectionModelIdentity(config) : '',
      contextWindow: typeof config?.context_tokens === 'number' ? config.context_tokens : DEFAULT_LLM_CONTEXT_TOKENS,
      locale, groupChat, workspaceBinding,
      contextPolicy: { loadOwnerContext: !groupChat, memoryEnabled: !groupChat },
      // 业务内容版本由 currentRevision 返回，访问范围只绑定可信身份和上下文策略。
      contextScopeKey: groupChat ? 'desktop-im-group' : 'desktop-overview',
    }
    if (config && !groupChat) await memoryFiles?.flush()
    const builtins = await (builtinSkills ??= createBuiltinSkillDefinitions(createBundledSkillDocuments(), new AbortController().signal))
    const preferences = await createDesktopAppearanceService(createKyselyPreferenceDocumentStore(db, 'sqlite')).get(ownerId)
    let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const agentClock = { now: () => new Date(), timezone: async () => timezone }
    const prompts = readAgentPromptSet(promptDirectory)
    const smartView = imSession ? undefined : readAgentPrompt('smart_view.md', promptDirectory)
    const buildSystemPrompt = (preferences: Record<string, Json>) => buildAgentStaticPrompt({
      ...prompts, smartView, skillIndex: formatBuiltinSkillIndex(builtins), imChat: Boolean(imSession),
      locale: selection.locale, timezone, now: new Date(), groupChat,
      ...agentPromptPreferenceFields(preferences),
    })
    let systemPrompt = buildSystemPrompt(stylePreferences)
    const request = (snapshot: string, prompt = systemPrompt) => ({
      systemPrompt: prompt, systemInMessages: false, fixedPrefix: snapshot ? agentContextSnapshotPrefix(snapshot) : [],
    })
    let snapshotContext = ''
    async function readDesktopImMemory(identity: RunIdentity, signal?: AbortSignal): Promise<{ actor: ImActor | null; data: Json; groupOwnerMemoryEnabled: boolean }> {
      if (!groupChat || !memoryFiles) return { actor: null, data: {}, groupOwnerMemoryEnabled: false }
      signal?.throwIfAborted()
      const receipt = await desktopImGroupRunEvent(db, identity)
      if (!receipt) return { actor: null, data: {}, groupOwnerMemoryEnabled: false }
      const resolve = async () => desktopGroupMemoryContext(await hostRequest('agent.im.readGroupMemoryContext', { ...receipt, ownerId }, signal), ownerId)
      const initial = await resolve()
      if (!initial) return { actor: null, data: {}, groupOwnerMemoryEnabled: false }
      const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
      const source = createImMemoryContextSource({
        identity, actor: initial.actor,
        async authorize() {
          const current = await resolve()
          if (!current || current.botId !== initial.botId || current.chatId !== initial.chatId
            || current.platformUserId !== initial.platformUserId || current.actor.role !== initial.actor.role
            || current.actor.verifiedOwner !== initial.actor.verifiedOwner) return null
          return current
        },
        readText: (scope, filename) => memoryFiles.readImScope(scope, filename),
        async isTombstoned(scope) {
          const { rows } = await sql`SELECT 1 AS id FROM desktop_im_memory_tombstones
            WHERE owner_id=${owner} AND platform=${scope.platform} AND bot_id=${scope.bot_id}
              AND scope_type=${scope.scope_type} AND scope_id=${scope.scope_id} LIMIT 1`.execute(db)
          return rows.length > 0
        },
      })
      const data = await source.loadImMemory(identity, signal)
      return { actor: initial.actor, data, groupOwnerMemoryEnabled: initial.groupOwnerMemoryEnabled }
    }
    async function readMemberReminder(identity: RunIdentity, signal?: AbortSignal) {
      const memory = await readDesktopImMemory(identity, signal)
      const personal = memory.actor?.role === 'member' ? formatPlatformUserMemory(memory.data) : ''
      return personal ? [{ role: 'user' as const, content: `[system-reminder]\n${personal}\n[/system-reminder]` }] : []
    }
    const resolveProxy: NodeProviderTransportOptions['resolveProxy'] = preferences.useSystemProxy
      ? async (url, signal) => (await hostRequest('network.resolveProxy', { origin: url.origin }, signal) as ProxyEndpoint | null) ?? undefined
      : undefined
    const egress = {
      async withTransport<T>(signal: AbortSignal, execute: (transport: ProviderTransport) => Promise<T>): Promise<T> {
        signal.throwIfAborted()
        const transport = createNodeProviderTransport({ ...desktopTransportOptions(false, resolveProxy),
          connectTimeoutMs: 10_000, writeTimeoutMs: 10_000 })
        try { return await execute(transport) }
        finally { await transport.close() }
      },
    }
    const httpGet = createAgentHttpGetPort(egress)
    const webSearch = config ? createWebSearchTool(config, { ...egress, digest }) : undefined
    const [researchAvailable, imageSearchAvailable] = await Promise.all([
      hostRequest('agent.search.deep_research.available', {}),
      hostRequest('agent.search.similar_image_search.available', {}),
    ])
    const { deepResearch, similarImageSearch } = paidSearchTools()
    const authorize = async (identity: RunIdentity) => {
      if (sessionId === null || identity.ownerId !== ownerId || identity.sessionId !== String(sessionId)) return false
      const active = await admission.active(ownerId, sessionId)
      return active?.identity?.runId === identity.runId
    }
    const undoPort = (identity: RunIdentity) => createAgentUndoLastActionPort({
      core, identity, undoContextId: `agent:${identity.sessionId}:${identity.runId}`.slice(0, 128),
      async active(input, signal) {
        signal.throwIfAborted()
        return authorize(input.identity)
      },
      async apply(owner, contextId, operationId, resource) {
        if (!['mind', 'calendar', 'projects'].includes(resource))
          return { success: false, error: '最近操作类型尚未接入桌面撤销处理器' }
        try {
          const outcome = await undoStateMachine.apply(owner, contextId, operationId, 'undo')
          return { success: true, operation: outcome.operation, idempotent: outcome.idempotent }
        } catch (error) {
          const code = error instanceof UndoError ? error.statusCode : 0
          if (code === 404) return { success: false, error: '没有可撤销的操作' }
          if (code === 409) return { success: false, error: '最近的操作已变化，无法撤销' }
          throw error
        }
      },
    })
    const undoLastAction = core.receipts && interactive ? createUndoLastActionTool({
      apply: input => undoPort(input.identity).apply(input),
      reconcile: input => undoPort(input.identity).reconcile(input),
    }) : undefined
    const authorizeContext = async (identity: { ownerId: string; sessionId: string }) => {
      const active = boundIdentity
      return !!active && identity.ownerId === active.ownerId && identity.sessionId === active.sessionId && await authorize(active)
    }
    const knowledge = createOwnerAgentKnowledgeReadPort(core, knowledgeStore, {
      timezone: async () => timezone,
      authorize: identity => authorize(identity),
    })
    const fileSources = {
      resolveOwnedAttachment,
      async resolveFilePath(identity: RunIdentity, path: string, signal: AbortSignal) {
        signal.throwIfAborted()
        if (!await authorize(identity)) return null
        const value = await hostRequest('agent.files.resolve', { path }, signal)
        signal.throwIfAborted()
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null
        const file = value as Record<string, unknown>
        if (typeof file.root !== 'string' || !file.root || typeof file.relativePath !== 'string' || !file.relativePath
          || typeof file.name !== 'string' || typeof file.text !== 'boolean' || typeof file.extensionless !== 'boolean'
          || (file.extension !== undefined && typeof file.extension !== 'string')) return null
        return {
          name: file.name, root: file.root, relativePath: file.relativePath,
          text: file.text, extensionless: file.extensionless,
          ...(typeof file.extension === 'string' ? { extension: file.extension } : {}),
        }
      },
    }
    const viewImage = createViewImageTool({
      requiresHostConfirmation: true,
      authorize: async (identity, signal) => { signal.throwIfAborted(); return authorize(identity) },
      supportsImage: async (_identity, signal) => {
        signal.throwIfAborted()
        return config !== null && (config.capability_overrides?.image ?? config.image ?? adapterFor(config).capabilities(config).image) === true
      },
      async openAttachment(identity, attachId, signal) {
        const file = await fileSources.resolveOwnedAttachment(identity, attachId, signal)
        if (file?.kind !== 'image') return null
        const opened = await openLocalFile(file.root, file.relativePath)
        if (!opened || opened.size === file.size_bytes) return opened
        await opened.handle.close()
        return null
      },
      async openPath(identity, path, signal, scope, call) {
        if (isAbsolute(path)) {
          if (!await authorize(identity)) return null
          const slot = /^\/references\/([1-6])$/u.exec(path)
          const { references } = await readDesktopTurnReferences(db, identity)
          // 已有历史仍可使用旧引用槽位，新提示使用宿主解析出的真实绝对路径。
          const candidates = slot ? [references[Number(slot[1]) - 1]] : references.slice(0, 6)
          for (const ref of candidates) {
            if (ref?.type !== 'file' || typeof ref.id !== 'string' || (!droppedFileReferenceId.test(ref.id) && !workspaceFileReferenceId.test(ref.id))) continue
            const file = await resolveReferencedFile(ref.id, signal)
            if (!scope.resolution && file && (slot || file.path === path)) return openDroppedFile(file.path, file.fileIdentity, signal)
          }
          if (path.startsWith('/references/')) return null
          if (isHostFilePath(path)) {
            const result = await authorizeHostFile(path, { path }, scope, call, viewImageConfirmation)
            if (!('target' in result)) return result
            return openDroppedFile(result.target.path, result.target.identity, signal)
          }
        }
        if (scope.resolution) return { error: '图片目标或授权已变化，请重新发起操作' }
        const file = await fileSources.resolveFilePath(identity, path, signal)
        return file ? openLocalFile(file.root, file.relativePath) : null
      },
      open: (url, signal) => egress.withTransport(signal, transport => transport.request({ url, method: 'GET', headers: {} }, signal)),
    })
    let runMemoryRebuild: typeof pendingMemoryRebuild
    let ragBinding: { runId: string; build: ReturnType<typeof createAgentRagContextBuilder> } | undefined
    const buildRag = async (input: Parameters<ReturnType<typeof createAgentRagContextBuilder>>[0], signal?: AbortSignal) => {
      const identity = boundIdentity
      if (!identity || identity.ownerId !== input.ownerId || identity.sessionId !== input.sessionId)
        return { tail: [], injected: false, reason: 'identity_unavailable' }
      if (ragBinding?.runId !== identity.runId) {
        ragBinding = {
          runId: identity.runId,
          build: createAgentRagContextBuilder({
            core, identity,
              enabled: async (candidate, ragSignal) => {
                if (candidate.runId !== identity.runId || !await authorize(candidate)) return false
                if (selection.contextPolicy.loadOwnerContext) return true
                if (!groupChat) return false
                const current = await readDesktopImMemory(candidate, ragSignal)
                return current.actor !== null && imCanUseGroupOwnerMemory(current.actor, current.groupOwnerMemoryEnabled)
              },
              ...(embedding ? { vectors: owner => createSqliteAgentMemoryRagVectors(db, owner, embedding, memoryFiles, resolveProxy) } : {}),
            authorize: async (candidate, scope, authSignal) => {
              authSignal?.throwIfAborted()
              if (candidate.ownerId !== identity.ownerId || candidate.sessionId !== identity.sessionId
                || candidate.runId !== identity.runId || scope.scope_type !== 'owner' || (scope.scope_id ?? '') !== '') return false
              const allowed = await authorize(candidate)
              authSignal?.throwIfAborted()
              if (!allowed) return false
              if (selection.contextPolicy.loadOwnerContext) return true
              if (!groupChat) return false
              const current = await readDesktopImMemory(candidate, authSignal)
              return current.actor !== null && imCanUseGroupOwnerMemory(current.actor, current.groupOwnerMemoryEnabled)
            },
          }),
        }
      }
      try {
        return await ragBinding.build(input, signal)
      } finally {
        // 当前轮召回结束后再让后台登记持久化任务，避免与首轮读取争用 SQLite。
        if (runMemoryRebuild?.generation === embeddingGeneration) pendingMemoryRebuild = runMemoryRebuild
        runMemoryRebuild = undefined
      }
    }
    const scheduledTasks = createScheduledTaskQueries(createKyselyScheduledTaskReader(db, 'sqlite'),
      () => ({ workspaceSupported: false, filesystemAuthorizationEnabled: false }))
    const secret = await loadSqliteAgentRunSecret(db, databasePath)
    const continuation = createDesktopContinuationStore(db, secret)
    const checkpoint = resumeIdentity ? await createSqliteAgentRunStore<CanonicalRunContext>(db, secret, {
      writeHistory: unavailable,
    }).read(resumeIdentity) : null
    if (resumeIdentity && (!checkpoint?.context || checkpoint.context.modelIdentity !== selection.modelIdentity))
      throw new CoreError('conflict', '模型配置已变更，无法恢复原运行')
    if (checkpoint?.context?.replyContext?.locale) selection.locale = checkpoint.context.replyContext.locale
    if (checkpoint) systemPrompt = buildSystemPrompt(stylePreferences)
    const agentLog = createAgentLog({
      regular: line => { void hostRequest('agent.log.append', { line, diagnostic: false }).catch(() => {}) },
      diagnostic: line => { void hostRequest('agent.log.append', { line, diagnostic: true }).catch(() => {}) },
      fingerprint: value => createHmac('sha256', secret).update(value).digest('hex'),
    })
    const skillMetadata = createSkillMetadataReader(db, 'sqlite', builtins)
    const skills = await createAgentSkillRuntimePorts({
      ownerId, builtins, listUser: skillMetadata,
      readUser: createUserSkillReader(db, 'sqlite'),
      fingerprint: owner => createHmac('sha256', secret).update(owner).digest('hex'),
    })
    const resolveDesktopFileReference = async (_owner: string, id: string, signal?: AbortSignal) => {
      const file = await resolveReferencedFile(id, signal)
      return file ? { label: basename(file.path), path: file.path } : null
    }
    const canvasEdits = core.receipts ? createCanvasEditPort(core, async () => {}, resolveDesktopFileReference) : undefined
    const calendarEvents = createKyselyCalendarAgentReadPort(db, 'sqlite')
    const calendarTargets: CalendarReminderTargetPort = {
      async resolve(identity, reminders, signal) {
        signal.throwIfAborted()
        if (!await authorize(identity)) return { ok: false, error: '日历提醒运行授权已失效' }
        if (reminders.some(reminder => reminder.delivery_mode === 'current_group'
          || reminder.channels?.some(channel => channel !== 'web')))
          return { ok: false, error: '桌面日历提醒仅支持本机通知' }
        return { ok: true, reminders: reminders.map(reminder => ({
          channels: ['web'], deliveryTargets: null, enabled: reminder.enabled !== false,
        })) }
      },
    }
    async function authorizeWrite(tx: Kysely<Database>, identity: RunIdentity, signal: AbortSignal) {
      signal.throwIfAborted()
      if (identity.ownerId !== ownerId || identity.sessionId !== String(sessionId)) return false
      const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
      const { rows } = await sql`SELECT 1 FROM conversation_sessions s JOIN agent_run_leases l
        ON l.user_id=s.user_id AND l.session_id=s.id AND l.run_id=s.active_run_id
        LEFT JOIN agent_run_controls c ON c.user_id=l.user_id AND c.session_id=l.session_id AND c.run_id=l.run_id
        WHERE s.user_id=${owner} AND s.id=${sessionId} AND l.run_id=${identity.runId}
          AND l.expires_at_ms>${Date.now()} AND COALESCE(c.cancel_requested,0)=0`.execute(tx)
      signal.throwIfAborted()
      return rows.length === 1
    }
    const confirmation = createSqliteToolConfirmation(db, authorizeWrite, 'delete_scheduled_task')
    const canvasConfirmations = {
      canvas_batch: createSqliteToolConfirmation(db, authorizeWrite, 'canvas_batch'),
      canvas_delete_note: createSqliteToolConfirmation(db, authorizeWrite, 'canvas_delete_note'),
      canvas_disconnect: createSqliteToolConfirmation(db, authorizeWrite, 'canvas_disconnect'),
      canvas_delete: createSqliteToolConfirmation(db, authorizeWrite, 'canvas_delete'),
    }
    const calendarConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'delete_event')
    const clientDeleteConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'delete_client')
    const skillDeleteConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'delete_skill')
    const knowledgeConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'delete_knowledge',
      async (_tx, identity, input, snapshot): Promise<string> => {
        const id = (input as { knowledge_id?: unknown } | null)?.knowledge_id
        const target = typeof id === 'string'
          ? await knowledgeDeletePort?.readTarget(identity, id.trim(), AbortSignal.timeout(5000)) : null
        if (!target?.snapshot.displaySummary || target.snapshot.targetsDigest !== snapshot.targetsDigest
          || target.snapshot.versionsDigest !== snapshot.versionsDigest)
          throw new CoreError('conflict', '知识条目已变化')
        return target.snapshot.displaySummary
      })
    const knowledgeDeletePort = core.receipts && interactive
      ? createLocalAgentKnowledgeDeletePort(core, dirname(databasePath), knowledgeStore, knowledgeConfirmation, publishDesktopKnowledgeFile)
      : undefined
    const shellConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'shell')
    const presentConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'present_file')
    const viewImageConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'view_image')
    const listMailAccounts = async (signal?: AbortSignal) => desktopMailAccounts(
      await hostRequest('agent.email.accounts', {}, signal))
    const resolveMailReferences = async (identity: RunIdentity, keys: readonly string[], signal?: AbortSignal) => {
      if (keys.length > 5 || new Set(keys).size !== keys.length) throw new CoreError('invalid_request', '邮件附件引用无效')
      const { references } = await readDesktopTurnReferences(db, identity)
      const available = new Map(references.flatMap(reference => reference?.type === 'file' && typeof reference.id === 'string'
        && (droppedFileReferenceId.test(reference.id) || workspaceFileReferenceId.test(reference.id))
        ? [[desktopFileReferenceKey(reference.id), reference.id] as const] : []))
      const ids = keys.map(key => available.get(key))
      if (ids.some(id => !id)) throw new CoreError('invalid_request', '邮件附件必须来自当前消息引用的本机文件')
      const resolvedIds = ids as string[]
      const result = await hostRequest('agent.email.attachments', { references: resolvedIds }, signal)
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new CoreError('storage_error', '本机邮件附件信息无效')
      const manifest = result as Record<string, unknown>
      if (typeof manifest.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.digest)
        || !Array.isArray(manifest.items) || manifest.items.length !== ids.length
        || manifest.items.some(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return true
          const row = item as Record<string, unknown>, size = row.size
          return typeof row.filename !== 'string' || typeof row.mimeType !== 'string'
            || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0
        }))
        throw new CoreError('storage_error', '本机邮件附件信息无效')
      return { ids: resolvedIds, digest: manifest.digest, items: manifest.items as { filename: string; mimeType: string; size: number }[] }
    }
    const emailConfirmation = core.receipts && interactive && !groupChat
      ? createSqliteToolConfirmation(db, authorizeWrite, 'send_email', async (tx, identity, rawInput, snapshot) => {
        if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput))
          throw new CoreError('invalid_request', '邮件发送参数无效')
        const input = rawInput as Record<string, unknown>
        const account = (await listMailAccounts(AbortSignal.timeout(5000)))
          .find(candidate => candidate.version === snapshot.versionsDigest)
        if (!account) throw new CoreError('conflict', '发件邮箱设置已变化，请重新发起并确认邮件')
        let recipient = typeof input.to === 'string' ? input.to.trim() : ''
        if (!recipient && typeof input.client_id === 'number' && Number.isSafeInteger(input.client_id)) {
          const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
          const { rows } = await sql<{ email: string | null }>`SELECT email FROM clients
            WHERE id=${input.client_id} AND user_id=${owner} LIMIT 1`.execute(tx)
          recipient = rows[0]?.email?.trim() ?? ''
        }
        recipient ||= account.email
        if (digest({ accountId: account.id, recipient }) !== snapshot.targetsDigest)
          throw new CoreError('conflict', '邮件收件人或发件邮箱已变化，请重新确认')
        const subject = typeof input.subject === 'string'
          ? [...input.subject.replace(/[\p{Cc}\p{Cf}]/gu, ' ')].slice(0, 160).join('') : ''
        const fileRefs = Array.isArray(input.file_refs) && input.file_refs.every(value => typeof value === 'string')
          ? input.file_refs as string[] : []
        const attachments = await resolveMailReferences(identity, fileRefs)
        if (digest({ accountId: account.id, recipient, attachments: attachments.digest }) !== snapshot.targetsDigest)
          throw new CoreError('conflict', '邮件附件或收件人已变化，请重新发起确认')
        const format = input.format === 'html' ? '自定义 HTML + 纯文本'
          : input.format === 'plain' ? '纯文本' : '咕咕标准 HTML + 纯文本'
        const summary = `使用桌面邮箱 ${maskEmailAddress(account.email)} 发送${format}邮件。\n收件人：${maskEmailAddress(recipient)}\n主题：${subject}`
        if (!attachments.items.length) return summary
        const size = attachments.items.reduce((sum, item) => sum + item.size, 0)
        return `${summary}\n附件 ${attachments.items.length} 个（${(size / 1024 / 1024).toFixed(1)}MB）：${attachments.items.map(item => item.filename).join('、')}`
      }) : undefined
    const emailDelivery = emailConfirmation ? createDurableAgentEmailDelivery(core, {
      claim: emailConfirmation.claim,
      async deliver(raw, signal) {
        const result = await hostRequest('agent.email.send', raw as Record<string, unknown>, signal)
        if (!result || typeof result !== 'object' || Array.isArray(result)
          || typeof (result as Record<string, unknown>).partial !== 'boolean') return { kind: 'unknown' }
        const partial = (result as { partial: boolean }).partial
        return { kind: 'completed', successful: !partial, mutated: true,
          value: { status: partial ? 'partial' : 'sent', message: partial ? '邮件已部分提交，请检查已发送邮件' : '邮件已提交给 SMTP' } }
      },
    }) : undefined
    const sendEmail = emailConfirmation && emailDelivery ? createSendEmailTool({
      confirmation: emailConfirmation.gate,
      async accountEmail(identity, signal) {
        if (!await authorize(identity)) return null
        return (await listMailAccounts(signal))[0]?.email ?? null
      },
      async clientEmail(identity, clientId, signal) {
        signal.throwIfAborted()
        if (!await authorize(identity)) return null
        const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
        const { rows } = await sql<{ email: string | null }>`SELECT email FROM clients
          WHERE id=${clientId} AND user_id=${owner} LIMIT 1`.execute(db)
        signal.throwIfAborted()
        return rows[0] ?? null
      },
      async prepare(operation, draft, signal) {
        signal.throwIfAborted()
        if (!await authorize(operation.identity)) return { error: '当前运行无权发送邮件' }
        if (draft.fileIds.length) return { error: '桌面邮件只支持添加当前消息引用的本机文件' }
        const account = (await listMailAccounts(signal))[0]
        if (!account) return { error: '请先在桌面邮件页面连接邮箱账户' }
        let attachmentManifest: Awaited<ReturnType<typeof resolveMailReferences>>
        try { attachmentManifest = await resolveMailReferences(operation.identity, draft.fileRefs, signal) }
        catch (error) {
          signal.throwIfAborted()
          return { error: error instanceof CoreError ? error.message : '本机邮件附件无法读取或已变化' }
        }
        const subject = draft.subject.replace(/[\r\n]/gu, ' ')
        const displaySubject = [...subject.replace(/[\p{Cc}\p{Cf}]/gu, ' ')].slice(0, 160).join('')
        const appearance = await createDesktopAppearanceService(createKyselyPreferenceDocumentStore(db, 'sqlite')).get(ownerId)
        const theme = draft.theme === undefined || draft.theme === 'auto'
          ? appearance.theme === 'dark' ? 'dark' : 'light' : draft.theme
        const palette = draft.palette === undefined || draft.palette === 'auto'
          ? normalizeThemePalette(appearance.palette) : draft.palette
        const plain = { subject, plain: draft.body, html: '', images: [] }
        const message = draft.format === 'template'
          ? renderSmtpDraftMessage({ ...draft, subject, title: draft.title ?? '', theme, palette })
          : draft.format === 'html'
            ? { ...plain, html: sanitizeEmailHtml(draft.html ?? '') }
            : plain
        const attachmentNames = attachmentManifest.items.map(item => item.filename)
        const attachmentSize = attachmentManifest.items.reduce((sum, item) => sum + item.size, 0)
        const delivery = {
          accountId: account.id, accountVersion: account.version, attemptId: randomUUID(),
          attachmentDigest: attachmentManifest.digest, fileRefs: attachmentManifest.ids,
          draft: { to: [draft.recipient], subject, text: message.plain,
            ...(message.html ? { html: message.html } : {}),
            inlineAttachments: message.images.map(image => ({ ...image, mimeType: 'image/png' })) },
        }
        const formatLabel = draft.format === 'html' ? '自定义 HTML + 纯文本'
          : draft.format === 'template' ? '咕咕标准 HTML + 纯文本' : '纯文本'
        let displaySummary = `使用桌面邮箱 ${maskEmailAddress(account.email)} 发送${formatLabel}邮件至 ${maskEmailAddress(draft.recipient)}，主题：${displaySubject}。正文共 ${[...draft.body].length} 个字符。`
        if (attachmentNames.length) displaySummary += `附件 ${attachmentNames.length} 个（${(attachmentSize / 1024 / 1024).toFixed(1)}MB）：${attachmentNames.join('、')}。`
        return {
          digest: digest({ accountId: account.id, recipient: draft.recipient, message, attachmentDigest: attachmentManifest.digest }),
          snapshot: { targetsDigest: digest({ accountId: account.id, recipient: draft.recipient, attachments: attachmentManifest.digest }),
            versionsDigest: account.version },
          delivery, displaySummary,
        }
      },
      send: emailDelivery.send,
      reconcile: emailDelivery.reconcile,
      attempted: emailDelivery.attempted,
      supportedFormats: ['plain', 'template', 'html'],
      supportedAttachmentInputs: ['file_refs'],
    }) : undefined
    const readHostAccess = async (scope: import('../../../../../packages/core/src/agent/tools/contracts.js').ToolScope) => {
      if (!interactive || !await authorizeWrite(db, scope.identity, scope.signal)) return null
      return readDesktopShellPreferences()
    }
    function isHostFilePath(path: string) {
      return isAbsolute(path) && !/^\/(personal|project|workspace)\//u.test(path)
    }
    async function authorizeHostFile(path: string, selector: unknown,
      scope: import('../../../../../packages/core/src/agent/tools/contracts.js').ToolScope,
      call: import('../../../../../packages/core/src/agent/models.js').ToolCall,
      confirmation: typeof presentConfirmation): Promise<
      { target: { path: string; identity: string } } | { error: string }
      | Extract<import('../../../../../packages/core/src/agent/models.js').ToolResult, { kind: 'waiting' }>
    > {
      const { identity, signal } = scope
      const access = await readHostAccess(scope)
      const grant = access && desktopHostAuthorization(access, identity, digest)
      if (!grant) return { error: '当前会话未启用宿主机文件访问' } as const
      if (/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(path)) return { error: '本机文件路径无效' } as const
      const actual = await realpath(path).catch(() => null)
      const info = actual && await stat(actual, { bigint: true }).catch(() => null)
      if (!actual || !info || !info.isFile()) return { error: '本机文件不存在或不可访问' } as const
      const target = { path: actual, identity: [info.dev, info.ino, info.birthtimeNs].join('.') }
      const snapshot = { targetsDigest: digest(target), versionsDigest: grant.version, targetIds: {} }
      const argsDigest = digest(selector)
      if (!scope.resolution && !grant.permits()) {
        const prepared = await confirmation.gate.prepare(call, scope, argsDigest, snapshot)
        return prepared.ok ? { kind: 'waiting', interaction: prepared.value } as const : { error: '无法申请宿主机文件访问授权' } as const
      }
      if (digest(access) !== digest(await readHostAccess(scope))) return { error: '宿主机文件权限已变化' } as const
      if (scope.resolution) {
        const confirmed = await confirmation.gate.verify(call, scope, argsDigest, snapshot)
        if (!confirmed.ok || !await db.transaction().execute(tx => confirmation.claim(tx, confirmed.value, signal)))
          return { error: '宿主机文件确认无效或已过期' } as const
        grant.approve()
      } else if (!grant.permits()) return { error: '宿主机文件授权已过期' } as const
      return { target } as const
    }
    const shell = interactive ? await createDesktopShellTool(db, shellConfirmation, digest, readHostAccess) : undefined
    const mcpCrypto = createDesktopMcpCrypto(databasePath)
    const validateMcpToolEndpoint = (endpoint: string) => validateMcpEndpoint(endpoint, isPublicAddress)
    const mcpAddConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'add_mcp_server',
      async (_tx, identity, input, snapshot): Promise<string> => {
        if (!mcpAdd) throw new CoreError('conflict', 'MCP 创建确认不可用')
        return mcpAdd.describe(identity, input, snapshot)
      })
    const mcpAdd = core.receipts && interactive ? createMcpManagementCreateOperations(core, {
      settings: () => ({ default_timeout_seconds: 30, max_tools_per_server: 64, max_servers_per_user: desktopMcpMaxServers }),
      id: randomUUID, encrypt: mcpCrypto.encrypt, validateEndpoint: validateMcpToolEndpoint,
      authorize: authorizeWrite, confirmation: mcpAddConfirmation, stageCredential: stageSqliteMcpCredential,
    }) : undefined
    const mcpUpdateConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'update_mcp_server',
      (tx, identity, input, snapshot) => describeMcpManagementUpdate(tx, identity, input, snapshot, 'sqlite', validateMcpToolEndpoint))
    const mcpRemoveConfirmation = createSqliteToolConfirmation(db, authorizeWrite, 'remove_mcp_server',
      async (tx, identity, input, snapshot): Promise<string> => {
        if (!mcpRemove) throw new CoreError('conflict', 'MCP 删除确认不可用')
        return mcpRemove.describe(tx, identity, input, snapshot)
      })
    const mcpRemove = core.receipts && interactive ? createMcpManagementRemoveOperations(core, {
      crypto: mcpCrypto, maxTools: 64,
    }, { confirmation: mcpRemoveConfirmation, async invalidate() {} }) : undefined
    const sendFile = imChatType === 'c2c' || groupChat ? createImSendFileTool({
      allowFileId: false,
      allowFilePath: imChatType === 'c2c',
      async send({ identity, attachId, filePath, signal }) {
        const source = attachId ?? filePath
        if (!source || !await authorize(identity)) return 'failed'
        signal.throwIfAborted()
        const attempt = await desktopImAttachmentDelivery(db, identity, source, 'begin')
        if (!attempt) return 'failed'
        if (attempt.state !== 'new') return attempt.state === 'accepted' ? 'sent' : attempt.state === 'rejected' ? 'failed' : 'unknown'
        let outcome: 'accepted' | 'rejected' | 'unknown' = 'unknown'
        try {
          const result = await hostRequest('agent.im.sendAttachment', attempt, signal)
          if (result === 'accepted' || result === 'rejected') outcome = result
        } catch { /* 已占位的请求失去结果时保留未知。 */ }
        const receipt = await desktopImAttachmentDelivery(db, identity, source, outcome)
        return receipt?.state === 'accepted' ? 'sent' : receipt?.state === 'rejected' ? 'failed' : 'unknown'
      },
      async recover({ identity, attachId, filePath }) {
        const source = attachId ?? filePath
        if (!source || !await authorize(identity)) return 'unknown'
        const receipt = await desktopImAttachmentDelivery(db, identity, source, 'read')
        return receipt?.state === 'accepted' ? 'sent' : receipt?.state === 'rejected' ? 'failed' : 'unknown'
      },
    }) : undefined
    const saveAttachment = interactive ? createSaveAttachmentTool({
      async save(identity, input, roundId, call, signal) {
        signal.throwIfAborted()
        if (!await authorize(identity)) return { kind: 'failed', error: '附件保存授权已失效' }
        const workspaceDirectoryId = input.space === 'workspace' && selection.workspaceBinding
          && typeof selection.workspaceBinding.directory_id === 'string' ? selection.workspaceBinding.directory_id : undefined
        if (input.space === 'workspace' && !workspaceDirectoryId)
          return { kind: 'failed', error: '当前会话没有绑定可写入的工作区，请先绑定工作区或保存到个人/项目文件' }
        if (input.folder_id !== undefined && input.folder_path === undefined)
          return { kind: 'failed', error: '桌面文件夹使用相对路径；请提供 folder_path' }
        const ids = input.source === 'latest'
          ? (await sql<{ attach_id: string }>`SELECT a.attach_id FROM chat_attachments a
              JOIN agent_run_admissions r ON r.user_id=a.user_id AND r.user_message_id=a.message_id
              WHERE r.user_id=${dataContext(identity.ownerId).ownerId.replaceAll('-', '')}
                AND r.session_id=${Number(identity.sessionId)} AND r.run_id=${identity.runId} AND a.state='attached'
              ORDER BY a.attached_at DESC,a.created_at DESC LIMIT 1`.execute(db)).rows.map(row => row.attach_id)
          : input.source === 'attach_ids' ? [...(input.attach_ids ?? [])] : [input.attach_id ?? '']
        if (input.source === 'latest' && ids.length === 0)
          return { kind: 'failed', error: '当前对话中没有可保存的近期附件' }
        const saved: Array<Record<string, unknown>> = []
        const failed: Array<{ attach_id: string; error: string }> = []
        for (const attachId of ids) {
          signal.throwIfAborted()
          const attachment = await resolveOwnedAttachment(identity, attachId, signal)
          if (!attachment) {
            failed.push({ attach_id: attachId, error: '附件不存在或已过期' })
            continue
          }
          if (attachment.size_bytes > 32 * 1024 * 1024) {
            failed.push({ attach_id: attachId, error: '附件超过桌面文件库支持的 32 MB 上限' })
            continue
          }
          const opened = await openLocalFile(attachment.root, attachment.relativePath)
          if (!opened || opened.size !== attachment.size_bytes) {
            await opened?.handle.close()
            failed.push({ attach_id: attachId, error: '附件已过期或文件丢失' })
            continue
          }
          let bytes: Buffer
          try {
            bytes = await opened.handle.readFile()
            if (bytes.length !== attachment.size_bytes) {
              failed.push({ attach_id: attachId, error: '附件内容已变化' })
              continue
            }
          } finally { await opened.handle.close() }
          const expectedDigest = createHash('sha256').update(bytes).digest('hex')
          const projectId = input.space === 'project' ? input.project_id : undefined
          const operationId = digest(['agent.file.save_uploaded_file', identity.ownerId, identity.sessionId,
            identity.runId, roundId, call.id, attachId, input.space, projectId, workspaceDirectoryId])
          const fingerprint = digest([attachId, input.space, projectId ?? null, workspaceDirectoryId ?? null, input.folder_path ?? null,
            attachment.name, attachment.size_bytes, expectedDigest])
          try {
            const result: unknown = await hostRequest('agent.files.saveAttachment', {
              operationId, fingerprint, attachId, expectedSize: attachment.size_bytes, expectedDigest,
              name: attachment.name, space: input.space, ...(projectId === undefined ? {} : { projectId }),
              ...(workspaceDirectoryId === undefined ? {} : { workspaceDirectoryId }),
              ...(input.folder_path === undefined ? {} : { folderPath: input.folder_path }),
            }, signal)
            signal.throwIfAborted()
            if (!result || typeof result !== 'object' || Array.isArray(result)
              || typeof (result as Record<string, unknown>).name !== 'string'
              || typeof (result as Record<string, unknown>).path !== 'string'
              || (result as Record<string, unknown>).size_bytes !== attachment.size_bytes) {
              failed.push({ attach_id: attachId, error: '文件保存返回无效结果' })
              continue
            }
            saved.push({ attach_id: attachId, ...(result as Record<string, unknown>) })
          } catch {
            signal.throwIfAborted()
            failed.push({ attach_id: attachId, error: '附件保存失败，请确认目标目录仍可用' })
          }
        }
        if (input.source !== 'attach_ids') {
          const item = saved[0]
          if (!item) return { kind: 'failed', error: failed[0]?.error ?? '附件不存在或已过期' }
          const { attach_id: _attachId, size_bytes, ...value } = item
          return { kind: 'saved', mutated: item.replayed !== true, value: { ...value, size: size_bytes,
            ...(input.project_id ? { project_id: input.project_id } : {}) } }
        }
        return { kind: 'saved', mutated: saved.some(item => item.replayed !== true), value: {
          success: failed.length === 0, saved_count: saved.length, failed_count: failed.length,
          saved: saved.map(({ replayed: _replayed, ...item }) => item), failed,
        } }
      },
    }) : undefined
    async function privateScheduleImTarget(platform: DesktopScheduleImPlatform, identity: RunIdentity, signal?: AbortSignal,
      database: Kysely<Database> = db) {
      const target = desktopScheduleImTarget.safeParse(await hostRequest('agent.schedules.im.privateTarget', { platform }, signal))
      return target.success && await ownsDesktopScheduleImTarget<Database>(database, identity.ownerId, target.data) ? target.data : null
    }
    async function scheduleImTarget(identity: RunIdentity, signal?: AbortSignal, database: Kysely<Database> = db) {
      const platform = imSession?.platform
      if (platform !== 'qq' && platform !== 'feishu' && platform !== 'telegram' && platform !== 'wechat') return null
      if (!groupChat) return privateScheduleImTarget(platform, identity, signal, database)
      const receipt = await desktopImGroupRunEvent(database, identity)
      if (!receipt) return null
      const scope = desktopGroupMemoryContext(await hostRequest('agent.im.readGroupMemoryContext', { ...receipt, ownerId }, signal), ownerId)
      if (!scope?.actor.verifiedOwner || scope.platform !== platform) return null
      const target = desktopScheduleImTarget.safeParse({
        platform, botId: scope.botId, chatType: 'group', recipient: scope.chatId, boundUserId: scope.platformUserId,
      })
      return target.success ? target.data : null
    }
    function writeScheduleTarget(input: Record<string, unknown>) {
      const { delivery_targets, authorized_tools: _authorizedTools, ...fields } = input
      const targets = readDesktopScheduleImTargets(delivery_targets, Array.isArray(fields.channels) ? fields.channels : [])
      return { fields, targets }
    }
    const scheduleWrites = core.receipts ? createScheduledTaskWriteTools(core, {
      reminderOnly: !imSession,
      supportedChannels: ['web', ...desktopScheduleImPlatforms],
      capabilities: { workspaceSupported: false, filesystemAuthorizationEnabled: false },
      async authorize(tx, identity, input, signal) {
        if (input.workspace_id !== undefined || input.email_attachment_file_ids !== undefined || input.authorized_tools !== undefined
          || input.filesystem_authorized !== undefined || input.channels?.some(channel => channel !== 'web' && channel !== 'qq' && channel !== 'feishu' && channel !== 'telegram' && channel !== 'wechat'))
          return false
        if (!await authorizeWrite(tx, identity, signal)) return false
        if (!groupChat) return input.delivery_mode !== 'current_group'
        const target = await scheduleImTarget(identity, signal, tx)
        if (!target || input.delivery_mode === 'owner_private' || 'task' in input || 'task_ids' in input) return false
        if ('task_id' in input && typeof input.task_id === 'number') {
          const task = await desktopScheduledTasks<Database>(tx, identity.ownerId).get(input.task_id)
          const current = readDesktopScheduleImTargets(task.delivery_targets, task.channels).find(candidate => candidate.chatType === 'group')
          return stableJson(current) === stableJson(target)
        }
        return true
      },
      async delivery(tx, identity, intent, signal) {
        const channelList = intent.channels
        const selected = channelList?.filter(channel => channel === 'qq' || channel === 'feishu' || channel === 'telegram' || channel === 'wechat') ?? []
        const bound = imSession && (groupChat || !selected.length) ? await scheduleImTarget(identity, signal, tx) : null
        if ((groupChat || intent.mode === 'current_group') && bound?.chatType !== 'group')
          throw new ScheduledTaskReferenceError('当前 IM 对话没有可用的群任务投递授权')
        if (intent.mode === 'owner_private' && !bound && !selected.length)
          throw new ScheduledTaskReferenceError('请指定可用的私聊投递渠道')
        const channels = [...new Set([...selected, ...(bound ? [bound.platform] : [])])]
        if (!channels.length) return {}
        const targets: DesktopScheduleImTarget[] = []
        for (const platform of channels) {
          const target = bound?.platform === platform ? bound : await privateScheduleImTarget(platform, identity, signal, tx)
          if (!target || !await currentScheduledIm(target, signal, tx))
            throw new ScheduledTaskReferenceError('当前 IM 投递目标已失效')
          targets.push(target)
        }
        return {
          channels: [...channels, ...(channelList?.includes('web') ? ['web'] : [])],
          delivery_targets: desktopScheduleImDeliveryTargets(targets),
        }
      },
      async create(tx, owner, input) {
        const { fields, targets } = writeScheduleTarget(input)
        return (await desktopScheduledTasks<Database>(tx, owner).create({ execution_mode: targets.length ? 'instruction' : 'reminder', ...fields }, null, targets)).id
      },
      async update(tx, owner, id, patch) {
        const { fields, targets } = writeScheduleTarget(patch)
        const tasks = desktopScheduledTasks<Database>(tx, owner)
        if (!imSession && (fields.execution_mode ?? (await tasks.get(id)).execution_mode) !== 'reminder')
          throw new ScheduledTaskReferenceError('桌面端请使用提醒模式 execution_mode=reminder')
        await tasks.update(id, fields, null, targets)
      },
      async publish() {},
    }) : []
    const groupScheduleList = createListScheduledTasksTool({
      async list(identity, signal) {
        const target = await scheduleImTarget(identity, signal)
        if (!target) return []
        return (await scheduledTasks.agent(identity.ownerId, signal)).filter(task =>
          readDesktopScheduleImTargets(task.delivery_targets, task.channels).some(candidate => stableJson(candidate) === stableJson(target)))
          .map(({ delivery_targets: _target, ...task }) => task)
      },
    })
    const registry = createOwnerToolRegistry({
      ...(sendEmail ? { sendEmail } : {}),
      ...(saveAttachment ? { saveAttachment } : {}),
      sendFile,
      mcpManagement: createMcpManagementTool({
        list: createMcpServerConfigLister(db, 'sqlite'), decrypt: mcpCrypto.decrypt, enabled: () => true,
        async testConnection(owner, id, signal) {
          if (owner !== ownerId) return { ok: false, errorKind: 'configuration' }
          const config = await desktopMcp(db, owner, mcpCrypto).config(id) as McpConfig
          const result = await testMcp(config, resolveProxy, { allowLoopback: false, signal })
          return result.ok ? { ok: true, toolNames: result.tools } : { ok: false, errorKind: result.errorKind }
        },
        state: (owner, id): ReturnType<ReturnType<typeof createDesktopMcpAgentRuntime>['state']> => mcpRuntime.state(owner, id),
      }, mcpRemove, core.receipts && interactive ? createMcpManagementEditOperations(core, {
        decrypt: mcpCrypto.decrypt,
        authorize: authorizeWrite,
        update: { crypto: mcpCrypto, maxTools: 64, confirmation: mcpUpdateConfirmation,
          validateEndpoint: validateMcpToolEndpoint, credential: { id: randomUUID, stage: stageSqliteMcpCredential } },
        async afterCommit(owner, id, reload, signal) {
          if (!reload) return
          signal.throwIfAborted()
          await mcpRuntime.directory(owner)
          signal.throwIfAborted()
          const { state } = await mcpRuntime.state(owner, id)
          return { ok: state === 'ok', state, error: null }
        },
      }) : undefined, mcpAdd),
      ...(shell ? { shell } : {}),
      linkButtons: createWebLinkButtonDeliveryPort(authorize),
      core, authorize, webSearch,
      webDownload: createDesktopWebDownload({
        dataRoot: dirname(databasePath), authorized: authorize,
        readTarget: signal => hostRequest('agent.files.downloadTarget', {}, signal),
        commit: (input, signal) => hostRequest('agent.files.commitDownload', input, signal),
        open: (url, signal) => openStreamedAgentGet(createNodeProviderTransport({
          ...desktopTransportOptions(false, resolveProxy), connectTimeoutMs: 10_000, writeTimeoutMs: 10_000,
        }), url, signal),
      }),
      deepResearch: researchAvailable === true ? deepResearch : undefined,
      similarImageSearch: imageSearchAvailable === true ? similarImageSearch : undefined,
      skills, skillMetadata, callTool: true, knowledge, viewImage,
      ...(knowledgeDeletePort ? { knowledgeDelete: createKnowledgeDeleteTool(knowledgeDeletePort) } : {}),
      knowledgeWrites: createLocalAgentKnowledgeWritePort(core, dirname(databasePath), knowledgeStore, publishDesktopKnowledgeFile),
      presentFile: {
        requiresHostConfirmation: true,
        async resolve(identity, selector, signal, { scope, call }) {
          signal.throwIfAborted()
          if (!await authorize(identity)) return { error: '当前文件预览授权已失效' }
          const path = selector.file
          let referenceId: string | undefined
          const hostPath = isHostFilePath(path)
          if (hostPath) {
            const { references } = await readDesktopTurnReferences(db, identity)
            for (const ref of references.slice(0, 6)) {
              if (ref?.type !== 'file' || typeof ref.id !== 'string' || !workspaceFileReferenceId.test(ref.id)) continue
              if ((await resolveReferencedFile(ref.id, signal))?.path !== path) continue
              referenceId = ref.id
              break
            }
          }
          let external: { path: string; identity: string } | undefined
          if (hostPath && !referenceId) {
            const result = await authorizeHostFile(path, selector, scope, call, presentConfirmation)
            if (!('target' in result)) return result
            external = result.target
          } else if (scope.resolution) return { error: '文件目标或授权已变化，请重新发起操作' }
          const target = external ? { path: external.path, hostIdentity: external.identity }
            : { path, ...(referenceId ? { referenceId } : {}) }
          const value: unknown = await hostRequest('agent.files.present', {
            ...target, ...(selector.reference_only ? { referenceOnly: true } : {}),
          }, signal)
          signal.throwIfAborted()
          if (!await authorize(identity)) return { error: '当前文件预览授权已失效' }
          if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: '文件不存在或无法预览' }
          const file = value as Record<string, unknown>
          if (typeof file.error === 'string') return { error: file.error }
          if (file.opened !== true || typeof file.name !== 'string' || typeof file.ext !== 'string')
            return { error: '文件不存在或无法预览' }
          return { file: { name: file.name, ext: file.ext,
            ...(typeof file.referenceId === 'string' ? { referenceId: file.referenceId } : {}),
            ...(typeof file.path === 'string' ? { path: file.path } : {}),
            surface: file.system === true ? 'system' : 'desktop' } }
        },
      },
      ...(core.receipts ? { skillManagement: createSkillManagementWriteTools(core, createDesktopSkillManager(db),
        authorizeWrite) } : {}),
      ...(core.receipts && interactive ? {
        clientDelete: { ...createClientDeletePort(core, clientDeleteConfirmation), destructive: true },
        skillDelete: { ...createSkillDeleteTool(core, skillDeleteConfirmation, async () => {}), destructive: true },
      } : {}),
      ...(undoLastAction ? { undoLastAction } : {}),
      async fileOverview(identity, projectId, signal) {
        signal.throwIfAborted()
        if (!await authorize(identity)) throw new CoreError('conflict', '当前运行无权读取项目文件')
        const counts = await hostRequest('agent.files.projectOverview', { projectId }, signal)
        signal.throwIfAborted()
        if (!await authorize(identity)) throw new CoreError('conflict', '当前运行无权读取项目文件')
        // get_project 使用共享文件统计 Schema 校验宿主回复。
        return counts as ProjectFileOverview
      },
      projects: createKyselyProjectCreateRuntime({ db, backend: 'sqlite', async publishProjectCreated() {} }),
      ...(core.receipts ? { projectMutations: createDurableProjectMutationPort({
        core,
        runtime: {
          // 桌面项目目录按最新项目元数据惰性定位；文件服务在读取项目目录时负责迁移旧目录。
          async renameProjectDirectory() {},
          async getFileCount() { return 0 },
          async publishProjectUpdated() {},
        },
        metadata: identity => ({ undoContextId: `agent:${identity.sessionId}:${identity.runId}`.slice(0, 128) }),
      }) } : {}),
      ...(interactive ? { askUser: { singleChoiceOnly, authorization: async () => 'disabled' as const } } : {}),
      httpGet,
      remember: createSqliteRememberMemory(db, memoryFiles),
      memorySearch: createSqliteMemorySearch(db, authorize, embedding, memoryFiles, resolveProxy),
      recentAttachments: {
        async list(identity, signal) {
          signal.throwIfAborted()
          if (!await authorize(identity)) throw new CoreError('conflict', '近期附件运行授权已失效')
          const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
          const staged = await sql<RecentAttachmentRow>`SELECT attach_id,name,ext,kind,NULL AS platform,size,img_width,img_height,duration,created_at
            FROM chat_attachments WHERE user_id=${owner} AND state='draft' ORDER BY created_at DESC`.execute(db)
          signal.throwIfAborted()
          const attached = await sql<RecentAttachmentRow>`SELECT a.attach_id,a.name,a.ext,a.kind,NULL AS platform,a.size,a.img_width,a.img_height,a.duration,a.created_at
            FROM chat_attachments a JOIN conversation_messages m ON m.id=a.message_id
            JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=a.user_id
            WHERE a.user_id=${owner} AND s.id=${Number(identity.sessionId)} AND a.state='attached'
            ORDER BY a.attached_at DESC,a.created_at DESC LIMIT 20`.execute(db)
          signal.throwIfAborted()
          if (!await authorize(identity)) throw new CoreError('conflict', '近期附件运行授权已失效')
          return projectRecentAttachments(staged.rows, attached.rows)
        },
      },
      conversationSearch: createCoreAgentConversationSearchPort({ db, backend: 'sqlite' }),
      conversations: { read: (identity, id, limit, signal) => readConversation(identity.ownerId, id, limit, signal) },
      time: agentClock,
      currentTime: agentClock,
      events: createKyselyCalendarReadPort(db, 'sqlite'),
      calendar: createAgentCalendarReader(calendarEvents),
      ...(core.receipts ? {
        calendarCreate: createCalendarEventCreatePort(core, async () => {}, calendarTargets, undefined,
          identity => `agent:${identity.sessionId}:${identity.runId}`.slice(0, 128)),
        calendarUpdate: createCalendarEventUpdatePort(core, async () => {}, calendarEvents, calendarTargets, undefined,
          identity => `agent:${identity.sessionId}:${identity.runId}`.slice(0, 128)),
        ...(interactive ? { calendarDelete: createCalendarDeletePort(core, async () => {}, calendarConfirmation,
          identity => `agent:${identity.sessionId}:${identity.runId}`.slice(0, 128)) } : {}),
      } : {}),
      scheduledTasks: { list: (identity, signal) => scheduledTasks.agent(identity.ownerId, signal) },
      ...(core.receipts && interactive ? {
        scheduledTaskDelete: createScheduledTaskDeleteTool(core, confirmation, async () => {}),
      } : {}),
      ...(scheduleWrites.length ? { scheduledTaskWrites: scheduleWrites } : {}),
      notes: createAgentMindReader(db, 'sqlite', resolveDesktopFileReference),
      workspaces: agentWorkspaces,
      ...(core.receipts ? { noteLifecycle: createNoteLifecyclePort(core, async () => {}) } : {}),
      ...(core.receipts ? { noteWrites: createNoteWritePort(core, { timezone,
        async validateFileReference(_owner, id, signal) { return Boolean(await resolveReferencedFile(id, signal)) },
        async publish() {} }) } : {}),
      canvases: createSqlMindCanvasReader(db, 'sqlite'),
      ...(canvasEdits ? {
        canvasCreation: createCanvasCreationPort(core, async () => {}),
        canvasEdits, canvasPlacements: canvasEdits, canvasRelations: canvasEdits,
      } : {}),
      ...(core.receipts && interactive ? {
        canvasBatch: createCanvasBatchPort(core, async () => {}, canvasConfirmations.canvas_batch, resolveDesktopFileReference),
        canvasDeleteNote: createCanvasDeleteNotePort(core, async () => {}, canvasConfirmations.canvas_delete_note),
        canvasDisconnect: createCanvasDisconnectPort(core, async () => {}, canvasConfirmations.canvas_disconnect),
        canvasDelete: createCanvasDeletePort(core, async () => {}, canvasConfirmations.canvas_delete),
      } : {}),
      canvasPlaceableSearch: createAgentPlaceableSearch(db, 'sqlite', async (_owner, query, limit, signal) => {
        const files = await hostRequest('agent.files.searchReferences', { query }, signal)
        if (!Array.isArray(files)) throw new CoreError('storage_error', '本机文件引用搜索结果无效')
        return files.filter((file): file is { id: string; label: string } =>
          file && typeof file.id === 'string' && workspaceFileReferenceId.test(file.id) && typeof file.label === 'string').slice(0, limit)
      }),
      search: createGlobalSearchOperations(createKyselySqliteGlobalSearchSources(db)),
    })
    if (config === null || sessionId === null) return { kind: 'catalog' as const, catalog: registry.catalog() }
    // 可用性只决定是否开放新调用。已有调用的收据查询保留原工具的参数校验与运行授权。
    const recoveryTools = [
      ...(researchAvailable === true ? [] : [deepResearch]),
      ...(imageSearchAvailable === true ? [] : [similarImageSearch]),
    ]
    const unavailableSearch = new Set(recoveryTools.map(tool => tool.definition.name))
    const searchRecovery = createToolRegistry({ tools: recoveryTools, authorize }).tools
    const mcpRuntime = createDesktopMcpAgentRuntime(db, ownerId, mcpCrypto, {
      transport: () => createNodeProviderTransport({ ...desktopTransportOptions(false, resolveProxy),
        connectTimeoutMs: 10_000, writeTimeoutMs: 10_000 }),
      builtinNames: async () => new Set(registry.catalog().map(tool => tool.name)),
    })
    const mcpTools = createMcpAgentToolPorts({
      base: registry,
      directory: mcpRuntime.directory,
      services: mcpRuntime.services,
      runtime: mcpRuntime,
      configured: async (_identity, name) => (await configuredAgentTools([name])).length === 1,
      async authorize(identity, _name, signal) {
        signal?.throwIfAborted()
        return identity.ownerId === ownerId && identity.sessionId === String(sessionId) && await authorize(identity)
      },
    })
    async function authorizeGroupTool(identity: RunIdentity, name: string) {
      if (!await authorize(identity)) return false
      const receipt = await desktopImGroupRunEvent(db, identity)
      return !!receipt && await hostRequest('agent.im.authorizeGroupTool', { ...receipt, name }) === true
    }
    const groupTools = groupChat ? createToolRegistry({
      tools: [
        createTimeTool(agentClock), groupScheduleList, ...scheduleWrites,
        createGroupContextSearchTool(createDesktopGroupContextSearch(db, identity => authorizeGroupTool(identity, 'group_context_search'))),
        ...(webSearch ? [webSearch] : []),
        ...(imageSearchAvailable === true ? [similarImageSearch] : []),
        createHttpGetTool(httpGet),
        ...(sendFile ? [sendFile] : []),
      ],
      async authorize(identity, name) {
        if (name === 'get_current_time') return authorize(identity)
        if (['list_scheduled_tasks', 'create_scheduled_task', 'update_scheduled_task'].includes(name))
          return await authorize(identity) && (await configuredAgentTools([name])).length === 1
            && Boolean(await scheduleImTarget(identity))
        return authorizeGroupTool(identity, name)
      },
    }) : undefined
    const delegation = (imSession ? (imChatType ?? 'c2c') === 'c2c' : interactive) ? createToolRegistry({
      tools: createSubagentServiceTools(desktopSubagents(secret)), authorize,
    }) : undefined
    const delegationNames = new Set(delegation?.catalog().map(tool => tool.name))
    const configuredTools = async (identity: RunIdentity, lookup?: McpToolLookup): Promise<PreparedToolDefinition[]> => {
      if (groupTools) return groupTools.capabilities(identity)
      const definitions = [...await mcpTools.capabilities(identity, lookup),
        ...(lookup || !delegation ? [] : await delegation.capabilities(identity))]
      const allowed = new Set(await configuredAgentTools(definitions.map(tool => tool.name)))
      return definitions.filter(tool => allowed.has(tool.name))
    }
    const sessionSource = createSqliteAgentSessionSource(db, {
      async readReferencedFile(id, signal) {
        const file = await resolveReferencedFile(id, signal)
        if (!file) return null
        const excerpt = await readDroppedFileExcerpt(file.path, file.fileIdentity, signal)
        return excerpt ? { ...excerpt, path: file.path, relativePath: file.relativePath } : null
      },
      async readAttachmentText(identity, attachment) {
      const attachId = attachment.attach_id
      if (!/^[0-9a-f]{32}$/.test(attachId)) throw new CoreError('not_found', '附件已过期或文件丢失')
      const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
      const { rows } = await sql<{ storage_key: string; size: number }>`SELECT a.storage_key,a.size FROM chat_attachments a
        JOIN agent_run_admissions r ON r.user_id=a.user_id AND r.user_message_id=a.message_id
        WHERE r.user_id=${owner} AND r.session_id=${Number(identity.sessionId)} AND r.run_id=${identity.runId}
          AND a.attach_id=${attachId} AND a.state='attached'`.execute(db)
      if (rows[0]?.storage_key !== `agent-attachments/${attachId}` || Number(rows[0].size) !== Number(attachment.size))
        throw new CoreError('not_found', '附件已过期或文件丢失')
      const handle = await openFile(`${dirname(databasePath)}/agent-attachments/${attachId}`,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size !== Number(attachment.size)) throw new CoreError('not_found', '附件已过期或文件丢失')
        return await handle.readFile('utf8')
      } finally { await handle.close() }
    } })
    async function mayForward(name: string, identity: RunIdentity, signal?: AbortSignal) {
      const allowed = new Set((await configuredTools(identity, name.startsWith('mcp_') ? { names: [name] } : undefined)).map(tool => tool.name))
      signal?.throwIfAborted()
      return allowed.has('call_tool') && allowed.has(canonicalAgentToolName(name))
    }
    const contextBuilder = createMainContextBuilder({
      buildSnapshot: data => {
        const preferences = data.stylePreferences && typeof data.stylePreferences === 'object' && !Array.isArray(data.stylePreferences)
          ? data.stylePreferences as Record<string, Json> : {}
        if (groupChat) {
          snapshotContext = formatGroupMemory(data.imMemory)
          systemPrompt = buildSystemPrompt(stylePreferences)
          return { systemPrompt, snapshotContext, sessionInfo: { stylePreferences }, userTimezone: data.userTimezone, locale: selection.locale }
        }
        if (!overviewData || !ownerMemory) throw new CoreError('conflict', '桌面 Agent 上下文尚未准备')
        const knowledgeRows = Array.isArray(data.knowledge)
          ? data.knowledge.filter((item): item is Record<string, Json> => !!item && typeof item === 'object' && !Array.isArray(item))
          : []
        snapshotContext = formatSqliteAgentOverview(overviewData, formatAgentMemory(ownerMemory, Date.now()), filesOverview, knowledgeRows, imChannels)
        systemPrompt = buildSystemPrompt(preferences)
        return { systemPrompt, snapshotContext, sessionInfo: { stylePreferences: preferences }, userTimezone: data.userTimezone, locale: selection.locale }
      },
      buildRequest: snapshot => {
        const info = snapshot.sessionInfo && typeof snapshot.sessionInfo === 'object' && !Array.isArray(snapshot.sessionInfo)
          ? snapshot.sessionInfo as Record<string, Json> : {}
        const preferences = info.stylePreferences && typeof info.stylePreferences === 'object' && !Array.isArray(info.stylePreferences)
          ? info.stylePreferences as Record<string, Json> : {}
        return request(snapshot.snapshotContext, buildSystemPrompt(preferences))
      },
    })
    const source = createCanonicalSourceLoader({
      ...sessionSource, digest, nextId: randomUUID, now: Date.now,
      select: async () => selection,
      currentRevision: async identity => {
        if (!await authorizeContext(identity)) throw new CoreError('conflict', '当前运行无权读取上下文版本')
        return contextRevision
      },
      data: {
        loadTimezone: async () => timezone, loadImMemory: async (identity, signal) => {
          if (!await authorizeContext(identity) || !boundIdentity)
            throw new CoreError('conflict', '当前运行无权读取群组记忆')
          return (await readDesktopImMemory(boundIdentity, signal)).data
        },
        loadProjects: async identity => { if (!await authorizeContext(identity) || !overviewData) throw new CoreError('conflict', '项目上下文未准备'); return overviewData.projects },
        loadEvents: async identity => { if (!await authorizeContext(identity) || !overviewData) throw new CoreError('conflict', '日历上下文未准备'); return overviewData.events },
        loadNotes: async identity => { if (!await authorizeContext(identity) || !overviewData) throw new CoreError('conflict', '笔记上下文未准备'); return overviewData.notes },
        loadFilesOverview: async (identity, signal) => {
          if (!await authorizeContext(identity)) throw new CoreError('conflict', '当前运行无权读取文件概览')
          const overview: unknown = await hostRequest('agent.files.overview', {}, signal)
          if (!overview || typeof overview !== 'object' || Array.isArray(overview))
            throw new CoreError('storage_error', '桌面文件概览无效')
          const value = overview as Record<string, unknown>
          if (!Number.isSafeInteger(value.total) || (value.total as number) < 0
            || !Array.isArray(value.folders) || !Array.isArray(value.files)
            || typeof value.partial !== 'boolean')
            throw new CoreError('storage_error', '桌面文件概览无效')
          const { trash: _desktopTrash, ...desktopOverview } = value
          filesOverview = desktopOverview as Record<string, Json>
          contextRevision = Number.parseInt(digest([memoryRevision, overviewData, filesOverview, stylePreferences, imChannels, timezone]).slice(0, 12), 16)
          return filesOverview
        }, loadStylePreferences: async identity => {
          if (!await authorizeContext(identity)) throw new CoreError('conflict', '当前运行无权读取回复风格')
          contextRevision = Number.parseInt(digest([memoryRevision, overviewData, filesOverview, stylePreferences, imChannels, timezone]).slice(0, 12), 16)
          return stylePreferences
        },
        loadImChannels: async identity => {
          if (!await authorizeContext(identity) || !imChannels) throw new CoreError('conflict', '当前运行无权读取 IM 渠道')
          return imChannels
        },
        loadMemory: async identity => {
          if (!await authorizeContext(identity) || !ownerMemory) throw new CoreError('conflict', '当前运行无权读取个人记忆')
          return ownerMemory
        },
        loadKnowledge: async (identity, signal) => {
          if (!await authorizeContext(identity)) throw new CoreError('conflict', '当前运行无权读取知识概览')
          try {
            const entries = await readKnowledgeOverview(ownerId, signal)
            contextRevision = Number.parseInt(digest([memoryRevision, overviewData, filesOverview, stylePreferences, entries, imChannels, timezone]).slice(0, 12), 16)
            return entries.map(item => ({ title: item.title, topic: item.topic, description: item.description }) as Json)
          } catch {
            signal?.throwIfAborted()
            return []
          }
        },
      },
      builder: contextBuilder,
    }, observation)
    let provider: AgentProviderAuxiliaryPorts | undefined
    let reflectionWork: Promise<void> = Promise.resolve()
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
        { ...receipt, ownerId }, reflectionAbort.signal), ownerId)
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
    async function drainImReflections(signal = reflectionAbort.signal) {
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
          WHERE j.owner_id=${owner} AND j.session_id=${Number(sessionId)} AND j.model_identity=${selection.modelIdentity}
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
        WHERE j.owner_id=${owner} AND j.session_id=${Number(sessionId)} AND j.model_identity=${selection.modelIdentity}
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
            const reflection = await runReflection({ ...identity, stableSystem: prompt.trim(), delta, scope: runAccessScope(identity) },
            { outputMode: 'json', maxRetries: 1, maxOutputTokens: 1600 }, {
              provider: provider.reflectionProvider(job.model_identity), digest, nextId: randomUUID,
              async pauseBeforeRetry() {}, diagnostic: () => {},
            }, signalWithTimeout)
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
    async function drainReflections(signal = reflectionAbort.signal) {
      if (!provider) return
      const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
      const claimTime = Date.now()
      const dueBefore = claimTime - PRIVATE_REFLECTION_IDLE_SECONDS * 1000
      const { rows: jobs } = await sql<{ run_id: string; session_id: number; user_message_id: number;
        model_identity: string; assistant_text: string; attempts: number; created_at_ms: number }>`
        WITH eligible AS MATERIALIZED (
          SELECT job.run_id FROM desktop_agent_reflection_jobs job
          WHERE job.user_id=${owner} AND job.session_id=${Number(sessionId)}
            AND job.model_identity=${selection.modelIdentity} AND job.status='queued'
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
    const compaction = createLazyAgentCompactionPort(async () => {
      const identity = boundIdentity
      if (!provider || !identity || !await authorize(identity)) throw new Error('当前运行无权压缩会话')
      const scope = runAccessScope(identity)
      return createAgentCompactionPort({
        provider, identity, modelIdentity: selection.modelIdentity, stableSystem: systemPrompt,
        scope, scopeRevision: scope,
        contextTokens: selection.contextWindow, maxOutputTokens: config.max_tokens ?? DEFAULT_LLM_OUTPUT_TOKENS,
        instruction: readAgentPrompt('compress_conv.md', promptDirectory), digest, nextId: randomUUID,
        async loadTools(signal) {
          signal?.throwIfAborted()
          return (await configuredTools(identity)).map(tool => tool.schema)
        },
        diagnostic: error => { throw error },
      })
    })
    function runAccessScope(identity: RunIdentity) {
      return checkpoint?.context?.accessScopeHash ?? contextAccessScopeHash(identity, selection, digest)
    }
    const interactions = createSqliteInteractionActivator(db, createAgentInteractionDescription({
      confirmation: (tx, identity, request) => {
        const mcpAction = (request.toolCall.input as { action?: unknown } | null)?.action
        const name = request.toolCall.name
        if (Object.hasOwn(canvasConfirmations, name))
          return canvasConfirmations[name as keyof typeof canvasConfirmations].describe(tx, identity, request)
        const handler = request.toolCall.name === 'shell' ? shellConfirmation
          : request.toolCall.name === 'present_file' ? presentConfirmation
          : request.toolCall.name === 'view_image' ? viewImageConfirmation
          : request.toolCall.name === 'delete_event' ? calendarConfirmation
          : request.toolCall.name === 'manage_mcp_servers'
            ? mcpAction === 'add' ? mcpAddConfirmation : mcpAction === 'update' ? mcpUpdateConfirmation : mcpRemoveConfirmation
          : request.toolCall.name === 'delete_knowledge' ? knowledgeConfirmation
          : request.toolCall.name === 'delete_skill' ? skillDeleteConfirmation
          : canonicalAgentToolName(request.toolCall.name) === 'delete_contact' ? clientDeleteConfirmation : confirmation
        return handler.describe(tx, identity, request)
      },
      credential: describeSqliteMcpCredential, authorization: unavailable,
    }, { singleChoiceOnly }))
    const agent = createSqliteAgentRuntime({
      observation,
      db, secret, history: { persistPrivateContext: continuation.persist, onSubagentDeliveryCommitted: scheduleSubagentWake }, admission: {
        onCommitted: identity => notify(Number(identity.sessionId), identity.runId),
        async bindRun(tx, identity, input) {
          if (input.queueClaim) await createSqlAgentPendingQueue(db, 'sqlite', {}).consumeClaim(
            tx, identity.ownerId, Number(identity.sessionId), input.queueClaim.key, input.queueClaim.token,
          )
          if (modelId) await sql`INSERT INTO desktop_agent_run_models(user_id, session_id, run_id, model_id)
            VALUES(${dataContext(identity.ownerId).ownerId.replaceAll('-', '')}, ${identity.sessionId}, ${identity.runId}, ${modelId})`.execute(tx)
        },
      },
      projection: createSqliteInteractionProjection(db, secret),
      context: {
        digest, nextId: randomUUID,
        async load(identity, signal) {
          boundIdentity = identity
          if (groupTools) {
            stylePreferences = await readSqliteAgentStylePreferences(db, identity, signal, preferenceFiles, true)
            if (stylePreferences.group_personality_preference_enabled) {
              const fingerprint = digest(stylePreferences)
              contextRevision = Number.parseInt(fingerprint.slice(0, 12), 16)
              selection.contextScopeKey = `desktop-im-group:${fingerprint}`
            }
            const loaded = await source.load(identity, signal)
            const tools = await configuredTools(identity)
            const memberReminder = await readMemberReminder(identity, signal)
            return { ...loaded, capabilities: { toolNames: tools.map(tool => tool.name), tools },
              input: { ...loaded.input, fixedPrefix: [...loaded.input.fixedPrefix, ...memberReminder] } }
          }
          const turn = await sessionSource.currentTurn(identity, signal)
          const { memory, revision } = await readSqliteAgentMemory(db, ownerId, turn.currentUser?.rawText ?? '', signal, embedding, memoryFiles, resolveProxy)
          if (memoryFiles && embeddingGenerationAtStart === embeddingGeneration) {
            const embeddingChanged = stableJson(memoryEmbedding?.settings ?? null) !== stableJson(embedding ?? null)
              || Boolean(memoryEmbedding?.resolveProxy) !== Boolean(embedding && resolveProxy)
            if (embeddingChanged) {
              memoryEmbedding?.controller.abort()
              memoryEmbedding = embedding ? { settings: embedding, resolveProxy, controller: new AbortController() } : undefined
            }
            if (lastMemoryRevision !== revision || embeddingChanged) {
              // 这里只登记运行时发现的刷新需求，显式记忆写入仍在原事务更新持久队列。
              runMemoryRebuild = { revision, generation: embeddingGenerationAtStart }
            }
          }
          ownerMemory = memory
          memoryRevision = revision
          overviewData = await readSqliteAgentOverviewData(db, identity, timezone, signal)
          stylePreferences = await readSqliteAgentStylePreferences(db, identity, signal, preferenceFiles)
          if (selection.contextPolicy.loadOwnerContext) {
            if (!await authorizeContext(identity)) throw new CoreError('conflict', '当前运行无权读取 IM 渠道')
            imChannels = await readImChannels(signal)
          }
          contextRevision = Number.parseInt(digest([revision, overviewData, filesOverview, stylePreferences, imChannels, timezone]).slice(0, 12), 16)
          const loaded = await source.load(identity, signal)
          const directoryId = selection.workspaceBinding?.directory_id
          if (typeof directoryId === 'string') {
            const instructions = await hostRequest('agent.files.workspaceInstructions', { directoryId }, signal)
            signal?.throwIfAborted()
            if (typeof instructions === 'string')
              loaded.input.systemPrompt = appendWorkspaceAgentInstructions(loaded.input.systemPrompt ?? '', instructions)
          }
          const tools = await configuredTools(identity)
          const toolNames = tools.map(tool => tool.name)
          if (delegation && toolNames.includes('agent_message')) {
            loaded.input.systemPrompt = assembleSubagentCatalog(loaded.input.systemPrompt, builtinSubagentCatalog)
          }
          const catalog = createAgentToolBrief(preferences, tools)
          const mcpReminder = ['search_tools', 'call_tool'].every(name => toolNames.includes(name))
            ? mcpServiceReminder(await mcpRuntime.services(identity.ownerId)) : ''
          const brief = projectAgentToolBrief({ ...catalog, mcpReminder }, toolNames)
          const { providerToolNames } = brief
          const visible = providerToolNames ? tools.filter(tool => providerToolNames.includes(tool.name)) : tools
          return { ...loaded, capabilities: { toolNames, tools, ...brief }, input: {
            ...loaded.input, ...(brief.toolReminder ? { toolReminder: brief.toolReminder } : {}),
            latestToolSchemas: visible.map(tool => ({
              type: 'tool-schema' as const, tool_name: tool.name, schema_digest: digest(tool.schema), schema: tool.schema,
            })),
          } }
        },
        preparation: { buildRag },
        prepareRequest: async (_identity, _signal, context) => {
          const snapshot = context?.sourceEffects?.sessionSnapshot.state
          if (!snapshot) throw new Error('运行缺少会话快照')
          const prepared = contextBuilder.buildRequest(readSessionSnapshot(snapshot), selection, _identity)
          const prefix = buildFixedRequestPrefix(prepared)
          const memberReminder = groupChat ? await readMemberReminder(_identity, _signal) : []
          const legacy = { prefix, dynamicTail: memberReminder }
          if (memberReminder.length && context.prepared.requestPrefixSize === prefix.length
            && context.prepared.requestDigest === digest(legacy)) return legacy
          return { prefix: [...prefix, ...memberReminder], dynamicTail: [] }
        },
        references: withViewImageReferences({ dehydrate: async entry => entry.message, hydrate: async entry => entry.message }),
        async writeSessionTitle(input, complete) {
          const owner = dataContext(input.identity.ownerId).ownerId.replaceAll('-', '')
          const { rows: [admission] } = await sql<{ user_message_id: number }>`
            SELECT user_message_id FROM agent_run_admissions
            WHERE user_id=${owner} AND session_id=${sessionId} AND run_id=${input.identity.runId}`.execute(db)
          if (admission && await createFirstTurnTitleWriter(db, 'sqlite')({
            identity: input.identity, anchorMessageId: String(admission.user_message_id), reply: input.text, locale: selection.locale, complete,
          })) notify(sessionId, input.identity.runId)
        },
        async persistCompaction(state) {
          if (!groupChat || !memoryFiles) return
          const ids = state.compactions.flatMap(item => item.result.changed ? item.result.coversUntilMessageIds : [])
          if (!ids.length) return
          const owner = dataContext(state.identity.ownerId).ownerId.replaceAll('-', '')
          await sql`INSERT INTO desktop_im_reflection_triggers(owner_id,session_id,requested_sequence)
            SELECT ${owner},s.id,MAX(m.conversation_seq) FROM conversation_sessions s
            JOIN conversation_messages m ON m.session_id=s.id AND m.role='user' AND m.canonical_batch_id IS NULL
            WHERE s.user_id=${owner} AND s.id=${Number(state.identity.sessionId)}
              AND m.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
            GROUP BY s.id
            ON CONFLICT(owner_id,session_id) DO UPDATE SET
              requested_sequence=MAX(desktop_im_reflection_triggers.requested_sequence,excluded.requested_sequence)`.execute(db)
          scheduleReflectionRecovery(0)
        },
        compaction, finalization: { complete: async input => {
          if (groupChat) await enqueueImReflection(input.identity, input.text, input.modelIdentity)
          else await enqueueReflection(input.identity, input.text, input.modelIdentity, input.hadTools)
          if (groupChat) reflectionWork = reflectionWork.then(() => drainReflections()).then(() => memoryFiles?.flush()).catch(() => {})
        } }, currentRequest: () => null,
        stageContinuation: unavailable, releaseContinuations: async () => {}, diagnoseCompactionFailure: () => {},
      },
      executor: { authorize: unavailable, executor: { execute: unavailable } },
      runtime: {
        clock: { now: () => new Date().toISOString() },
        tools: {
          ...(groupTools?.tools ?? mcpTools.tools),
          async resolveCall(call, identity, signal) {
            const target = resolveCallTool(call)
            if ('error' in target) return target
            if (!await mayForward(target.call.name, identity, signal)) return { error: '工具不存在或未开放' }
            return { call: { ...target.call, adapter: 'call_tool' } }
          },
          async dispatch(call, scope) {
            if (groupTools) return groupTools.tools.dispatch(call, scope)
            if (delegation && delegationNames.has(call.name)) {
              if (!(await configuredAgentTools([call.name], scope.signal)).length) return rejectAdapterCall('工具不存在或未开放')
              return delegation.tools.dispatch(call, scope)
            }
            if (call.adapter === 'call_tool' && !await mayForward(call.name, scope.identity, scope.signal))
              return rejectAdapterCall('工具不存在或未开放')
            return mcpTools.tools.dispatch(call, {
              ...scope, discoverRelatedTools: lookup => configuredTools(scope.identity, lookup),
            })
          },
          async reconcile(call, identity) {
            if (groupTools) return groupTools.tools.reconcile(call, identity)
            if (delegation && delegationNames.has(call.name)) return delegation.tools.reconcile(call, identity)
            if (unavailableSearch.has(call.name)) {
              if (call.adapter === 'call_tool' && !await mayForward('call_tool', identity)) return { kind: 'unknown' }
              return searchRecovery.reconcile(call, identity)
            }
            if (call.adapter === 'call_tool' && !await mayForward(call.name, identity)) return { kind: 'unknown' }
            return mcpTools.tools.reconcile(call, identity)
          },
        },
        interactions,
        sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(),
        presentError: error => error instanceof ProviderError ? { code: error.code, text: providerErrorMessage(error) }
          : { code: 'agent_failed', text: '生成失败，请稍后重试' },
        presentToolResult: async value => value, publish: async event => { notify(sessionId, event.identity.runId) },
        log: agentLog.log, diagnose: agentLog.diagnose,
      },
      provider: {
        continuationStore: continuation.store,
        resolve: async identity => {
          if (identity.ownerId !== ownerId || identity.sessionId !== String(sessionId)) throw new ProviderError('input_rejected')
          return { modelIdentity: selection.modelIdentity, accessScopeHash: runAccessScope(identity), config, systemPrompt }
        },
        transportFactory: createNodeProviderTransportFactory(desktopModelTransportOptions(config, resolveProxy)),
      },
    })
    provider = agent.provider
    return { kind: 'run' as const, agent, checkpoint, recoverReflections: drainReflections, drainReflections: async () => {
      await reflectionWork
    } }
  }

  async function createRunRuntime(...args: [sessionId: number, config: ProviderConfig, embedding?: RagQueryEmbeddingSettings,
    interactive?: boolean, resumeIdentity?: RunIdentity, modelId?: string, locale?: string]) {
    const prepared = await prepareRunRuntime(...args)
    if (prepared.kind !== 'run') throw new CoreError('invalid_request', 'Agent 运行配置无效')
    return prepared
  }

  async function runModel(sessionId: number, runId: string) {
    const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
    const { rows: [row] } = await sql<{ model_id: string }>`SELECT model_id FROM desktop_agent_run_models
      WHERE user_id=${owner} AND session_id=${sessionId} AND run_id=${runId}`.execute(db)
    return row?.model_id ?? null
  }

  async function resumeCheckpoint(checkpoint: RunCheckpoint<CanonicalRunContext>, signal: AbortSignal) {
    if (!checkpoint.context || signal.aborted) return false
    const identity = checkpoint.identity
    const sessionId = Number(identity.sessionId)
    const modelId = await runModel(sessionId, identity.runId)
    const config = await hostRequest('agent.memory.resolveReflectionModel', {
      modelIdentity: checkpoint.context.modelIdentity, modelId,
    }, signal) as ProviderConfig | null
    if (!config || reflectionModelIdentity(config) !== checkpoint.context.modelIdentity) return false
    signal.throwIfAborted()
    const embedding = await hostRequest('agent.memory.resolveEmbedding', {}, signal) as RagQueryEmbeddingSettings | null
    signal.throwIfAborted()
    const { agent, drainReflections } = await createRunRuntime(sessionId, config, embedding ?? undefined, true, identity, modelId ?? undefined)
    const iterator = agent.harness.resume(identity)
    try {
      let event = await iterator.next()
      while (!event.done && (event.value.sequence <= checkpoint.sequence
        || event.value.type !== 'run_resumed' && event.value.type !== 'final')) event = await iterator.next()
      if (event.done) {
        await agent.close()
        return false
      }
    } catch (error) {
      await iterator.return(undefined as never)
      await agent.close()
      throw error
    }
    const done = (async () => {
      try {
        for await (const _event of iterator) { /* 驱动运行继续提交事件。 */ }
        await drainReflections()
      } finally {
        try { await agent.close() }
        finally {
          if (running.get(sessionId)?.runId === identity.runId) running.delete(sessionId)
          notify(sessionId, identity.runId)
        }
      }
    })()
    running.set(sessionId, { runId: identity.runId, cancel: () => agent.service.cancel(ownerId, sessionId), done })
    runTasks.add(done)
    void done.finally(() => runTasks.delete(done)).catch(() => {})
    return true
  }

  function scheduleSubagentWake(parent: RunIdentity) {
    if (parent.ownerId !== ownerId || subagentWakeAbort.signal.aborted) return
    const key = parent.sessionId
    const previous = subagentWakes.get(key)
    const wake = Promise.resolve(previous).then(async () => {
      const sessionId = Number(parent.sessionId)
      const active = running.get(sessionId)
      if (active) await Promise.allSettled([active.done])
      if (running.has(sessionId) || subagentWakeAbort.signal.aborted) return
      const { rows: [admission] } = await sql<{ run_id: string }>`SELECT a.run_id FROM agent_run_admissions a
        JOIN conversation_sessions s ON s.id=a.session_id AND s.user_id=a.user_id AND s.active_run_id=a.run_id
        LEFT JOIN agent_run_controls c ON c.user_id=a.user_id AND c.session_id=a.session_id AND c.run_id=a.run_id
        WHERE a.user_id=${dataContext(ownerId).ownerId.replaceAll('-', '')} AND a.session_id=${sessionId}
          AND COALESCE(c.cancel_requested,0)=0`.execute(db)
      if (!admission) return
      const recipient = { ...parent, runId: admission.run_id }
      const secret = await loadSqliteAgentRunSecret(db, databasePath)
      const store = createSqliteAgentRunStore<CanonicalRunContext>(db, secret, {
        async writeHistory() { throw new Error('只读子运行唤醒不接受历史写入') },
      })
      const checkpoint = await store.read(recipient)
      if (checkpoint?.status !== 'waiting') return
      if (checkpoint.agentInboxWaiting && checkpoint.phase === 'decision' && await store.hasPendingSubagents?.(recipient)) return
      const ready = checkpoint.subagentWaitChildId
        ? !await store.isSubagentPending(recipient, checkpoint.subagentWaitChildId)
        : checkpoint.agentInboxWaiting && Boolean((await store.readAgentInbox?.(recipient))?.length
          || (await store.readSubagentFinals?.(recipient))?.length)
      if (ready) await resumeCheckpoint(checkpoint, AbortSignal.any([subagentWakeAbort.signal, AbortSignal.timeout(5_000)]))
    }).catch(() => {
      // 已提交的等待和终态继续保留，供独占启动恢复。
      notify(Number(parent.sessionId), parent.runId)
    }).finally(() => {
      if (subagentWakes.get(key) === wake) subagentWakes.delete(key)
    })
    subagentWakes.set(key, wake)
  }

  async function readImChannels(signal?: AbortSignal) {
    const snapshot: unknown = await hostRequest('agent.im.snapshot', {}, signal)
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
      throw new CoreError('storage_error', '桌面 IM 渠道状态无效')
    const record = snapshot as Record<string, unknown>
    return Object.fromEntries(['feishu', 'qq', 'wechat', 'telegram'].map(platform => {
      const enabled = record[platform]
      if (typeof enabled !== 'boolean') throw new CoreError('storage_error', '桌面 IM 渠道状态无效')
      return [platform, enabled]
    }))
  }

  const scheduledAgent = createDesktopScheduledAgent({
    core, promptDirectory, observation, filterTools: configuredAgentTools,
    model: () => hostRequest('agent.schedules.model', {}) as Promise<ProviderConfig>,
    ...scheduledImContext,
    async deliverIm(target, text) { await hostRequest('agent.schedules.im.deliver', { target, text }, AbortSignal.timeout(30_000)) },
    loadGroupStyle: (identity, signal) => readSqliteOwnerStylePreferences(db, identity.ownerId, signal, preferenceFiles, true),
    contextData: {
      loadImChannels: (_identity, signal) => readImChannels(signal),
      loadStylePreferences: (identity, signal) => readSqliteOwnerStylePreferences(db, identity.ownerId, signal, preferenceFiles),
      async loadMemory(identity, signal, query = '') {
        const active = signal ?? new AbortController().signal
        await memoryFiles?.flush()
        const embedding = await hostRequest('agent.memory.resolveEmbedding', {}, active) as RagQueryEmbeddingSettings | null
        return (await readSqliteAgentMemory(db, identity.ownerId, query, active, embedding ?? undefined,
          memoryFiles, scheduledAgentProxy)).memory
      },
    },
    resolveProxy: scheduledAgentProxy,
  })
  async function scheduledAgentProxy(url: URL, signal?: AbortSignal) {
    const preferences = await createDesktopAppearanceService(createKyselyPreferenceDocumentStore(db, 'sqlite')).get(ownerId)
    return preferences.useSystemProxy
      ? (await hostRequest('network.resolveProxy', { origin: url.origin }, signal) as ProxyEndpoint | null) ?? undefined
      : undefined
  }
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
          const { agent, recoverReflections } = await createRunRuntime(row.session_id, config, undefined, false, undefined, row.model_id ?? undefined)
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
    async runScheduledInstruction(...args: Parameters<typeof scheduledAgent>) {
      const result = scheduledAgent(...args)
      const done = result.then(() => {}, () => {})
      runTasks.add(done)
      try { return await result }
      finally { runTasks.delete(done) }
    },
    async listBuiltinTools() {
      const prepared = await prepareRunRuntime(null, null, undefined, true)
      if (prepared.kind !== 'catalog') throw new CoreError('invalid_request', 'Agent 工具目录无效')
      return prepared.catalog
    },
    async reconcileInterruptedRuns() {
      // 暂存回收独立于会话恢复，目录繁忙时留到下一次启动。
      void cleanupDesktopDownloadStaging(dirname(databasePath)).catch(() => undefined)
      const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
      // 独占启动时，旧进程已无法提交反思；恢复认领且不增加已消耗的尝试次数。
      await sql`UPDATE desktop_agent_reflection_jobs
        SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
          claimed_at_ms=NULL,last_error='reflection_interrupted'
        WHERE user_id=${owner} AND status='processing'`.execute(db)
      await sql`UPDATE desktop_im_reflection_jobs
        SET status=CASE WHEN attempts>=3 AND NOT EXISTS(SELECT 1 FROM desktop_im_reflection_plans p
          WHERE p.owner_id=desktop_im_reflection_jobs.owner_id AND p.session_id=desktop_im_reflection_jobs.session_id
            AND p.run_id=desktop_im_reflection_jobs.run_id AND p.scope_type=desktop_im_reflection_jobs.scope_type
            AND p.scope_id=desktop_im_reflection_jobs.scope_id AND p.payload IS NOT NULL) THEN 'failed' ELSE 'queued' END,
          claimed_at_ms=NULL,last_error='reflection_interrupted'
        WHERE owner_id=${owner} AND status='processing'`.execute(db)
      const signal = AbortSignal.timeout(5_000)
      const { deepResearch, similarImageSearch } = paidSearchTools(signal)
      const recovery = createToolRegistry({ tools: [deepResearch, similarImageSearch], authorize: authorizeSearchRecovery })
      let childSecret: string | undefined
      await settleExclusiveSqliteAgentRuns(db, databasePath, ownerId, (call, identity) =>
        signal.aborted ? Promise.resolve({ kind: 'unknown' }) : recovery.tools.reconcile(call, identity),
      checkpoint => resumeCheckpoint(checkpoint, signal), async (identity, source) => {
        if (source !== 'subagent') return false
        childSecret ??= await loadSqliteAgentRunSecret(db, databasePath)
        await dispatchAdmittedChild(childSecret, identity)
        return true
      })
    },
    resumeReflections,
    invalidateEmbedding() {
      embeddingGeneration++
      memoryEmbedding?.controller.abort()
      memoryEmbedding = undefined
    },
    async start(sessionId: number, text: string, clientId: string, config: ProviderConfig, embedding?: RagQueryEmbeddingSettings, interactive = false, modelId?: string,
      attachments: string[] = [], references: DesktopAgentChatReference[] = [], queueClaim?: { key: number; token: string }, locale?: string,
      groupSender?: DesktopGroupSender, resumePassiveMessage = false) {
      if (responding.has(sessionId)) throw new CoreError('busy', '会话已有运行中的任务')
      const active = await admission.active(ownerId, sessionId)
      if (active?.identity && running.has(sessionId)) throw new CoreError('busy', '会话已有运行中的任务')
      if (active?.identity) await settleClosedSqliteInteraction(db, databasePath, active.identity)
      const { agent, drainReflections } = await createRunRuntime(sessionId, config, embedding, interactive, undefined, modelId, locale)
      try {
        const stream = await agent.service.start(ownerId, { session_id: sessionId, message: text,
          client_message_id: clientId, attachments, references, queueClaim, groupSender, resumePassiveMessage }, undefined)
        const iterator = stream[Symbol.asyncIterator]()
        const first = await iterator.next()
        if (first.done || typeof first.value.run_id !== 'string') throw new Error('运行确认缺失')
        const runId = first.value.run_id
        const done = (async () => {
          try {
            while (true) {
              const next = await iterator.next()
              if (next.done) break
              if (next.value.type === 'final') {
                try { await drainReflections() }
                catch { /* 反思失败不能改变已经完成的主回答。 */ }
              }
            }
          }
          finally {
            try { await agent.close() }
            finally {
              if (running.get(sessionId)?.runId === runId) running.delete(sessionId)
              notify(sessionId, runId)
            }
          }
        })()
        runTasks.add(done)
        void done.finally(() => runTasks.delete(done)).catch(() => {})
        running.set(sessionId, { runId, cancel: () => agent.service.cancel(ownerId, sessionId), done })
        return first.value
      } catch (error) {
        await agent.close()
        throw error
      }
    },
    runModel,
    async respond(sessionId: number, runId: string, promptId: number, eventId: string,
      reply: { token: string; selectedOptionIds?: string[]; customAnswer?: string } | { text: string } | { secrets: Record<string, string> | null } | null, config: ProviderConfig, embedding?: RagQueryEmbeddingSettings) {
      if (responding.has(sessionId)) throw new CoreError('busy', '正在提交交互回复')
      responding.add(sessionId)
      try {
        const identity = { ownerId, sessionId: String(sessionId), runId }
        const secret = await loadSqliteAgentRunSecret(db, databasePath)
        const deliveries = createSubagentDeliveryStore(db, secret, undefined, 'sqlite')
        const delegated = await deliveries.findWaitingInteraction(identity, promptId)
        if (delegated) {
          const store = createSqliteAgentRunStore<CanonicalRunContext>(db, secret, { async writeHistory() {} })
          const child = await store.read(delegated.identity)
          if (child?.status !== 'waiting' || child.pending?.id !== delegated.interactionId)
            throw new CoreError('conflict', '子运行交互已失效')
          const result = await consumeSqliteInteraction(db, delegated.identity, promptId, reply, eventId,
            { id: delegated.interactionId, version: child.version },
            reply && 'secrets' in reply ? createDesktopMcpCrypto(databasePath).encrypt : undefined,
            async tx => (await deliveries.findWaitingInteraction(identity, promptId, tx))?.interactionId === delegated.interactionId)
          notify(sessionId, runId, true)
          if (result.resolution) scheduleAdmittedRuns(secret)
          return { runId, awaitingText: result.awaitingText }
        }
        const active = running.get(sessionId)
        if (active && active.runId !== runId) throw new CoreError('conflict', '会话运行已变更')
        const { agent, checkpoint, drainReflections } = await createRunRuntime(sessionId, config, embedding, true, identity,
          await runModel(sessionId, runId) ?? undefined)
        try {
          if (checkpoint?.status !== 'waiting' || !checkpoint.pending)
            throw new CoreError('conflict', '运行没有等待回复的交互')
          const outcome = await consumeSqliteInteraction(db, identity, promptId, reply, eventId, {
            id: checkpoint.pending.id, version: checkpoint.version,
          }, reply && 'secrets' in reply ? createDesktopMcpCrypto(databasePath).encrypt : undefined)
          if (!outcome.resolution) {
            await agent.close()
            return { runId, awaitingText: true }
          }
          await active?.done
          const resolution = outcome.resolution
          const iterator = agent.harness.resume(identity, resolution)
          try {
            let event = await iterator.next()
            while (!event.done && event.value.type !== 'final' && !(event.value.type === 'interaction_resolved'
              && event.value.payload.interactionId === resolution.interactionId))
              event = await iterator.next()
            if (event.done) throw new CoreError('conflict', '交互运行无法恢复')
          } catch (error) {
            await iterator.return(undefined as never)
            throw error
          }
          const done = (async () => {
            try {
              for await (const _event of iterator) { /* 驱动运行继续提交事件。 */ }
              try { await drainReflections() }
              catch { /* 反思失败不能改变已经完成的主回答。 */ }
            } finally {
              try { await agent.close() }
              finally {
              if (running.get(sessionId)?.runId === runId) running.delete(sessionId)
              notify(sessionId, runId)
            }
            }
          })()
          running.set(sessionId, { runId, cancel: () => agent.service.cancel(ownerId, sessionId), done })
          runTasks.add(done)
          void done.finally(() => runTasks.delete(done)).catch(() => {})
          return { runId, awaitingText: false }
        } catch (error) {
          await agent.close()
          if (error instanceof InteractionConsumeError || error instanceof InteractionTextError)
            throw new CoreError('conflict', error.message)
          throw error
        }
      } finally { responding.delete(sessionId) }
    },
    async notifyCancel(sessionId: number, runId: string) {
      const run = running.get(sessionId)
      if (run?.runId === runId) await run.cancel()
      const identity = { ownerId, sessionId: String(sessionId), runId }
      await subagents?.cancelChildren(identity)
      if (await settleCancelledSqliteSubagentWait(db, databasePath, identity)
        || await settleClosedSqliteInteraction(db, databasePath, identity))
        notify(sessionId, runId)
    },
    async close() {
      subagentWakeAbort.abort()
      retentionAbort.abort()
      if (retentionTimer) clearTimeout(retentionTimer)
      for (const timer of interactionExpirations.values()) clearTimeout(timer)
      interactionExpirations.clear()
      reflectionAbort.abort()
      if (reflectionTimer) clearTimeout(reflectionTimer)
      await reflectionRecovery
      ragWorkerStopped = true
      ragWorkerAbort.abort(new Error('桌面 RAG Worker 已停止'))
      if (ragWorkerTimer) clearTimeout(ragWorkerTimer)
      ragWorkerResolveWait?.()
      await ragWorkerTask
      await memoryWarmup
      await drainAgentRuns([...runTasks], () => Promise.allSettled([...running.values()].map(run => run.cancel())))
      await Promise.allSettled([...subagentWakes.values()])
    },
  }
}

export const desktopAgentRuntimeModule = {
  createDesktopAgentRuns,
  DesktopAgentCoreError: CoreError,
} satisfies DesktopAgentRuntimeModule

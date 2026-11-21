import type { RagQueryEmbeddingSettings } from '../agent/rag/query-embedding.js'
import type { DesktopGroupSender } from '../agent/run/sqlite-admission.js'
import type { AgentObservationPort } from '../agent/observation.js'
import type { DesktopAgentChatReference } from '../contracts/desktop.js'
import type { ProviderConfig } from '../agent/providers/contracts.js'
import type { SqlDataRuntime } from '../data/runtime.js'
import type { DesktopMemoryFiles } from '../agent/memory/desktop-files.js'
import type { CoreError } from '../contracts/error.js'

/** 平台 Agent 装配口；Core Worker 只依赖行为契约，不导入 Desktop 实现。 */
export interface DesktopAgentRuntimePort {
  listBuiltinTools(): Promise<Array<{ name: string; description: string; enabled: boolean }>>
  reconcileInterruptedRuns(): Promise<void>
  resumeReflections(): void
  invalidateEmbedding(): void
  start(sessionId: number, text: string, clientId: string, config: ProviderConfig,
    embedding?: RagQueryEmbeddingSettings, interactive?: boolean, modelId?: string,
    attachments?: string[], references?: DesktopAgentChatReference[], queueClaim?: { key: number; token: string },
    locale?: string, groupSender?: DesktopGroupSender): Promise<unknown>
  runModel(sessionId: number, runId: string): Promise<string | null | undefined>
  respond(sessionId: number, runId: string, promptId: number, eventId: string,
    reply: { token: string; selectedOptionIds?: string[]; customAnswer?: string } | { text: string } | { secrets: Record<string, string> | null } | null,
    config: ProviderConfig, embedding?: RagQueryEmbeddingSettings): Promise<unknown>
  notifyCancel(sessionId: number, runId: string): Promise<void>
  close(): Promise<void>
}

export interface DesktopAgentRuntimeModule {
  DesktopAgentCoreError: typeof CoreError
  createDesktopAgentRuns(core: SqlDataRuntime, databasePath: string, ownerId: string,
    notify: (sessionId: number, runId: string) => void,
    hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
    memoryFiles?: DesktopMemoryFiles, observation?: AgentObservationPort,
    promptDirectory?: string): DesktopAgentRuntimePort
}

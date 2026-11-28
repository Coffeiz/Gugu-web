import { createCompactionSummarizer } from './compaction.js'
import type { AgentProviderAuxiliaryPorts } from '../runtime.js'
import type { RunIdentity, SummaryGenerationConfig } from '../models.js'
import type { BranchPorts, CompactionPort, SummaryGenerationPorts } from '../ports.js'

/** Python `_COMPRESS_PROMPT_FALLBACK` 的跨 Host 默认摘要指令。 */
export const DEFAULT_AGENT_COMPACTION_INSTRUCTION = '请将历史对话压缩为供后续任务继续使用的中文状态摘要，并严格按“### 1. 对话摘要、### 2. 当前任务、### 3. 遗留问题、### 4. 重要决策与约束、### 5. 关键细节”分章节输出。保留用户目标、关键经历、已确认事实、决定、已完成/未完成状态、阻塞原因和待确认事项。默认丢弃附件、引用、完整工具参数、原始 JSON、URL 和中间调用，只保留会影响后续工作的结论。不确定内容标记为待确认，不要把口头说明写成已完成；只输出摘要正文。'

export interface AgentCompactionOptions {
  provider: AgentProviderAuxiliaryPorts
  identity: RunIdentity
  modelIdentity: string
  stableSystem: string
  loadTools(signal?: AbortSignal): Promise<SummaryGenerationConfig['tools']>
  scope: string
  scopeRevision: string | null
  contextTokens: number
  maxOutputTokens: number
  instruction: string
  digest: BranchPorts<unknown>['digest']
  nextId: BranchPorts<unknown>['nextId']
  diagnostic: BranchPorts<unknown>['diagnostic']
}

/** 延迟绑定摘要端口；同一 Run 内并发首次压缩共享初始化，初始化失败允许后续重试。 */
export function createLazyAgentCompactionPort<Wire>(bind: (signal?: AbortSignal) => Promise<CompactionPort<Wire>>): CompactionPort<Wire> {
  let port: Promise<CompactionPort<Wire>> | null = null
  return {
    async summarize(input, signal) {
      if (!port) {
        port = Promise.resolve().then(() => bind(signal))
      }
      const pending = port
      let bound: CompactionPort<Wire>
      try { bound = await pending }
      catch (error) { if (port === pending) port = null; throw error }
      return bound.summarize(input, signal)
    },
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new Error('操作已取消')) }
    const timer = setTimeout(finish, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

/** Core compaction runtime；身份、模型配置和 Provider 能力必须由可信 Run 装配提供。 */
export function createAgentCompactionPort(options: AgentCompactionOptions): CompactionPort<unknown> {
  if (!options.identity.ownerId || !options.identity.sessionId || !options.identity.runId
    || !options.modelIdentity || !options.stableSystem.trim() || !options.scope.trim()) throw new TypeError('Agent 压缩身份或提示配置无效')
  // 无效预算不需要读取工具授权或初始化 Provider 摘要分支。
  if (!Number.isSafeInteger(options.contextTokens) || options.contextTokens <= 1
    || !Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0)
    return { async summarize() { return '' } }

  return createLazyAgentCompactionPort(async signal => {
    const tools = await options.loadTools(signal)
    const projection = await options.provider.summaryProjection(options.identity, options.modelIdentity, signal)
    const config: SummaryGenerationConfig = {
      ownerId: options.identity.ownerId,
      sessionId: options.identity.sessionId,
      runId: options.identity.runId,
      stableSystem: options.stableSystem,
      tools: [...tools],
      scope: options.scope,
      scopeRevision: options.scopeRevision,
      contextTokens: options.contextTokens,
      maxOutputTokens: options.maxOutputTokens,
      instruction: options.instruction.trim() || DEFAULT_AGENT_COMPACTION_INSTRUCTION,
    }
    const ports: SummaryGenerationPorts<unknown> = {
      provider: options.provider.branchProvider(options.modelIdentity),
      transformProjection: projection.transformProjection,
      digest: options.digest,
      nextId: options.nextId,
      async pauseBeforeRetry(attempt, signal) {
        await abortableDelay(Math.min(1000, 100 * 2 ** Math.max(0, attempt - 1)), signal)
      },
      diagnostic: options.diagnostic,
    }
    return createCompactionSummarizer(config, ports)
  })
}

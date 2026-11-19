import { runContextBranch, type BranchResult, type RunIdentity, type Usage } from '@gugu/core/agent'
import { ProviderRuntime, outputBudget as providerOutputBudget, providerSelection, type ProviderRuntimeOptions } from '@gugu/core/providers'
import type { Pool } from 'pg'
import { RecoverableProviderVersionError, type createReflectionModelScope } from '../../llm/recovery.js'
import type { createConfiguredWebAgentProviderBinding } from '../../llm/configured.js'
import { dateKeyInTimeZone } from '../../../../shared/date-time.js'
import { recordAgentUsage } from '../../run/usage.js'
import type { createPostgresOwnerReflectionSource } from './source.js'
import type { createOwnerReflectionWork } from './work.js'
import { planReflectionEvidence, reflectionWireBytes } from './evidence.js'

type Extract = Parameters<typeof createOwnerReflectionWork>[0]['extract']
type Bind = Awaited<ReturnType<typeof createConfiguredWebAgentProviderBinding>>['bind']

function branchUsage(value: BranchResult['usage']): Usage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { input, output, cacheRead, cacheWrite, contextInput } = value
  if (typeof input !== 'number' || typeof output !== 'number' || typeof cacheRead !== 'number' || typeof cacheWrite !== 'number') return null
  return { input, output, cacheRead, cacheWrite, contextInput: typeof contextInput === 'number' ? contextInput : null }
}

async function meterReflection(pool: Pick<Pool, 'connect'>, identity: RunIdentity, result: BranchResult, model: Awaited<ReturnType<Bind>>) {
  const usage = branchUsage(result.usage)
  if (!usage) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await recordAgentUsage(client, identity, usage, model.usageConfig, [], [], 'reflection')
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
  finally { client.release() }
}

/** 只用原 Run 签名模型和从 PostgreSQL 重读的私聊证据。分支不携带可执行工具。 */
export function createOwnerReflectionExtractor(options: {
  bind: Bind
  modelScope: ReturnType<typeof createReflectionModelScope>
  source: ReturnType<typeof createPostgresOwnerReflectionSource>
  pool: Pick<Pool, 'connect'>
  context: Pick<ProviderRuntimeOptions, 'digest' | 'nextId' | 'references' | 'prepareRequest'>
  transport(config: Awaited<ReturnType<Bind>>['usageConfig']): ProviderRuntimeOptions['transportFactory']
  canSpend(ownerId: string): Promise<boolean>
  readPrompt(): Promise<string>
  timezone: string
  diagnose(): void
}): Extract {
  return async (batch, snapshot, signal) => {
    const turn = batch.turns.at(-1)
    if (!turn?.modelScope) return { kind: 'discard' }
    const identity: RunIdentity = { ownerId: batch.ownerId, sessionId: batch.sessionId, runId: turn.runId }
    let model: Awaited<ReturnType<Bind>>
    try {
      // Redis 分组摘要只用于调度。旧回合须各自通过签名验证，再使用最后一个 Run 恢复该共同模型。
      for (const item of batch.turns) {
        const scope = options.modelScope({ ...identity, runId: item.runId }, item)
        if (scope !== turn.modelScope || item.modelScope !== scope) return { kind: 'discard' }
      }
      model = await options.bind(identity, signal, { identity, ...turn })
    }
    catch (error) {
      if (error instanceof RecoverableProviderVersionError) return { kind: 'discard' }
      throw error
    }
    try {
      if (!await options.canSpend(batch.ownerId)) return { kind: 'defer' }
      const system = (await options.readPrompt()).trim()
      if (!system) throw new Error('个人记忆反思提示词不可用')
      const source = await options.source(batch, signal)
      if (source.kind !== 'ready') return source
      const now = new Date()
      let date = dateKeyInTimeZone(now, options.timezone)
      if (source.timezone) {
        try { date = dateKeyInTimeZone(now, source.timezone) } catch { /* 个人时区无效时使用站点时区。 */ }
      }
      const base = { date, userName: source.userName,
        profile: snapshot.files['profile.json'], pattern: snapshot.files['pattern.json'], summary: snapshot.files['summary.json'] }
      const outputBudget = 1024
      const { config, policy } = providerSelection((await model.resolve(identity, model.modelIdentity, signal)).config)
      const outputReserve = providerOutputBudget(config, policy, outputBudget) ?? outputBudget
      const delta = JSON.stringify({ ...base, turns: source.turns })
      const fits = reflectionWireBytes(system, delta) + outputReserve <= model.contextWindow
      if (!fits && source.turns.length > 1) return { kind: 'split' }
      const provider = new ProviderRuntime({ ...options.context, resolve: model.resolve,
        transportFactory: options.transport(model.usageConfig), diagnose: options.diagnose })
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(90_000)])
      let condensedEvidence = false
      const branch = async (prompt: string, evidence: string, outputMode: 'json' | 'text', maxOutputTokens: number) => {
        deadline.throwIfAborted()
        if (!await options.canSpend(batch.ownerId) || !await batch.isCurrent()) return null
        const result = await runContextBranch({ ...identity, stableSystem: prompt, delta: evidence, tools: [], scope: model.accessScopeHash }, {
          name: 'reflection', outputMode, maxOutputTokens,
        }, {
          provider: provider.branchProvider(model.modelIdentity),
          digest: options.context.digest, nextId: options.context.nextId,
          async pauseBeforeRetry() {}, diagnostic: options.diagnose,
        }, deadline)
        await meterReflection(options.pool, identity, result, model)
        deadline.throwIfAborted()
        // 输出到达模型长度上限时，即便 JSON 仍可解析也不能作为完整证据。
        const metadata = result.usage
        if (metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.incomplete_reason) return null
        return result
      }
      try {
        let result = fits ? await branch(system, delta, 'json', outputBudget) : null
        if (fits && !result) return { kind: 'defer' }
        if (!fits || result?.contextOverflow) {
          if (source.turns.length > 1) return { kind: 'split' }
          const [turn] = source.turns
          if (!turn) return { kind: 'defer' }
          const framing = { ...base, condensedEvidence: true, allowMemoryRemoval: false }
          const remaining = model.contextWindow - outputReserve - reflectionWireBytes(system,
            JSON.stringify({ ...framing, turns: [{ timestamp: turn.timestamp, userMessage: '', assistantReply: '' }] }))
          const fragmentReserve = providerOutputBudget(config, policy, 192) ?? 192
          const evidence = planReflectionEvidence(turn,
            result?.contextOverflow ? Math.floor(model.contextWindow / 2) : model.contextWindow, remaining, fragmentReserve)
          if (!evidence) return { kind: 'defer' }
          const original = options.context.digest(source.turns)
          const checkEvidence = async () => {
            const current = await options.source(batch, deadline)
            if (current.kind !== 'ready') return current.kind
            return options.context.digest(current.turns) === original ? 'ready' : 'defer'
          }
          const summaries: Record<'user' | 'assistant', string[]> = { user: [], assistant: [] }
          for (const fragment of evidence.fragments) {
            const status = await checkEvidence()
            if (status !== 'ready') return { kind: status }
            const compressed = await branch(evidence.system, fragment.delta, 'text', evidence.maxOutputTokens)
            if (compressed?.providerErrorCode) return { kind: 'discard' }
            if (!compressed?.ok || typeof compressed.output !== 'string') return { kind: 'defer' }
            summaries[fragment.role].push(compressed.output)
          }
          const condensed = JSON.stringify({ ...framing, turns: [{ timestamp: turn.timestamp,
            userMessage: summaries.user.join('\n'), assistantReply: summaries.assistant.join('\n') }] })
          if (reflectionWireBytes(system, condensed) + outputReserve > model.contextWindow) return { kind: 'defer' }
          // 摘要只在内存中暂存；原证据已删除、编辑或会话已忙时暂停本次发布。
          const status = await checkEvidence()
          if (status !== 'ready') return { kind: status }
          result = await branch(system, condensed, 'json', outputBudget)
          condensedEvidence = true
        }
        if (result?.providerErrorCode) return { kind: 'discard' }
        if (!result?.ok) return { kind: 'defer' }
        const output = result.output
        return { kind: 'ready', output: condensedEvidence && output && typeof output === 'object' && !Array.isArray(output)
          ? { ...output, profile_remove: [], pattern_remove: [] } : output, time: { now: now.getTime() / 1000, date } }
      } finally { await provider.close() }
    } finally { model.release() }
  }
}

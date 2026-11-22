import { assembleOwnerReflectionInput } from '../scenes/reflection/owner.js'
import type { BranchInput,BranchPolicy,BranchResult,Json,RunIdentity } from '../models.js'
import type { MessageArea } from '../context/history/canonical-history.js'
import { blocks,copy } from '../context/history/canonical-history.js'
import type { BranchPorts } from '../ports.js'
import { recordAgentObservation, type AgentObservationPort } from '../observation.js'
import { isContextOverflowError } from '../context/budget.js'

/** 群聊owner长期记忆只能看到owner原文与本Run私人工具结果，不能吸收群聊助手回复。 */
export function buildOwnerReflectionInput(input: {
  ownerMessage: string
  groupChat: boolean
  reply: string
}, area: MessageArea): {
  userMessage: string
  assistantEvidence: string
} {
  if (!input.groupChat)
    return { userMessage: input.ownerMessage, assistantEvidence: input.reply }
  const results = area.entries.filter(entry => entry.source === 'tool_round').flatMap(entry => blocks(entry.message.content)
    .filter(block => block.type === 'tool_result').map(block => {
      const content = block.content
      if (typeof content === 'string')
        return content
      if (Array.isArray(content))
        return blocks(content).map(part => String(part.text || part.content || '')).filter(Boolean).join('\n')
      return content == null ? '' : String(content)
    })).filter(Boolean)
  return { userMessage: input.ownerMessage, assistantEvidence: results.join('\n\n') || '（只分析当前 owner 发言，不分析群聊助手回复）' }
}

/** 网页和桌面普通对话共用反思调用与观测归属。 */
export async function runPrivateReflection<Wire>(
  input: Pick<BranchInput<Wire>, 'stableSystem' | 'delta' | 'scope'> & RunIdentity,
  policy: Pick<BranchPolicy, 'outputMode' | 'maxOutputTokens'>,
  ports: BranchPorts<Wire>,
  signal: AbortSignal,
  observation?: AgentObservationPort,
  trace?: { identity?: RunIdentity; trigger?: 'idle' },
): Promise<BranchResult> {
  const identity = trace?.identity ?? { ownerId: input.ownerId, sessionId: input.sessionId, runId: `reflection-${ports.nextId()}` }
  const attributes = { scenario: 'reflection', reflection_scope: 'private', trigger_source: trace?.trigger ?? 'unknown', origin_run_id: input.runId }
  recordAgentObservation(observation, { identity, kind: 'run', name: 'started', at: Date.now(), spanId: identity.runId, status: 'running', attributes })
  let result: BranchResult | undefined
  try {
    result = await runReflection(assembleOwnerReflectionInput({ ...input, observationIdentity: identity, tools: [] }), policy, ports, signal)
    return result
  } finally {
    recordAgentObservation(observation, {
      identity, kind: 'run', name: 'finished', at: Date.now(), spanId: identity.runId,
      status: signal.aborted ? 'cancelled' : result?.ok ? 'completed' : 'failed',
      usage: result?.usage && typeof result.usage === 'object' && !Array.isArray(result.usage)
        && typeof result.usage.input === 'number' && typeof result.usage.output === 'number'
        ? { input: result.usage.input, output: result.usage.output,
          cacheRead: Number(result.usage.cacheRead ?? 0), cacheWrite: Number(result.usage.cacheWrite ?? 0),
          contextInput: typeof result.usage.contextInput === 'number' ? result.usage.contextInput : null } : undefined,
      output: { ...attributes, ...(result ? { attempts: result.attempts, probe_eligible: result.usage !== null } : {}) },
    })
  }
}

type ReflectionInput<Wire> = Pick<BranchInput<Wire>,
  keyof RunIdentity | 'stableSystem' | 'delta' | 'scope' | 'scopeRevision' | 'observationIdentity'>

export function runReflection<Wire>(input: ReflectionInput<Wire>, policy: Omit<BranchPolicy, 'name'>,
  ports: BranchPorts<Wire>, signal?: AbortSignal): Promise<BranchResult> {
  const { ownerId, sessionId, runId, stableSystem, delta, scope, scopeRevision, observationIdentity } = input
  return executeModelTask({ ownerId, sessionId, runId, stableSystem, delta, scope, scopeRevision, observationIdentity, tools: [] },
    { ...policy, name: 'reflection' }, ports, 'standalone', signal)
}

export async function runContextBranch<Wire>(source: BranchInput<Wire>, policy: BranchPolicy, ports: BranchPorts<Wire>, signal?: AbortSignal): Promise<BranchResult> {
  return executeModelTask(source, policy, ports, 'append_reuse', signal)
}

async function executeModelTask<Wire>(input: BranchInput<Wire>, policy: BranchPolicy, ports: BranchPorts<Wire>,
  requestMode: BranchResult['metadata']['mode'], signal?: AbortSignal): Promise<BranchResult> {
  const retries = policy.maxRetries ?? 0, mode = policy.outputMode ?? 'json'
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 8)
    throw new Error('分支重试次数超出范围')
  const limit = policy.maxOutputTokens ?? 800
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('分支输出预算无效')
  const result: BranchResult = {
    ok: false, output: null, reason: 'provider_error', attempts: 0, contextOverflow: false, providerErrorCode: null,
    inputFingerprint: ports.digest({ system: input.stableSystem, delta: input.delta, projection: input.projection ?? null, canonicalHistory: input.canonicalHistory ?? [] }),
    outputFingerprint: null, usage: null, metadata: {
      branch: policy.name, mode: requestMode, scope: input.scope ?? '',
      scopeRevision: input.scopeRevision ?? null, sessionId: input.sessionId, runId: input.runId
    }
  }
  for (let attempt = 1;attempt <= retries + 1;attempt++) {
    signal?.throwIfAborted()
    if (attempt > 1)
      await ports.pauseBeforeRetry(attempt, signal)
    signal?.throwIfAborted()
    result.attempts = attempt
    let output: Json
    try {
      const response = await ports.provider.complete({
        ...copy(input), scenario: policy.name, outputMode: mode, maxOutputTokens: limit,
        cacheSingleflight: false
      }, signal)
      signal?.throwIfAborted()
      output = response.output
      result.usage = copy(response.usage)
    }
    catch (error) {
      if (signal?.aborted)
        throw signal.reason
      result.reason = 'provider_error'
      result.contextOverflow = isContextOverflowError(error)
      result.providerErrorCode = ports.provider.isInputRejected(error) ? 'input_sensitive' : null
      ports.diagnostic(error, { branch: policy.name, runFingerprint: ports.digest(input.runId), attempt })
      if (result.providerErrorCode || result.contextOverflow && policy.name === 'compaction')
        break
      continue
    }
    let normalized: Json = output
    if (mode === 'json' && typeof normalized === 'string' && normalized.trim()) {
      try {
        normalized = JSON.parse(normalized) as Json
      }
      catch {
        normalized = output
      }
    }
    const empty = normalized == null || normalized === '' || !!normalized && typeof normalized === 'object' && !Array.isArray(normalized) && Object.keys(normalized).length === 0
    const valid = mode === 'text' ? typeof normalized === 'string' && !!normalized.trim()
      : normalized != null && typeof normalized === 'object' && !Array.isArray(normalized) && Object.keys(normalized).length > 0
    if (!valid) {
      result.reason = empty ? 'output_empty' : 'schema_invalid'
      continue
    }
    result.ok = true
    result.output = copy(normalized)
    result.outputFingerprint = ports.digest(normalized)
    result.reason = 'completed'
    break
  }
  return result
}

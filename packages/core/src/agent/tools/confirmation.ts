import { z } from 'zod'
import type { InteractionResolution, PendingInteraction, ToolCall } from '../models.js'
import type { ToolScope } from './contracts.js'

const text = z.string().min(1)
const bindingSchema = z.object({ ownerId: text, sessionId: text, runId: text, roundId: text, toolCallId: text, toolName: text, normalizedInputDigest: text }).strict()
export type ConfirmationBinding = z.infer<typeof bindingSchema>
const intentSchema = z.object({
  schemaVersion: z.literal(2), binding: bindingSchema,
  intentId: text, interactionId: text, operationId: text,
  purpose: z.enum(['action', 'authorization']), action: text,
  targetsDigest: text, versionsDigest: text, authorizationEpoch: text,
  expiresAt: z.number().finite(),
}).strict()
export type ConfirmationIntent = z.infer<typeof intentSchema>
const receiptSchema = z.object({
  schemaVersion: z.literal(2), intentId: text, interactionId: text, receiptId: text,
  binding: bindingSchema, purpose: z.enum(['action', 'authorization']), action: text,
  status: z.literal('approved'), expiresAt: z.number().finite(),
}).strict()

/** 仅指向受限持久意图，不是可执行授权；领域事务仍须原子核验并 claim。 */
export interface ConfirmationIntentReference { readonly intentId: string; readonly operationId: string }
export interface ConfirmationTargetSnapshot { readonly targetsDigest: string; readonly versionsDigest: string }
export interface ConfirmationGatePorts {
  now(): number
  /** 最新权限判断；拒绝为 null，通过返回授权版本。 */
  authorize(binding: ConfirmationBinding, purpose: ConfirmationIntent['purpose'], action: string, signal: AbortSignal): Promise<string | null>
  /** 可信领域解析精确目标并通过已有安全 store 保存，不能从模型 confirm/targets 建授权。 */
  prepare(binding: ConfirmationBinding, targets: ConfirmationTargetSnapshot, signal: AbortSignal): Promise<unknown>
  /** 通过既有受限 store 查询意图及已验证服务端 receipt；value 不作为凭据。 */
  load(binding: ConfirmationBinding, receipt: { interactionId: string; receiptId: string }, signal: AbortSignal): Promise<unknown>
  /** 重新读取原意图的固定目标，检查当前 owner/版本/级联集合；不能重跑名称选择扩大目标。 */
  inspect(reference: ConfirmationIntentReference, binding: ConfirmationBinding, signal: AbortSignal): Promise<{ targetsDigest: string; versionsDigest: string } | null>
}
export type ConfirmationGateResult<T> = { ok: true; value: T } | { ok: false; code: 'confirmation_rejected' }

function equalBinding(a: ConfirmationBinding, b: ConfirmationBinding): boolean {
  return (Object.keys(a) as (keyof ConfirmationBinding)[]).every(key => a[key] === b[key])
}

/**
 * 仅完成可信意图核验，不消费 claim、不执行业务、不开放 destructive 注册。
 * normalizedInputDigest 必须由可信 handler 对实际规范化输入生成稳定摘要；target snapshot
 * 必须由可信领域读取解析。禁止直接传递模型参数中的digest/confirm/targets，返回意图也不能覆盖真实scope绑定。
 */
export function createConfirmationGate(ports: ConfirmationGatePorts, configuration: { purpose: ConfirmationIntent['purpose']; action: string }) {
  const policy = Object.freeze({ ...configuration })
  const reject = { ok: false, code: 'confirmation_rejected' } as const
  function binding(call: ToolCall, scope: ToolScope, normalizedInputDigest: string): ConfirmationBinding | null {
    const parsed = bindingSchema.safeParse({ ...scope.identity, roundId: scope.roundId, toolCallId: call.id, toolName: call.name, normalizedInputDigest })
    return parsed.success ? Object.freeze(parsed.data) : null
  }
  async function validate(intent: ConfirmationIntent, expected: ConfirmationBinding, targets: ConfirmationTargetSnapshot, signal: AbortSignal): Promise<boolean> {
    const now = ports.now()
    if (!Number.isFinite(now) || signal.aborted || !equalBinding(intent.binding, expected) || intent.purpose !== policy.purpose || intent.action !== policy.action || intent.expiresAt <= now
      || intent.targetsDigest !== targets.targetsDigest || intent.versionsDigest !== targets.versionsDigest) return false
    const epoch = await ports.authorize(expected, policy.purpose, policy.action, signal)
    if (signal.aborted || epoch === null || epoch !== intent.authorizationEpoch) return false
    const current = await ports.inspect({ intentId: intent.intentId, operationId: intent.operationId }, expected, signal)
    const after = ports.now()
    return Number.isFinite(after) && !signal.aborted && intent.expiresAt > after && current !== null && current.targetsDigest === intent.targetsDigest && current.versionsDigest === intent.versionsDigest
  }
  return {
    async prepare(call: ToolCall, scope: ToolScope, normalizedInputDigest: string, targets: ConfirmationTargetSnapshot): Promise<ConfirmationGateResult<PendingInteraction>> {
      try {
        const originalCall = structuredClone(call)
        const expected = binding(originalCall, scope, normalizedInputDigest)
        scope.signal.throwIfAborted()
        if (!expected || !targets.targetsDigest || !targets.versionsDigest || scope.resolution !== null || originalCall.parseError) return reject
        const epoch = await ports.authorize(expected, policy.purpose, policy.action, scope.signal)
        scope.signal.throwIfAborted()
        if (epoch === null) return reject
        const snapshot = Object.freeze({ targetsDigest: targets.targetsDigest, versionsDigest: targets.versionsDigest })
        const parsed = intentSchema.safeParse(await ports.prepare(expected, snapshot, scope.signal))
        scope.signal.throwIfAborted()
        if (!parsed.success) return reject
        const valid = await validate(parsed.data, expected, snapshot, scope.signal)
        scope.signal.throwIfAborted()
        if (!valid) return reject
        return { ok: true, value: { id: parsed.data.interactionId, kind: 'confirmation', toolCall: originalCall } }
      } catch { scope.signal.throwIfAborted(); return reject }
    },
    async verify(call: ToolCall, scope: ToolScope, normalizedInputDigest: string, targets: ConfirmationTargetSnapshot): Promise<ConfirmationGateResult<ConfirmationIntentReference>> {
      try {
        const originalCall = structuredClone(call)
        const expected = binding(originalCall, scope, normalizedInputDigest)
        const resolution: InteractionResolution | null = scope.resolution
        scope.signal.throwIfAborted()
        if (!expected || !targets.targetsDigest || !targets.versionsDigest || originalCall.parseError || resolution?.status !== 'confirmed' || !resolution.receiptId || !resolution.interactionId) return reject
        const epoch = await ports.authorize(expected, policy.purpose, policy.action, scope.signal)
        scope.signal.throwIfAborted()
        if (epoch === null) return reject
        const loaded = z.object({ intent: intentSchema, receipt: receiptSchema }).strict().safeParse(await ports.load(expected, { interactionId: resolution.interactionId, receiptId: resolution.receiptId }, scope.signal))
        scope.signal.throwIfAborted()
        if (!loaded.success) return reject
        const { intent, receipt } = loaded.data
        if (intent.interactionId !== resolution.interactionId || receipt.interactionId !== resolution.interactionId || receipt.receiptId !== resolution.receiptId || receipt.intentId !== intent.intentId || receipt.expiresAt <= ports.now() || receipt.purpose !== policy.purpose || receipt.action !== policy.action || !equalBinding(receipt.binding, expected)) return reject
        const valid = await validate(intent, expected, targets, scope.signal)
        scope.signal.throwIfAborted()
        const verifiedAt = ports.now()
        if (!valid || !Number.isFinite(verifiedAt) || receipt.expiresAt <= verifiedAt) return reject
        return { ok: true, value: { intentId: intent.intentId, operationId: intent.operationId } }
      } catch { scope.signal.throwIfAborted(); return reject }
    },
  }
}

import type { JsonObject, ProviderDriverDependencies } from './contracts.js'
import type { Usage } from '../harness/contracts.js'
import { throwIfCancelled } from './errors.js'

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
export function text(value: unknown): string { return typeof value === 'string' ? value : '' }
export function finite(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null }
export function clone<T>(value: T): T { return structuredClone(value) }
export function object(value: unknown): JsonObject { return clone(record(value)) as JsonObject }
export function abort(signal: AbortSignal): void { throwIfCancelled(signal) }
/** 观测失败不得替换原请求的成功、错误或取消结果。 */
export function observe(action: () => void): void { try { action() } catch { /* 观测端口自行处理故障。 */ } }
export function reportUsage(dependencies: ProviderDriverDependencies, raw: unknown, normalized: Usage): void {
  try { dependencies.onUsage?.(clone(raw ?? null), clone(normalized)) }
  catch (error) { observe(() => dependencies.diagnose?.('provider_usage_sink', error)) }
}

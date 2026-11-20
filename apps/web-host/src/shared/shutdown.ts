import { performance } from 'node:perf_hooks'
import type { RuntimeLog, ShutdownPhase } from '@gugu/log/runtime'

/** 慢阶段持续等待原有清理完成，同时报出当前卡点。 */
export async function shutdownStep<T>(report: RuntimeLog, phase: ShutdownPhase, operation: () => T | Promise<T>, slowMs = 5000): Promise<T> {
  const started = performance.now()
  const details = { phase, pid: process.pid }
  const elapsed = () => ({ ...details, elapsedMs: Math.round(performance.now() - started) })
  report('host.shutdown_phase_started', details)
  const timer = setTimeout(() => report('host.shutdown_phase_slow', elapsed()), slowMs)
  timer.unref()
  try {
    const result = await operation()
    report('host.shutdown_phase_finished', elapsed())
    return result
  } catch (error) {
    report('host.shutdown_phase_failed', { ...elapsed(), error })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

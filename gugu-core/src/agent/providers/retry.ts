import { throwIfCancelled } from './errors.js'
import type { ProviderEvent } from '../harness/contracts.js'
import { classifyProviderError, ProviderError } from './errors.js'

export interface RetryClock {
  now(): number
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>
}
export const retryClock: RetryClock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new ProviderError('cancelled')); return }
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new ProviderError('cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, milliseconds)
    signal.addEventListener('abort', cancel, { once: true })
  }),
}

/** SDK/HTTP层不再嵌套重试；一旦任何输出事实出现，禁止重发整轮。 */
export async function* streamWithRetry(open: () => AsyncIterable<ProviderEvent>, signal: AbortSignal, options: { clock?: RetryClock; maxRetries?: number; intervalMs?: number; maxWallMs?: number } = {}): AsyncGenerator<ProviderEvent> {
  const clock = options.clock ?? retryClock, started = clock.now(), max = options.maxRetries ?? 5, pause = options.intervalMs ?? 5000
  let previousError: ProviderError | null = null
  for (let attempt = 0; ; attempt++) {
    if (previousError && clock.now() - started >= (options.maxWallMs ?? 900_000)) throw previousError
    let emitted = false
    try {
      yield { type: 'usage', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextInput: null } }
      for await (const event of open()) {
        throwIfCancelled(signal)
        if (event.type === 'token' && event.text || event.type === 'complete') emitted = true
        yield event
      }
      return
    } catch (raw) {
      if (signal.aborted) throw new ProviderError('cancelled')
      const error = classifyProviderError(raw)
      if (emitted || error.options.outputStarted || !error.options.retryable || attempt >= max || clock.now() - started >= (options.maxWallMs ?? 900_000)) throw error
      previousError = error
      const errorCode = error.code === 'rate_limit' ? 'rate_limited' : error.code === 'busy' ? 'upstream_busy' : error.code === 'network' ? 'transport' : 'timeout'
      yield { type: 'retry', attempt: attempt + 1, maxRetries: max, nextRetryMs: pause, errorCode }
      await clock.sleep(pause, signal)
    }
  }
}

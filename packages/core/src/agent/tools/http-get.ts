import { setTimeout as sleep } from 'node:timers/promises'
import type { ProviderTransport } from '../providers/contracts.js'
import { ProviderError } from '../providers/errors.js'
import type { HttpGetPort } from './web.js'

const HTTP_GET_MAX_BYTES = 2 * 1024 * 1024
const HTTP_GET_TIMEOUT_MS = 20_000
const HTTP_GET_RETRY_DELAYS = [1000, 2000] as const

/** 通过宿主授权的公网传输执行有界 GET；重定向由工具逐跳重新校验。 */
export function createAgentHttpGetPort(egress: {
  withTransport<T>(signal: AbortSignal, execute: (transport: ProviderTransport) => Promise<T>): Promise<T>
}): HttpGetPort {
  return { async get(input, callerSignal) {
    const deadline = AbortSignal.timeout(HTTP_GET_TIMEOUT_MS)
    const signal = AbortSignal.any([callerSignal, deadline])
    const checkDeadline = () => {
      callerSignal.throwIfAborted()
      if (deadline.aborted) throw new ProviderError('timeout')
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await egress.withTransport(signal, async transport => {
          const response = await transport.request({
            url: input.url, method: 'GET', timeoutMs: 15_000,
            headers: { 'user-agent': 'curl/8', ...(input.headers ?? {}) },
          }, signal)
          const chunks: Uint8Array[] = []
          let size = 0
          try {
            const declared = Number(response.headers['content-length'])
            if (Number.isFinite(declared) && declared > HTTP_GET_MAX_BYTES) {
              await response.cancel()
              return { status: response.status, headers: response.headers, body: new Uint8Array(HTTP_GET_MAX_BYTES + 1) }
            }
            for await (const chunk of response.body) {
              signal.throwIfAborted()
              const accepted = chunk.subarray(0, HTTP_GET_MAX_BYTES + 1 - size)
              chunks.push(accepted)
              size += accepted.byteLength
              if (size > HTTP_GET_MAX_BYTES) { await response.cancel(); break }
            }
            return { status: response.status, headers: response.headers, body: Buffer.concat(chunks, size) }
          } finally { await Promise.resolve(response.cancel()).catch(() => undefined) }
        })
        checkDeadline()
        return result
      } catch (error) {
        checkDeadline()
        const retryable = error instanceof ProviderError && error.options.retryable === true
          && (error.code === 'timeout' || error.code === 'network')
        if (!retryable || attempt >= HTTP_GET_RETRY_DELAYS.length) throw error
        try { await sleep(HTTP_GET_RETRY_DELAYS[attempt], undefined, { signal }) }
        catch { checkDeadline() }
      }
    }
  } }
}

import type { ProviderHttpResponse, ProviderTransport } from '../../providers/contracts.js'

/** 流由调用方消费，消费结束、失败或取消后释放出站连接。 */
export async function openStreamedAgentGet(transport: ProviderTransport, url: string, signal: AbortSignal): Promise<ProviderHttpResponse> {
  let response: ProviderHttpResponse
  try {
    response = await transport.request({ url, method: 'GET', headers: { 'User-Agent': 'Gugu-web/1.0' }, timeoutMs: 30_000 }, signal)
  } catch (error) {
    await transport.close?.()
    throw error
  }
  let closing: Promise<void> | undefined
  function close(reason?: unknown) {
    closing ??= Promise.resolve().then(() => response.cancel(reason)).finally(() => transport.close?.())
    return closing
  }
  const abort = () => { void close(signal.reason).catch(() => undefined) }
  if (signal.aborted) {
    await close(signal.reason)
    signal.throwIfAborted()
  }
  signal.addEventListener('abort', abort, { once: true })
  const release = (reason?: unknown) => {
    signal.removeEventListener('abort', abort)
    return close(reason)
  }
  return {
    status: response.status, headers: response.headers,
    body: (async function* () { try { yield* response.body } finally { await release() } })(),
    cancel: release,
  }
}

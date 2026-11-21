import { createNodeProviderTransport, desktopTransportOptions } from '@gugu/core/providers/node'

/** 桌面自托管连接允许用户指定局域网服务器，并共用桌面 DNS 策略。 */
export const directDesktopFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  const { method, signal } = request
  if (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'PUT' && method !== 'DELETE')
    throw new TypeError('不支持的桌面服务器请求方法')
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
  const transport = createNodeProviderTransport(desktopTransportOptions(true))
  try {
    const response = await transport.request({
      url: request.url, method, headers: Object.fromEntries(request.headers), body, allowLocal: true,
    }, signal)
    const { status, headers } = response
    if (status >= 300 && status < 400) {
      await response.cancel()
      throw new TypeError('桌面服务器请求不允许重定向')
    }
    if (status === 204 || status === 205) {
      await response.cancel()
      await transport.close()
      return new Response(null, { status, headers })
    }
    const iterator = response.body[Symbol.asyncIterator]()
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await iterator.next()
          if (!chunk.done) controller.enqueue(chunk.value)
          else {
            await transport.close()
            controller.close()
          }
        } catch (error) {
          await transport.close()
          controller.error(error)
        }
      },
      async cancel(reason) {
        try { await response.cancel(reason) }
        finally { await transport.close() }
      },
    }), { status, headers })
  } catch (error) {
    await transport.close()
    throw error
  }
}

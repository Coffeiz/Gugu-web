import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

export type DesktopCliCommand = (id: number, input: Record<string, unknown>, collection: string, offset: number) => Promise<unknown>

export function startDesktopCli(port: number, token: string, commands: ReadonlyMap<string, DesktopCliCommand>) {
  if (!Number.isInteger(port) || (port !== 0 && port < 1024) || port > 65535 || !/^[A-Za-z0-9_-]{32,}$/.test(token))
    throw new Error('桌面 CLI 端口或令牌无效')

  const expected = Buffer.from('Bearer ' + token)
  const server = createServer({ requestTimeout: 15_000 }, async (request, response) => {
    const reply = (status: number, data: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(data))
    }
    const authorization = Buffer.from(request.headers.authorization ?? '')
    if (authorization.length !== expected.length || !timingSafeEqual(expected, authorization))
      return reply(401, null)

    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const match = /^\/api\/v1\/(projects|calendar|note|canvas|schedule)(?:\/([1-9][0-9]*)(\/(?:restore|items|relations))?)?$/.exec(url.pathname)
      if (!match) return reply(404, null)
      const id = Number(match[2] ?? 0)
      if (!Number.isSafeInteger(id)) return reply(422, null)
      const operation = request.method + (id ? '/id' + (match[3] ?? '') : '')
      const key = match[1] + ':' + operation
      const command = commands.get(key)
      if (!command) return reply(405, null)

      let input: Record<string, unknown> = {}
      if (operation === 'POST' || operation === 'PATCH/id' || key === 'calendar:DELETE/id') {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 1024 * 1024) return reply(413, null)
          chunks.push(chunk)
        }
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString())
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reply(422, null)
        input = parsed as Record<string, unknown>
      }
      const collection = url.searchParams.get('archived') === 'true' ? 'archived'
        : url.searchParams.get('deleted') === 'true' ? 'deleted' : 'active'
      const offset = Number(url.searchParams.get('offset') ?? '0')
      if (!Number.isSafeInteger(offset) || offset < 0) return reply(422, null)
      reply(200, await command(id, input, collection, offset) ?? null)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      reply(error instanceof SyntaxError || code === 'invalid_request' ? 422
        : code === 'not_found' ? 404 : code === 'conflict' ? 409 : code === 'forbidden' ? 403 : 500, null)
    }
  })
  return new Promise<typeof server>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

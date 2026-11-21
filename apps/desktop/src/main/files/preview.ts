import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { DesktopError, desktopReply } from '../core-host.js'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import type { desktopFiles } from './ipc.js'

type PreviewFiles = Pick<ReturnType<typeof desktopFiles>, 'content' | 'handlers'>

export async function servePreviewFile(req: IncomingMessage, res: ServerResponse, files: PreviewFiles, kind: 'content' | 'upload') {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (kind === 'content') {
    try {
      const response = await files.content(url, req.headers.range ?? null)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (!response.body) { res.end(); return }
      const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      res.once('close', () => stream.destroy())
      stream.on('error', () => res.destroy())
      stream.pipe(res)
    } catch { res.writeHead(404).end() }
    return
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  const reply = await desktopReply(true, async () => {
    const params = url.searchParams
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 32 * 1024 * 1024) throw new DesktopError('invalid_request', '单个文件最大支持 32 MB')
      chunks.push(chunk)
    }
    return files.handlers[DESKTOP_CHANNELS.files]({
      action: 'upload', directoryId: params.get('directoryId') ?? undefined, path: params.get('path'),
      overwrite: params.get('overwrite') === '1', identity: params.get('identity'), data: Buffer.concat(chunks),
    })
  })
  res.end(JSON.stringify(reply))
}

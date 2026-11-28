import { CoreError, type Fields } from '../contracts/index.js'

/** Core 请求帧有固定上限，只在进程内暂存有界的密文分片。 */
export function createDesktopImProjectionTransfer() {
  const uploads = new Map<string, { scope: string; expires: number; total: number; size: number; chunks: string[] }>()
  return function transfer(fields: Fields): Fields | null {
    const { action, uploadId, part, total, chunk, ...rest } = fields
    if (action !== 'stage' && uploadId === undefined) return fields
    const now = Date.now()
    for (const [id, upload] of uploads) if (upload.expires <= now) uploads.delete(id)
    const invalid = () => new CoreError('invalid_request', '本机 IM 检查点分片无效')
    if (typeof uploadId !== 'string' || !/^[a-f0-9-]{36}$/.test(uploadId)) throw invalid()
    const scope = JSON.stringify([fields.platform, fields.connectionId, fields.eventKey, fields.runId])
    const previous = uploads.get(uploadId)
    if (action !== 'stage') {
      if ((action !== 'checkpoint' && action !== 'accepted') || !previous || previous.scope !== scope
        || previous.total !== previous.chunks.length || rest.state !== undefined) throw invalid()
      uploads.delete(uploadId)
      return { ...rest, action, state: previous.chunks.join('') }
    }
    if (typeof part !== 'number' || !Number.isSafeInteger(part) || part < 0
      || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 1 || total > 61 || part >= total
      || typeof chunk !== 'string' || !chunk || chunk.length > 24_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk)
      || (part < total - 1 && (chunk.length !== 24_000 || chunk.includes('=')))) throw invalid()
    if (!previous && (part !== 0 || uploads.size >= 8)) throw invalid()
    const upload = previous ?? { scope, total, expires: now + 60_000, size: 0, chunks: [] }
    if (upload.scope !== scope || upload.total !== total || part !== upload.chunks.length
      || upload.size + chunk.length > 1_450_000) throw invalid()
    upload.chunks.push(chunk)
    upload.size += chunk.length
    uploads.set(uploadId, upload)
    return null
  }
}

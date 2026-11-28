import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { CoreError, dataContext } from '../contracts/index.js'
import { DataImportUploadError, encryptDataImportUpload } from './archive-writer-node.js'
export { dataImportMaxUploadBytes, DataImportUploadError } from './archive-writer-node.js'

export interface DataImportPreflightStore {
  begin(ownerId: string, jobId: string, tokenHash: string, expiresAt: Date): Promise<void>
  finish(ownerId: string, jobId: string, digest: string, stagingKey: string): Promise<'queued' | 'expired' | 'missing'>
  fail(ownerId: string, jobId: string, orphanedStagingKey: string | null): Promise<void>
}

export interface DataImportPreflightStorage {
  put(key: string, content: AsyncIterable<Uint8Array>): Promise<void>
  remove(key: string): Promise<void>
}

export interface DataImportPreflightOptions {
  secretKey: string
  token?: () => string
  jobId?: () => string
  now?: () => Date
  maxBytes?: number
}

export class DataImportPreflightError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message) }
}

const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex')
const stagingKey = (ownerId: string, jobId: string) =>
  `${ownerId.replaceAll('-', '')}/.data-portability/imports/${jobId.replaceAll('-', '')}.gupi`

/** 创建上传任务、加密暂存并交给现有数据导入 Worker 消费。 */
export function createDataImportPreflighter(
  store: DataImportPreflightStore,
  storage: DataImportPreflightStorage,
  options: DataImportPreflightOptions,
) {
  return async (rawOwnerId: string, source: AsyncIterable<Uint8Array>) => {
    const ownerId = dataContext(rawOwnerId).ownerId
    const jobId = (options.jobId ?? randomUUID)().toLowerCase()
    const importToken = (options.token ?? (() => randomBytes(32).toString('base64url')))()
    const now = (options.now ?? (() => new Date()))()
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    const key = stagingKey(ownerId, jobId)
    await store.begin(ownerId, jobId, tokenHash(importToken), expiresAt)

    const stats = { plaintextSize: 0, archiveSha256: null as string | null }
    let attempted = false
    try {
      attempted = true
      await storage.put(key, encryptDataImportUpload(
        source,
        options.secretKey,
        `data-portability-staging:${ownerId.replaceAll('-', '')}:${jobId.replaceAll('-', '')}`,
        stats,
        options.maxBytes,
      ))
      if (!stats.archiveSha256) throw new Error('上传归档摘要缺失')
      const outcome = await store.finish(ownerId, jobId, stats.archiveSha256, key)
      if (outcome === 'expired') throw new CoreError('conflict', '上传任务已过期，请重新上传归档')
      if (outcome === 'missing') throw new CoreError('not_found', '上传任务已结束，不能继续完成预检')
      return { id: jobId, importToken, createdAt: now, expiresAt }
    } catch (error) {
      let orphanedStagingKey: string | null = null
      if (attempted) {
        try { await storage.remove(key) }
        catch { orphanedStagingKey = key }
      }
      try { await store.fail(ownerId, jobId, orphanedStagingKey) } catch { /* 到期清理器可按任务归属回收上传中的对象。 */ }
      if (error instanceof CoreError || error instanceof DataImportUploadError) throw error
      throw new DataImportPreflightError(503, '上传归档暂时失败，请重试')
    }
  }
}

import { createBackgroundWorkerLifecycle } from '../workers/lifecycle.js'
import { Pool } from 'pg'
import { type SqlDataRuntime } from '@gugu/core/data'
import { type WebUiConfig } from '../config.js'
import { createRedisLiveSubscription } from '../adapters/cache/redis-live-subscription.js'
import { startSecurityRetentionWorker } from '../modules/security-events/cleanup.js'
import { startAgentRunRetentionWorker } from '../modules/agent/run/retention.js'
import { startProjectDeleteRecoveryWorker } from '../modules/projects/lifecycle/recovery.js'
import { startAgentRagIndexWorker } from '../modules/agent/rag/rebuild.js'
import { startRagIndexWorker } from '../modules/agent/rag/worker.js'
import { createLocalAgentKnowledgeReadStore } from '../modules/agent/rag/knowledge.js'
import { startTrashPurgeWorker } from '../modules/files/trash/purge.js'
import { startDiskTrashRetentionWorker } from '../modules/files/trash/retention.js'
import { createLocalUndoRetentionStorage } from '../modules/files/storage/undo.js'
import { startUndoRetentionWorker } from '../modules/undo/retention.js'
import { startProjectExpiryWorker } from '../modules/projects/lifecycle/expiry.js'
import { type RedisEventPublisher } from '../adapters/cache/redis-events.js'

interface ScheduledWorker {
  start(): void | Promise<void>
  stop(): Promise<void>
}

export function createWebWorkers(options: {
  config: WebUiConfig
  pool: Pool
  core: SqlDataRuntime
  publisher: RedisEventPublisher
  trashOperations: Parameters<typeof startTrashPurgeWorker>[0]['deletes']
  trashPurgeSchemaApplied: boolean
  projectJournalPool?: Pool
  projectExpiryWorkerEnabled: boolean
  projectPurgeAvailable: boolean
  canRebuildAgentMemoryIndex: () => boolean
  ownerReflectionWork?: Parameters<typeof startRagIndexWorker>[0]['work']
  scheduledRepeatingWorker?: ScheduledWorker
  scheduledOnceWorker?: ScheduledWorker
}) {
  const { config, pool, core, publisher, trashOperations, trashPurgeSchemaApplied, projectJournalPool,
    projectExpiryWorkerEnabled, projectPurgeAvailable, canRebuildAgentMemoryIndex, ownerReflectionWork, scheduledRepeatingWorker, scheduledOnceWorker } = options
  return createBackgroundWorkerLifecycle([
    () => startSecurityRetentionWorker({ pool, onError: () => { console.error('安全事件过期清理失败') } }),
    () => startAgentRunRetentionWorker({ pool, onError: () => { console.error('Agent 运行记录过期清理失败') } }),
    () => process.platform === 'linux' ? startDiskTrashRetentionWorker(pool, config.storageLocalPath,
      () => { console.error('磁盘回收站过期清理失败') }) : null,
    () => trashPurgeSchemaApplied && process.platform === 'linux' ? startTrashPurgeWorker({
      pool, deletes: trashOperations, publisher,
      ...(config.redisUrl ? { subscribe: createRedisLiveSubscription(config.redisUrl) } : {}),
      onError: () => { console.error('回收站清空任务执行失败') },
    }) : null,
    () => startUndoRetentionWorker({
      pool, storage: createLocalUndoRetentionStorage(config.storageLocalPath),
      onError: () => { console.error('撤销操作正文过期清理失败') },
    }),
    () => projectJournalPool ? startProjectDeleteRecoveryWorker({
      pool: projectJournalPool, storageRoot: config.storageLocalPath,
      onError: () => { console.error('项目删除文件日志恢复未完成') },
    }) : null,
    () => projectPurgeAvailable && projectJournalPool ? startProjectExpiryWorker({
      enabled: true, expire: projectExpiryWorkerEnabled, pool: projectJournalPool, storageRoot: config.storageLocalPath,
      defaultLimitBytes: config.storageDefaultLimitBytes,
      onError: () => { console.error('过期项目清理失败') },
    }) : null,
    () => canRebuildAgentMemoryIndex() ? startAgentRagIndexWorker(core, {
      enabled: true, knowledgeStore: createLocalAgentKnowledgeReadStore(config.storageLocalPath),
      memoryStorageRoot: config.storageLocalPath,
      onError: () => { console.error('Agent RAG 索引重建失败') },
    }) : null,
    () => ownerReflectionWork && canRebuildAgentMemoryIndex() ? startRagIndexWorker({
      enabled: true, work: ownerReflectionWork,
      onError: () => { console.error('Web Agent 反思调度失败') },
    }) : null,
    async () => {
      if (!scheduledRepeatingWorker) return null
      await scheduledRepeatingWorker.start()
      return scheduledRepeatingWorker
    },
    () => {
      if (!scheduledOnceWorker) return null
      scheduledOnceWorker.start()
      return scheduledOnceWorker
    },
  ])
}

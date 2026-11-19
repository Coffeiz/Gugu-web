import { createWebRuntimeLog } from '../shared/log-files.js'
import { createNodeImHostRuntime } from '../modules/im/gateway/bootstrap.js'
import { readImRuntimeOwnership } from '../modules/im/gateway/host-runtime.js'
import { createAdminEmailTranslator } from '../modules/admin/email.js'
import { createAdminLlmPresetReader } from '../modules/admin/llm.js'
import { createAdminVoicePresetTestOperations, createAdminVoiceTestOperations } from '../modules/admin/voice.js'
import { createAdminSearchTestOperations } from '../modules/admin/search.js'
import { resolveAdminUpdateMode } from '../modules/admin/runtime.js'
import { createMcpRuntime } from '../modules/mcp/runtime.js'
import { Pool } from 'pg'
import { createPostgresRuntime, type SqlDataRuntime } from '@gugu/core/data'
import { createApp } from '../app.js'
import { loadConfig } from '../config.js'
import { resolveConfigOverridePath } from '../adapters/config/config-override-file.js'
import { hasProjectDeleteJournalSchema } from '../modules/undo/journal.js'
import { checkRagIndexMigration } from '@gugu/database/postgres/migrations/0011_rag_index'
import { checkTrashPurgeMigration } from '@gugu/database/postgres/migrations/0009_trash_purge'
import { checkSearchUsageMigration } from '@gugu/database/postgres/migrations/0010_search_usage'
import { webAgentPromptRoot } from '../modules/agent/context/prompts.js'
import { hasProjectExpiryJournalSchema } from '../modules/projects/lifecycle/expiry.js'
import { createRedisEventPublisher } from '../adapters/cache/redis-events.js'
import { createAdminAuth, createAdminPromptOptions } from './admin.js'
import { createPool } from './postgres.js'
import { booleanSetting } from './settings.js'
import { createWebUiApp } from './app.js'

async function listen(app: ReturnType<typeof createApp>, host: string, port: number): Promise<void> {
  try {
    await app.listen({ host, port })
  } catch (error) {
    await app.close().catch(() => undefined)
    throw new Error('gugu-webui HTTP server failed to listen', { cause: error })
  }
}

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const configOverridePath = resolveConfigOverridePath(env)
  const config = loadConfig(env, configOverridePath)
  const report = createWebRuntimeLog(config.logFile)
  const gatewayLog = createWebRuntimeLog(config.logFile, 'gateway')
  const ownership = readImRuntimeOwnership(env)
  const pool = createPool(config)
  const redisEvents = config.redisUrl ? createRedisEventPublisher(config.redisUrl) : undefined
  let core: SqlDataRuntime
  try {
    core = await createPostgresRuntime({ url: config.databaseUrl, maxConnections: config.postgresPoolMax })
  } catch (error) {
    // 保留 Admin 登录和配置入口，让用户可以修正数据库连接；业务 API 仍由未就绪状态阻断。
    const app = createApp({
      appName: config.appName,
      staticRoot: config.staticRoot,
      isReady: async () => false,
      adminAuth: createAdminAuth(pool, config),
      adminUpdateMode: resolveAdminUpdateMode(env.GUGU_UPDATE_DEPLOYMENT_MODE),
      adminPrompts: createAdminPromptOptions(pool),
      adminConfig: config.configOverridePath ? { path: config.configOverridePath, env } : undefined,
      adminLlmPresetList: config.configOverridePath ? { read: createAdminLlmPresetReader(config.configOverridePath) } : undefined,
      adminEmailTranslate: config.configOverridePath ? { translate: createAdminEmailTranslator(env, config.configOverridePath) } : undefined,
      adminVoiceTest: { test: createAdminVoiceTestOperations(config.configOverridePath, env) },
      adminVoicePresetTest: createAdminVoicePresetTestOperations(config.configOverridePath, env),
      adminSearchTest: { test: createAdminSearchTestOperations(config.configOverridePath, env) },
    })
    app.get('/health/im', async (_request, reply) => ownership.runtime === 'python'
      ? { ownership: 'python', status: 'disabled' }
      : reply.code(503).send({ ownership: 'node', status: 'unavailable' }))
    try {
      await listen(app, config.host, config.port)
    } catch (listenError) {
      await pool.end().catch(() => undefined)
      throw listenError
    }
    report('host.database_unavailable', { error })
    let closePromise: Promise<void> | undefined
    return {
      app,
      pool,
      close() {
        closePromise ??= (async () => {
          await app.close()
          await pool.end()
        })()
        return closePromise
      },
    }
  }
  let canRebuildAgentMemoryIndex = false
  let trashPurgeSchemaApplied = false
  let searchUsageSchemaApplied = false
  let projectJournalPool: Pool | undefined
  let imRuntime: ReturnType<typeof createNodeImHostRuntime> | undefined
  let sharedMcp: ReturnType<typeof createMcpRuntime> | undefined
  let imDeliveryPool: Pool | undefined
  let web: Awaited<ReturnType<typeof createWebUiApp>>
  try {
    try {
      trashPurgeSchemaApplied = await checkTrashPurgeMigration(pool) === 'applied'
    } catch {
      trashPurgeSchemaApplied = false
    }
    try {
      searchUsageSchemaApplied = await checkSearchUsageMigration(pool) === 'applied'
    } catch {
      searchUsageSchemaApplied = false
    }
    // 日志跨事务持有会话锁，使用独立连接池，避免占用本次确认仍需使用的业务连接。
    if (process.platform === 'linux' && core.receipts && await hasProjectDeleteJournalSchema(pool))
      projectJournalPool = createPool(config, 2)
    if (booleanSetting(env.GUGU_WEBUI_PROJECT_EXPIRY_WORKER_ENABLED, undefined, false)
      && (!projectJournalPool || !await hasProjectExpiryJournalSchema(pool)))
      throw new Error('项目过期清理 Worker 需要已迁移的项目日志结构')
    web = await createWebUiApp(config, pool, core, redisEvents, env, () => canRebuildAgentMemoryIndex,
      projectJournalPool, trashPurgeSchemaApplied, searchUsageSchemaApplied, {
        bindMcp(runtime) { sharedMcp = runtime },
        async clearOwner(ownerId, remove) {
          if (imRuntime) await imRuntime.clearOwner(ownerId, remove)
          else await remove()
        },
        removeSession(ownerId, sessionId, ports, legacy) {
          return imRuntime ? imRuntime.removeSession(ownerId, sessionId, ports, legacy) : legacy()
        },
      })
  } catch (error) {
    await projectJournalPool?.end().catch(() => undefined)
    await core.close().catch(() => undefined)
    await pool.end().catch(() => undefined)
    throw error
  }
  const app = web.app
  let ragIndexMigration: 'pending' | 'applied' | 'unavailable'
  try {
    ragIndexMigration = await checkRagIndexMigration(pool)
  } catch (error) {
    ragIndexMigration = 'unavailable'
    report('host.rag_unavailable', { error })
  }
  canRebuildAgentMemoryIndex = ragIndexMigration === 'applied'
  try {
    if (ownership.runtime === 'node') imDeliveryPool = createPool(config, 4)
    const gateway = createNodeImHostRuntime({ pool, deliveryPool: imDeliveryPool ?? pool, core, redisUrl: config.redisUrl,
      secretKey: config.secretKey, storageRoot: config.storageLocalPath, configOverridePath, environment: env,
      promptRoot: webAgentPromptRoot, publicAppUrl: config.publicAppUrl, ownership, mcpRuntime: sharedMcp,
      observation: web.loopScopeTrace?.forSource('im'), log: web.agentRunLog,
      diagnose(code, error) { gatewayLog('gateway.degraded', { code, error }) },
    })
    imRuntime = gateway
    app.get('/health/im', async (_request, reply) => {
      const health = gateway.health()
      const supervisor = health.supervisor as { configuration?: string; notifications?: string; cleanupUnknown?: number; retrying?: number } | null
      const ready = health.status === 'disabled' || health.status === 'running'
        && Object.values(health.loops).every(state => state === 'running')
        && supervisor?.configuration === 'ready' && supervisor.notifications === 'connected'
        && supervisor.cleanupUnknown === 0 && supervisor.retrying === 0
      return ready ? health : reply.code(503).send(health)
    })
    app.addHook('onClose', async () => {
      try {
        await gateway.stop()
        if (ownership.runtime === 'node') gatewayLog('gateway.stopped')
      } catch (error) {
        gatewayLog('gateway.stop_failed', { error })
        throw error
      }
    })
    try {
      await gateway.start()
      if (gateway.health().status === 'running') gatewayLog('gateway.started')
    } catch (error) {
      gatewayLog('gateway.start_failed', { error })
      throw error
    }
    await listen(app, config.host, config.port)
    await web.startWorkers()
    report('host.started')
  } catch (error) {
    await app.close().catch(() => undefined)
    await imDeliveryPool?.end().catch(() => undefined)
    await projectJournalPool?.end().catch(() => undefined)
    await core.close().catch(() => undefined)
    await pool.end().catch(() => undefined)
    throw error
  }

  if (ragIndexMigration === 'pending') console.info('Agent RAG 索引迁移尚未应用，后台重建未启动')
  if (!trashPurgeSchemaApplied || process.platform !== 'linux')
    console.info('回收站清空的 Node 文件后端尚未就绪，清空工具与后台任务未启用')
  if (!searchUsageSchemaApplied)
    console.info('Node 搜索用量迁移尚未应用，深度研究与相似图搜索未启用')
  let closePromise: Promise<void> | undefined
  return {
    app,
    pool,
    close() {
      closePromise ??= (async () => {
        try {
          await app.close()
        } finally {
          await imDeliveryPool?.end()
          await projectJournalPool?.end()
          await core.close()
          await pool.end()
        }
      })()
      return closePromise
    },
  }
}

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { createPostgresRuntime, type SqlDataRuntime } from '@gugu/core/data'
import { createApp, type UserAuthOptions } from './app.js'
import { loadConfig, type WebUiConfig } from './config.js'
import { checkDatabaseReadiness } from './database.js'
import { createUserRepository } from './users.js'
import { createProjectFileCountListing, createProjectGetter, createProjectListing } from './projects.js'
import { createClientOperations } from './clients.js'
import { createEventOperations } from './events.js'
import { createNotificationOperations } from './notifications.js'
import { createTrackOperations } from './track.js'

function createPool(config: WebUiConfig): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.postgresPoolMax,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  })
}

function createUserAuth(pool: Pool, secret: string): UserAuthOptions {
  return { secret, ...createUserRepository(pool) }
}

function createWebUiApp(config: WebUiConfig, pool: Pool, core: SqlDataRuntime) {
  return createApp({
    appName: config.appName,
    async isReady() {
      await checkDatabaseReadiness((statement) => pool.query(statement))
      return true
    },
    onReadinessError: () => console.error('gugu-webui PostgreSQL readiness check failed'),
    userAuth: createUserAuth(pool, config.secretKey),
    listProjects: createProjectListing(core, pool),
    listProjectFileCounts: createProjectFileCountListing(pool),
    getProject: createProjectGetter(core, pool),
    clients: createClientOperations(core),
    events: createEventOperations(pool),
    notifications: createNotificationOperations(pool),
    track: createTrackOperations(pool),
  })
}

async function listen(app: ReturnType<typeof createWebUiApp>, host: string, port: number): Promise<void> {
  try {
    const address = await app.listen({ host, port })
    console.info(`gugu-webui listening at ${address}`)
  } catch {
    await app.close().catch(() => undefined)
    throw new Error('gugu-webui HTTP server failed to listen')
  }
}

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env)
  const pool = createPool(config)
  let core: SqlDataRuntime
  try {
    core = await createPostgresRuntime({ url: config.databaseUrl, maxConnections: config.postgresPoolMax })
  } catch (error) {
    await pool.end().catch(() => undefined)
    throw error
  }
  const app = createWebUiApp(config, pool, core)
  try {
    await listen(app, config.host, config.port)
  } catch (error) {
    await core.close().catch(() => undefined)
    await pool.end().catch(() => undefined)
    throw error
  }

  let closePromise: Promise<void> | undefined
  return {
    app,
    pool,
    close() {
      closePromise ??= (async () => {
        await app.close()
        await core.close()
        await pool.end()
      })()
      return closePromise
    },
  }
}

async function main(): Promise<void> {
  const server = await startServer()
  const shutdown = () => {
    void server.close().catch(() => {
      console.error('gugu-webui shutdown failed')
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    console.error('gugu-webui startup failed')
    process.exitCode = 1
  })
}

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { createApp } from './app.js'
import { loadConfig } from './config.js'

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env)
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.postgresPoolMax,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  })
  const app = createApp({
    appName: config.appName,
    isReady: async () => {
      await pool.query('SELECT 1')
      return true
    },
    onReadinessError: () => console.error('gugu-webui PostgreSQL readiness check failed'),
  })

  try {
    const address = await app.listen({ host: config.host, port: config.port })
    console.info(`gugu-webui listening at ${address}`)
  } catch {
    await app.close().catch(() => undefined)
    await pool.end().catch(() => undefined)
    throw new Error('gugu-webui HTTP server failed to listen')
  }

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

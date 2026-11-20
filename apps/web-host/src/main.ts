import { configureDiagnosticLog, createLogWriter, createWebRuntimeLog, webLogFile } from './shared/log-files.js'
import { timestampConsole } from './shared/logging.js'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { startServer } from './startup/server.js'

export { startServer } from './startup/server.js'

async function main(logFile: string): Promise<void> {
  const report = createWebRuntimeLog(logFile)
  const server = await startServer({ ...process.env, GUGU_LOG_FILE: logFile })
  let stopping = false
  const shutdown = (signal: 'SIGINT' | 'SIGTERM') => {
    if (stopping) return
    stopping = true
    const started = performance.now()
    const details = () => ({ signal, pid: process.pid, elapsedMs: Math.round(performance.now() - started) })
    report('host.shutdown_requested', details())
    void server.close().then(() => report('host.stopped', details()), error => {
      report('host.stop_failed', { ...details(), error })
      process.exitCode = 1
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = webLogFile(process.env.GUGU_LOG_FILE)
  configureDiagnosticLog(file)
  const append = createLogWriter(file)
  let writeFailed = false
  timestampConsole(console, undefined, line => {
    try { append(line); writeFailed = false }
    catch {
      if (!writeFailed) process.stderr.write(`${new Date().toISOString()} Web Host 日志文件暂不可写\n`)
      writeFailed = true
    }
  })
  void main(file).catch(error => {
    createWebRuntimeLog(file)('host.start_failed', { error })
    process.exitCode = 1
  })
}

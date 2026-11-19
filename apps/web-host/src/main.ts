import { configureDiagnosticLog, createLogWriter, createWebRuntimeLog, webLogFile } from './shared/log-files.js'
import { timestampConsole } from './shared/logging.js'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { startServer } from './startup/server.js'

export { startServer } from './startup/server.js'

async function main(logFile: string): Promise<void> {
  const report = createWebRuntimeLog(logFile)
  const server = await startServer({ ...process.env, GUGU_LOG_FILE: logFile })
  const shutdown = () => {
    void server.close().then(() => report('host.stopped'), error => {
      report('host.stop_failed', { error })
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = webLogFile(process.env.GUGU_LOG_FILE)
  configureDiagnosticLog(file)
  const append = createLogWriter(file)
  let writeFailed = false
  timestampConsole(console, undefined, line => {
    try { append(line); writeFailed = false }
    catch {
      if (!writeFailed) process.stderr.write('Web Host 日志文件暂不可写\n')
      writeFailed = true
    }
  })
  void main(file).catch(error => {
    createWebRuntimeLog(file)('host.start_failed', { error })
    process.exitCode = 1
  })
}

import { errorFrames, failureCode, runFields, runPhase } from './redact.js'

const runtimeFailures = new Set([
  'publish_failed', 'release_failed', 'unsubscribe_failed',
  'context_release_failed', 'finalization_hook_failed',
])

/** 两端使用同一事件投影。宿主提供指纹密钥及两个独立的日志出口。 */
export function createAgentLog({ regular, diagnostic, fingerprint, now = Date.now }) {
  const runId = ({ ownerId, sessionId, runId }) => fingerprint(JSON.stringify([ownerId, sessionId, runId])).slice(0, 16)
  const write = (sink, entry) => {
    try { sink(JSON.stringify(entry) + '\n') }
    catch { /* 日志写入失败不能改变 Run 的结果。 */ }
  }
  return {
    log: {
      write({ identity, at, level, event, round, attributes }) {
        const fields = runFields(attributes)
        write(regular, {
          time: new Date(at).toISOString(), level, event, run: runId(identity),
          ...(round === undefined ? {} : { round }),
          ...(Object.keys(fields).length ? { attributes: fields } : {}),
        })
      },
    },
    diagnose(code, failure) {
      const time = new Date(now()).toISOString()
      if (code !== 'run_failed' || !failure) {
        write(regular, { time, level: 'error', event: 'agent.runtime.failure',
          attributes: { errorCode: runtimeFailures.has(code) ? code : 'internal_error' } })
        return
      }
      const run = runId(failure.identity)
      const attributes = { phase: runPhase(failure.phase), errorCode: failureCode(failure.error) }
      const entry = { time, level: 'error', event: 'agent.run.failure', run, attributes }
      write(regular, entry)
      write(diagnostic, { ...entry, frames: errorFrames(failure.error) })
    },
  }
}

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

/** 仅供显式获得 system 授权的 Web Agent 使用。 */
export async function executeAgentSystemShell(input: {
  command: string
  cwd: string
  timeout: number
  maxOutputChars: number
}, signal: AbortSignal) {
  const uid = process.getuid?.()
  if (process.platform !== 'linux' || uid === undefined || uid === 0)
    throw new Error('system Shell 需要 Linux 非 root 服务账号')
  if (/[\u0000-\u001f\u007f]/u.test(input.cwd)) throw new Error('system Shell 工作目录无效')
  const cwd = await realpath(resolve(input.cwd))
  if (!(await stat(cwd)).isDirectory()) throw new Error('system Shell 工作目录无效')
  signal.throwIfAborted()
  const unit = `gugu-agent-system-${randomUUID()}.service`
  const runtime = `/run/user/${uid}`
  const env = { LANG: 'C', XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` }

  const child = spawn('/usr/bin/systemd-run', [
    '--user', '--quiet', '--pipe', '--wait', '--collect', '--expand-environment=no', '--unit', unit,
    '-p', 'KillMode=control-group', '-p', 'TimeoutStopSec=1s', '-p', 'TasksMax=64',
    '-p', 'MemoryMax=268435456', '-p', 'CPUQuota=100%',
    '-p', `RuntimeMaxSec=${Math.ceil(input.timeout)}s`, '-p', `WorkingDirectory=${cwd.replaceAll('%', '%%')}`,
    '--', '/usr/bin/env', '-i', 'LANG=C.UTF-8', 'PATH=/usr/bin:/bin',
    '/bin/bash', '--noprofile', '--norc', '-c', input.command,
  ], { cwd: '/', env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stop: Promise<void> | undefined
  const stopUnit = () => {
    stop ??= new Promise<void>(done => {
      const terminator = spawn('/usr/bin/systemctl', ['--user', 'stop', unit], { env, stdio: 'ignore', timeout: 3000 })
      terminator.once('error', () => done())
      terminator.once('close', () => done())
    })
    return stop
  }
  let timedOut = false
  const abort = () => { void stopUnit() }
  const timer = setTimeout(() => { timedOut = true; abort() }, input.timeout * 1000)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()

  const buffers: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] }
  let remaining = Math.min(1_048_576, input.maxOutputChars * 4)
  let truncated = false
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream].on('data', (bytes: Buffer) => {
      const kept = bytes.subarray(0, remaining)
      if (kept.length) buffers[stream].push(kept)
      remaining -= kept.length
      truncated ||= kept.length !== bytes.length
    })
  }

  try {
    const exitCode = await new Promise<number | null>((complete, reject) => {
      child.once('error', () => reject(new Error('system Shell 启动失败')))
      child.once('close', complete)
    })
    signal.throwIfAborted()
    const text = (stream: 'stdout' | 'stderr') => {
      const characters = Array.from(Buffer.concat(buffers[stream]).toString('utf8'))
      truncated ||= characters.length > input.maxOutputChars
      return characters.slice(0, input.maxOutputChars).join('')
    }
    const stdout = text('stdout'), stderr = text('stderr')
    return { ok: !timedOut && exitCode === 0, stdout, stderr, exit_code: exitCode, timed_out: timedOut,
      truncated, cwd, scope: 'system', network_access: 'host' }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    if (stop) await stop
  }
}

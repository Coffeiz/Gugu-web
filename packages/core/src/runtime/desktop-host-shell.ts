import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

export async function executeDesktopHostShell(command: string, cwd: string, timeout: number, limit: number, signal: AbortSignal) {
  signal.throwIfAborted()
  const windows = process.platform === 'win32'
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const executable = windows ? join(systemRoot, 'System32', 'cmd.exe') : '/bin/sh'
  const child = spawn(executable, windows ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command], {
    cwd, windowsHide: true, windowsVerbatimArguments: windows, detached: !windows,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: windows ? { SystemRoot: systemRoot, USERPROFILE: homedir(), PATH: process.env.PATH }
      : { HOME: homedir(), PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
  })
  const outputs: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] }
  let budget = limit * 4
  let truncated = false
  let timedOut = false
  let stopping = false
  for (const stream of ['stdout', 'stderr'] as const) child[stream].on('data', (chunk: Buffer) => {
    const kept = chunk.subarray(0, budget)
    if (kept.length) outputs[stream].push(kept)
    budget -= kept.length
    truncated ||= kept.length !== chunk.length
  })
  const stop = () => {
    if (!child.pid || stopping) return
    stopping = true
    if (windows) {
      const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => child.kill())
      killer.once('exit', code => { if (code !== 0) child.kill() })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
  }
  const timer = setTimeout(() => { timedOut = true; stop() }, timeout * 1000)
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', () => reject(new Error('桌面宿主机 Shell 启动失败')))
      child.once('close', resolve)
    })
    signal.throwIfAborted()
    const output = (stream: 'stdout' | 'stderr') => {
      const text = Array.from(Buffer.concat(outputs[stream]).toString('utf8'))
      truncated ||= text.length > limit
      return text.slice(0, limit).join('')
    }
    return { ok: exitCode === 0 && !timedOut, stdout: output('stdout'), stderr: output('stderr'),
      exit_code: exitCode, timed_out: timedOut, truncated, cwd, scope: 'system', network_access: 'host' }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}

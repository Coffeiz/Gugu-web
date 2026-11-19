import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { bubblewrapArguments, inheritBubblewrapMounts, type BubblewrapLaunch } from './bubblewrap.js'
import { bubblewrapResourceScope } from './resource-scope.js'

export interface BubblewrapCommandLimits {
  timeoutMs: number
  outputBytes: number
  resourceScope?: boolean
}

/** 只启动固定的 Bubblewrap 程序。终止命名空间的 init 会让内核回收其余进程。 */
export async function runBubblewrapCommand(
  request: BubblewrapLaunch,
  limits: BubblewrapCommandLimits,
  signal?: AbortSignal,
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void,
) {
  if (process.platform !== 'linux' || process.getuid?.() === 0) throw new Error('Bubblewrap 需要非 root Linux 执行环境')
  if (!Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 100 || limits.timeoutMs > 300_000
    || !Number.isInteger(limits.outputBytes) || limits.outputBytes < 1 || limits.outputBytes > 1_048_576)
    throw new Error('沙盒执行限额无效')
  signal?.throwIfAborted()
  const { mounts, descriptors } = inheritBubblewrapMounts(request.mounts, 3)
  const launch = bubblewrapResourceScope('/usr/bin/bwrap', bubblewrapArguments({ ...request, mounts }), limits.resourceScope === true)
  const child = spawn(launch.binary, launch.args, {
    cwd: '/', env: launch.env, stdio: ['ignore', 'pipe', 'pipe', ...descriptors],
  })
  let timedOut = false
  let truncated = false
  let remaining = limits.outputBytes
  const output = { stdout: '', stderr: '' }
  const stop = () => { child.kill('SIGKILL') }
  const timer = setTimeout(() => { timedOut = true; stop() }, limits.timeoutMs)
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
  function append(stream: 'stdout' | 'stderr', text: string) {
    output[stream] += text
    try { if (text) onOutput?.(stream, text) } catch { /* 通知失败不影响执行。 */ }
  }
  for (const stream of ['stdout', 'stderr'] as const) child[stream]!.on('data', (chunk: Buffer) => {
    const selected = chunk.subarray(0, remaining)
    remaining -= selected.length
    truncated ||= selected.length !== chunk.length
    append(stream, decoders[stream].write(selected))
  })
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', () => reject(new Error('Bubblewrap 启动失败')))
      child.once('close', resolve)
    })
    append('stdout', decoders.stdout.end())
    append('stderr', decoders.stderr.end())
    signal?.throwIfAborted()
    return { ...output, exitCode, timedOut, truncated, ok: !timedOut && exitCode === 0 }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
}

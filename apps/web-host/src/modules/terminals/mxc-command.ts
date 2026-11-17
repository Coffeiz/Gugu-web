import { randomUUID } from 'node:crypto'
import { Executor, createMxcExecutor } from '@gugu/core/executor/platform'
import { classifyShellCommandRisk } from '@gugu/core/agent/security/shell-command-risk'
import type { TerminalCommandInput } from '@gugu/core/terminals/command'

/** 目录与环境只能来自可信 Host 挂载解析器，不能从命令参数构造授权。 */
export function createTerminalMxcCommand(resolveMounts: (owner: string, terminal: string, cwd: string) => Promise<{
  cwd: string; readonlyPaths: string[]; readwritePaths: string[]; environment: Record<string, string>; close(): Promise<void>
}>, publishOutput?: (owner: string, terminal: string, requestId: string, command: string, stream: 'stdout' | 'stderr', text: string) => Promise<void>) {
  let executor: Promise<Executor> | undefined
  return async (owner: string, terminal: string, requestId: string, input: TerminalCommandInput, confirmed: boolean, signal: AbortSignal) => {
    const mounts = await resolveMounts(owner, terminal, input.cwd)
    try {
    signal.throwIfAborted()
    const id = randomUUID()
    const command = input.command.trim()
    const timeoutMs = Math.ceil(input.timeout * 1000)
    const destructive = classifyShellCommandRisk(command) === 'dangerous'
    if (destructive && !confirmed) throw new Error('危险命令未获得确认')
    const request = { id, command, cwd: mounts.cwd, timeoutMs, destructive }
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
    let pending = Promise.resolve()
    const publish = (stream: 'stdout' | 'stderr', text: string) => {
      if (text && publishOutput) pending = pending.then(() => publishOutput(owner, terminal, requestId, command, stream, text)).catch(() => {})
    }
    executor ??= createMxcExecutor().then(backend => new Executor([backend])).catch(error => { executor = undefined; throw error })
    let result
    try { result = await (await executor).execute(request, {
      requestId: id, backend: 'mxc', command, cwd: mounts.cwd, timeoutMs,
      confirmed, readonlyPaths: mounts.readonlyPaths, readwritePaths: mounts.readwritePaths,
      environment: mounts.environment, maxOutputBytes: Math.min(1048576, input.maxOutputChars * 4),
    }, signal, (stream, chunk) => publish(stream, decoders[stream].decode(chunk, { stream: true }))) }
    finally {
      publish('stdout', decoders.stdout.decode())
      publish('stderr', decoders.stderr.decode())
      await pending
    }
    return { stdout: Array.from(result.stdout).slice(0, input.maxOutputChars).join(''),
      stderr: Array.from(result.stderr).slice(0, input.maxOutputChars).join(''),
      exitCode: result.exitCode, ok: !result.timedOut && result.exitCode === 0 }
    } finally { await mounts.close() }
  }
}

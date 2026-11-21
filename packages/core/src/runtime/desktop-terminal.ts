import { homedir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { IPty } from 'node-pty'
import { CoreError, type Fields } from '../contracts/index.js'
import type { DesktopTerminalResult } from '../contracts/desktop.js'

type Session = { pty: IPty; output: string; exited: boolean }
const sessions = new Map<string, Session>()

function stop(id: string) {
  const session = sessions.get(id)
  if (!session) return
  if (!session.exited) session.pty.kill()
  sessions.delete(id)
}

export async function closeDesktopTerminal() {
  try {
    for (const id of sessions.keys()) {
      try { stop(id) } catch { /* Core 断开时继续回收其他会话。 */ }
    }
  } finally {
    sessions.clear()
  }
}

function terminalSize(params: Fields) {
  const { cols, rows } = params
  if (typeof cols !== 'number' || !Number.isInteger(cols) || cols < 20 || cols > 500
    || typeof rows !== 'number' || !Number.isInteger(rows) || rows < 5 || rows > 200)
    throw new CoreError('invalid_request', '终端尺寸无效')
  return { cols, rows }
}

async function open(id: string, cwd: string, size: { cols: number; rows: number }) {
  stop(id)
  const windows = process.platform === 'win32'
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const defaultShell = windows ? process.env.ComSpec : userInfo().shell ?? process.env.SHELL
  const shell = defaultShell && isAbsolute(defaultShell)
    ? defaultShell : windows ? join(systemRoot, 'System32', 'cmd.exe') : '/bin/sh'
  const env: Record<string, string> = { HOME: homedir(), TERM: 'xterm-256color' }
  // 用户 Shell 继承系统身份。仅透传终端启动所需的系统变量，避免附带 Core 的服务环境。
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && /^(PATH|PATHEXT|SHELL|USER|USERNAME|LOGNAME|USERPROFILE|HOMEDRIVE|HOMEPATH|SYSTEMROOT|WINDIR|COMSPEC|APPDATA|LOCALAPPDATA|TMP|TEMP|TMPDIR|LANG|LANGUAGE|LC_[A-Z_]+)$/i.test(key))
      env[key] = value
  }
  try {
    const { spawn } = await import('node-pty')
    const pty = spawn(shell, windows ? [] : ['-l', '-i'], { name: 'xterm-256color', cwd, ...size, env })
    const session: Session = { pty, output: '', exited: false }
    pty.onData(data => { session.output = (session.output + data).slice(-8192) })
    pty.onExit(() => { session.exited = true })
    sessions.set(id, session)
  } catch {
    throw new CoreError('invalid_request', '无法启动本机 Shell，请检查系统终端设置')
  }
}

export async function desktopTerminal(params: Fields): Promise<DesktopTerminalResult> {
  const { action, terminalId, root, data } = params
  if (typeof terminalId !== 'string' || !/^[a-f0-9-]{36}$/.test(terminalId))
    throw new CoreError('invalid_request', '终端标识无效')
  const active = sessions.get(terminalId)
  switch (action) {
    case 'open':
      if (typeof root !== 'string' || !isAbsolute(root)) throw new CoreError('invalid_request', '未指定终端目录')
      await open(terminalId, root, terminalSize(params))
      break
    case 'close': stop(terminalId); break
    case 'input':
      if (typeof data !== 'string' || data.length > 4096) throw new CoreError('invalid_request', '终端输入无效')
      if (active && !active.exited) active.pty.write(data)
      break
    case 'resize': {
      const { cols, rows } = terminalSize(params)
      if (active && !active.exited) active.pty.resize(cols, rows)
      break
    }
    case 'output': break
    default: throw new CoreError('invalid_request', '终端操作无效')
  }
  const session = sessions.get(terminalId)
  const result = { output: session?.output ?? '', exited: session?.exited ?? true }
  if (session) session.output = ''
  return result
}

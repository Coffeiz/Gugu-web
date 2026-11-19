import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Writable } from 'node:stream'
import { bubblewrapArguments, inheritBubblewrapMounts, type BubblewrapMount } from './bubblewrap.js'
import type { PtyHandle } from '../../contracts.js'
import { bubblewrapResourceScope } from './resource-scope.js'

export interface BubblewrapPtySpec {
  terminalId: string
  sandboxCwd?: string
  sandboxMounts?: readonly BubblewrapMount[]
  cols: number
  rows: number
  networkProfile: 'none' | 'egress'
  release?: () => Promise<void>
  timeoutMs?: number
  authorizeRunning?(): Promise<boolean>
}

export function createBubblewrapPtyBridge(rootfs?: string) {
  return {
    async open(spec: BubblewrapPtySpec): Promise<PtyHandle> {
      if (process.platform !== 'linux' || process.getuid?.() === 0 || !rootfs || !spec.sandboxCwd
        || !spec.sandboxMounts || spec.networkProfile !== 'none')
        throw new Error('无可用的断网 Bubblewrap PTY')
      if (spec.authorizeRunning && !await spec.authorizeRunning())
        throw new Error('PTY 授权已失效')
      const { mounts, descriptors } = inheritBubblewrapMounts(spec.sandboxMounts, 4)
      const args = bubblewrapArguments({ rootfs, mounts, cwd: spec.sandboxCwd, command: 'bash', interactive: true })
      const launch = bubblewrapResourceScope('/usr/libexec/gugu-bubblewrap-pty', [String(spec.rows), String(spec.cols), ...args], true)
      const pty = spawn(launch.binary, launch.args, {
        cwd: '/', env: launch.env, stdio: ['pipe', 'pipe', 'ignore', 'pipe', ...descriptors],
      })
      const input = pty.stdin!, output = pty.stdout!, control = pty.stdio[3]
      if (!(control instanceof Writable)) {
        pty.kill('SIGKILL')
        throw new Error('PTY 控制管道不可用')
      }
      for (const stream of [input, control]) stream.on('error', () => pty.kill('SIGKILL'))
      let ended = false
      const done = new Promise<void>(resolve => {
        const finish = () => {
          ended = true
          clearTimeout(timer)
          if (recheck) clearInterval(recheck)
          resolve()
        }
        // 取消时客户端可能已停止读取输出，不能等待管道排空才确认进程退出。
        pty.once('exit', finish)
        pty.once('error', finish)
      })
      const terminate = () => { if (!ended) pty.kill('SIGKILL') }
      const timer = setTimeout(terminate, spec.timeoutMs ?? 900_000)
      let checking = false
      const recheck = spec.authorizeRunning && setInterval(() => {
        if (checking || ended) return
        checking = true
        void spec.authorizeRunning!().then(allowed => { if (!allowed) terminate() }, terminate)
          .finally(() => { checking = false })
      }, 1000)
      try { await once(pty, 'spawn') }
      catch {
        await done
        throw new Error('Bubblewrap PTY 启动失败')
      }
      const send = (stream: Writable, bytes: Uint8Array) => new Promise<void>((resolve, reject) => {
        stream.write(bytes, error => error ? reject(error) : resolve())
      })
      let closing: Promise<void> | undefined
      return {
        pid: pty.pid!,
        sandboxId: `${spec.terminalId}:${pty.pid}`,
        async write(data) { if (!ended) await send(input, data) },
        async resize(cols, rows) {
          if (ended) return
          if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200)
            throw new Error('PTY 终端尺寸无效')
          const bytes = Buffer.alloc(4)
          bytes.writeUInt16BE(rows)
          bytes.writeUInt16BE(cols, 2)
          await send(control, bytes)
        },
        async signal(name) {
          if (ended) return
          if (name === 'SIGTERM') terminate()
          else await send(input, Buffer.from(name === 'SIGINT' ? '\u0003' : '\u001a'))
        },
        async close() {
          closing ??= (async () => {
            try { terminate(); await done } finally { await spec.release?.() }
          })()
          return closing
        },
        output: () => output,
      }
    },
  }
}

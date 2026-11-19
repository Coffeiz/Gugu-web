import { connect } from 'node:net'
import type { Pool } from 'pg'

function terminateContainer(socketPath: string, containerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let response = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    socket.setTimeout(15_000, () => finish(new Error('sandboxd PTY 停止请求超时')))
    socket.once('error', () => finish(new Error('sandboxd PTY 停止请求失败')))
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ operation: 'pty_terminate', container_name: containerName })}\n`)
    })
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8')
      const newline = response.indexOf('\n')
      if (newline < 0) return
      try {
        const value = JSON.parse(response.slice(0, newline)) as { ok?: unknown }
        if (value && value.ok === true) finish()
        else finish(new Error('sandboxd 无法停止 PTY'))
      } catch {
        finish(new Error('sandboxd PTY 停止响应无效'))
      }
    })
  })
}

/** 查询 PTY 持久化的 sandbox container ID，并通过共享 sandboxd 停止容器。 */
export function createSandboxdWorkspacePtyTerminator(pool: Pool, socketPath: string) {
  return async (terminalId: string): Promise<void> => {
    const result = await pool.query<{ pty_sandbox_id: string | null }>(
      'SELECT pty_sandbox_id FROM terminal_sessions WHERE id = $1', [terminalId],
    )
    const containerName = result.rows[0]?.pty_sandbox_id
    if (!containerName) return
    if (!socketPath) throw new Error('sandboxd socket 未配置，无法安全停止 PTY')
    if (containerName.length > 128 || /[\r\n\0]/.test(containerName))
      throw new Error('PTY sandbox ID 无效')
    await terminateContainer(socketPath, containerName)
  }
}

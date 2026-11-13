import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createSandboxdWorkspacePtyTerminator } from '../../src/adapters/sandboxd-pty.js'

test('Workspace delete terminates the persisted sandbox container through the shared daemon socket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-sandboxd-pty-'))
  const socketPath = join(directory, 'sandboxd.sock')
  let request: unknown
  const server = createServer((socket) => {
    let body = ''
    socket.on('data', (chunk) => {
      body += chunk.toString('utf8')
      if (!body.includes('\n')) return
      request = JSON.parse(body.slice(0, body.indexOf('\n')))
      socket.end(`${JSON.stringify({ ok: true, terminated: true })}\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))

  try {
    const queries: unknown[][] = []
    const terminate = createSandboxdWorkspacePtyTerminator({
      async query(sql: string, values: unknown[]) {
        queries.push([sql, values])
        return { rows: [{ pty_sandbox_id: 'gugu-pty-synthetic-1' }] }
      },
    } as never, socketPath)

    await terminate('terminal-synthetic-1')

    assert.deepEqual(queries, [[
      'SELECT pty_sandbox_id FROM terminal_sessions WHERE id = $1', ['terminal-synthetic-1'],
    ]])
    assert.deepEqual(request, {
      operation: 'pty_terminate', container_name: 'gugu-pty-synthetic-1',
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

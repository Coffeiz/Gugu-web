import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import { createBubblewrapPtyBridge } from '@gugu/sandbox/linux/pty'
import type { TerminalListItem } from '@gugu/core/terminals/list'
import { createUserToken } from '../../src/modules/auth/session/token.js'
import { registerTerminalWebsocket } from '../../src/modules/terminals/pty/websocket.js'
import { createTerminalPtyManager } from '../../src/modules/terminals/pty/manager.js'
import { createTerminalPtyRuntime } from '../../src/modules/terminals/pty/runtime.js'
import { prepareTerminalMounts } from '../../src/modules/terminals/sandbox/mounts.js'

const rootfs = process.env.GUGU_BUBBLEWRAP_TEST_ROOTFS
const owner = '00000000-0000-4000-8000-000000000211'
const other = '00000000-0000-4000-8000-000000000212'
const secret = 'synthetic-bubblewrap-websocket-token'

test('认证 WebSocket 经过真实 Bubblewrap PTY 转发输入、尺寸和撤权退出', {
  skip: (process.platform !== 'linux' || !rootfs) && '需要隔离 Linux 运行根',
  timeout: 15000,
}, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'gugu-bubblewrap-ws-'))
  const key = `${owner}/workspace/default`
  const libraries = [`${owner}/个人文件`, `${owner}/项目文件`]
  const manager = createTerminalPtyManager({ bridge: createBubblewrapPtyBridge(rootfs) })
  const server = createServer()
  let enabled = true
  let exits = 0
  const read = async (id: string, terminal: string) => {
    if (id !== owner || terminal !== 'pty-test') throw Object.assign(new Error('终端不存在'), { statusCode: 404 })
    return { id: terminal, mode: 'interactive-pty', shellMode: 'sandbox', workspaceId: 1, status: 'idle', closedAt: null } as TerminalListItem
  }
  const runtime = createTerminalPtyRuntime({
    read, manager,
    async authorize(id, terminal) { await read(id, terminal) },
    async snapshot() {
      return { workspaceId: 1, workspaceTarget: key, networkProfile: 'none', facts: {
        adminEnabled: true, userEnabled: enabled, sandboxEnabled: true, sandboxReady: true,
        sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true,
        fullUserSandboxWrite: false, adminDangerousEnabled: false, userDangerousEnabled: false,
      } }
    },
    mounts: (id, _workspace, _fullWrite, cwd) => prepareTerminalMounts(scratch, id, key, libraries, [key], cwd, new Set([key, ...libraries])),
  })
  const shutdown = registerTerminalWebsocket(server, {
    runtime: { read, ...runtime }, manager,
    auth: { secret, async lookupUser(id) { return { id, isActive: true, securityVersion: 1 } } },
    state: { async started() {}, async exited() { exits++; return true } },
  })
  let client: WebSocket | undefined
  let denied: WebSocket | undefined
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const url = `ws://127.0.0.1:${address.port}/api/v1/terminals/pty-test/ws`
    denied = new WebSocket(url, [`gugu-auth.${createUserToken(other, 1, secret)}`])
    const [error] = await once(denied, 'error')
    assert.match(String(error), /404/)
    assert.equal(manager.get('pty-test'), undefined)

    client = new WebSocket(url, [`gugu-auth.${createUserToken(owner, 1, secret)}`])
    const closed = once(client, 'close')
    let output = ''
    const wrote = new Promise<void>(resolve => client!.on('message', data => {
      const frame = JSON.parse(String(data))
      if (frame.type === 'ready') {
        client!.send(JSON.stringify({ type: 'resize', cols: 101, rows: 37 }))
        client!.send(JSON.stringify({ type: 'input', data:
          'test "$PWD" = /workspace/default && test -d /personal && test -d /project && stty size > size && printf "%s%s\\n" WS_ PTY_OK\n',
        }))
      } else if (frame.type === 'output') {
        output += Buffer.from(frame.data, 'base64').toString('utf8')
        if (output.includes('WS_PTY_OK')) resolve()
      } else if (frame.type === 'error') output += frame.errorCode
    }))
    await Promise.race([wrote, closed.then(([code]) => assert.fail(`终端提前关闭（${code}）：${output}`))])
    assert.equal(await readFile(join(scratch, key, 'size'), 'utf8'), '37 101\n')
    assert.ok(manager.get('pty-test'))
    enabled = false
    await closed
    assert.equal(exits, 1)
    assert.equal(manager.get('pty-test'), undefined)
  } finally {
    client?.terminate()
    denied?.terminate()
    await shutdown()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(scratch, { recursive: true, force: true })
  }
})

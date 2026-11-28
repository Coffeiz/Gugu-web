import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { createApp } from '../../../../src/app.js'
import { createUserToken } from '../../../../src/modules/auth/session/token.js'

const ownerId = '11111111-1111-4111-8111-111111111111'
const secret = 'synthetic-trash-vite-secret'

test('Vite→Node Host 磁盘回收站要求认证并使用可信 owner', async () => {
  const calls: Array<{ operation: string; ownerId: string; args: unknown[] }> = []
  const record = (operation: string) => async (owner: string, ...args: unknown[]) => {
    calls.push({ operation, ownerId: owner, args })
    return undefined
  }
  const files = {
    async listDiskTrash(owner: string) { calls.push({ operation: 'list', ownerId: owner, args: [] }); return [{ id: 'entry', name: '示例文件' }] },
    async restoreDiskTrash(owner: string, id: string) { calls.push({ operation: 'restore', ownerId: owner, args: [id] }); return { ok: true } },
    async purgeDiskTrash(owner: string, id: string) { calls.push({ operation: 'purge', ownerId: owner, args: [id] }); return { ok: true } },
  }
  const app = createApp({
    appName: 'Local trash Vite integration',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    workspaceDirectories: { files } as never,
  })
  const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
  const previousProxyTarget = process.env.VITE_API_PROXY_TARGET
  process.env.VITE_API_PROXY_TARGET = hostAddress
  const frontendRoot = resolve(process.cwd(), '../ui')
  const requireFrontend = createRequire(resolve(frontendRoot, 'package.json'))
  const viteModule = requireFrontend('vite') as {
    createServer(options: Record<string, unknown>): Promise<{
      listen(): Promise<void>
      close(): Promise<void>
      httpServer?: { address(): string | { port: number } | null }
    }>
  }
  let vite: Awaited<ReturnType<typeof viteModule.createServer>> | undefined
  try {
    vite = await viteModule.createServer({
      configFile: resolve(frontendRoot, 'vite.config.js'),
      root: frontendRoot,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/api/v1/files/disk-trash`
    assert.equal((await fetch(base)).status, 401)
    assert.equal(calls.length, 0)
    const token = createUserToken(ownerId, 1, secret)
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const list = await fetch(base, { headers })
    assert.equal(list.status, 200)
    assert.deepEqual(await list.json(), [{ id: 'entry', name: '示例文件' }])
    assert.equal((await fetch(`${base}/entry/restore`, { method: 'POST', headers })).status, 200)
    assert.equal((await fetch(`${base}/entry`, { method: 'DELETE', headers })).status, 200)
    assert.deepEqual(calls, [
      { operation: 'list', ownerId, args: [] },
      { operation: 'restore', ownerId, args: ['entry'] },
      { operation: 'purge', ownerId, args: ['entry'] },
    ])
  } finally {
    await vite?.close()
    await app.close()
    if (previousProxyTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousProxyTarget
  }
})

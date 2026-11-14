import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'
import type { TrashOperations } from '../../src/domains/files/trash.js'

const ownerId = '11111111-1111-4111-8111-111111111111'
const secret = 'synthetic-trash-vite-secret'

test('Vite→Node Host 回收站路由要求认证并把认证 owner 与客户端来源传给 Local 操作', async () => {
  const calls: Array<{ operation: string; ownerId: string; args: unknown[] }> = []
  const record = (operation: string) => async (owner: string, ...args: unknown[]) => {
    calls.push({ operation, ownerId: owner, args })
    return undefined
  }
  const operations: TrashOperations = {
    async listFiles(owner, query) {
      calls.push({ operation: 'listFiles', ownerId: owner, args: [query] })
      return { items: [{ id: 7, display_name: '示例文件' }], has_more: false, next_cursor: null }
    },
    async listFolders(owner, query) {
      calls.push({ operation: 'listFolders', ownerId: owner, args: [query] })
      return { items: [], has_more: false, next_cursor: null }
    },
    async listFolderContents(owner, folderId, query) {
      calls.push({ operation: 'listFolderContents', ownerId: owner, args: [folderId, query] })
      return {
        folders: { items: [], has_more: false, next_cursor: null },
        files: { items: [], has_more: false, next_cursor: null },
      }
    },
    async restoreFolder(owner, folderId, origin) {
      calls.push({ operation: 'restoreFolder', ownerId: owner, args: [folderId, origin] })
      return { id: folderId, name: '示例目录' }
    },
    async restoreFiles(owner, fileIds, origin) {
      calls.push({ operation: 'restoreFiles', ownerId: owner, args: [fileIds, origin] })
    },
    hardDeleteFile: record('hardDeleteFile'),
    hardDeleteFolder: record('hardDeleteFolder'),
    async startEmpty(owner) {
      calls.push({ operation: 'startEmpty', ownerId: owner, args: [] })
      return { id: 9, status: 'queued', progressCurrent: 0, progressTotal: 1, failedCount: 0, errorCode: null }
    },
    async activeEmpty(owner) {
      calls.push({ operation: 'activeEmpty', ownerId: owner, args: [] })
      return null
    },
    async getEmpty(owner, jobId) {
      calls.push({ operation: 'getEmpty', ownerId: owner, args: [jobId] })
      return null
    },
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
    trash: operations,
  })
  const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
  const previousProxyTarget = process.env.VITE_API_PROXY_TARGET
  process.env.VITE_API_PROXY_TARGET = hostAddress
  const frontendRoot = resolve(process.cwd(), '../web')
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
    const base = `http://127.0.0.1:${address.port}/api/v1/trash`
    assert.equal((await fetch(`${base}/page`)).status, 401)
    assert.equal(calls.length, 0)

    const token = createUserToken(ownerId, 1, secret)
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const page = await fetch(`${base}/page?limit=25`, { headers })
    assert.equal(page.status, 200)
    assert.deepEqual(await page.json(), {
      items: [{ id: 7, display_name: '示例文件' }], has_more: false, next_cursor: null,
    })
    const restored = await fetch(`${base}/folders/4/restore`, {
      method: 'POST', headers: { ...headers, 'x-client-id': 'synthetic-tab' }, body: '{}',
    })
    assert.equal(restored.status, 200)
    assert.deepEqual(await restored.json(), { id: 4, name: '示例目录' })
    const batchRestored = await fetch(`${base}/batch-restore`, {
      method: 'POST', headers: { ...headers, 'x-client-id': 'synthetic-tab' },
      body: JSON.stringify({ ids: [7, 8] }),
    })
    assert.equal(batchRestored.status, 204)
    assert.deepEqual(calls, [
      { operation: 'listFiles', ownerId, args: [{ limit: 25, cursor: null }] },
      { operation: 'restoreFolder', ownerId, args: [4, 'synthetic-tab'] },
      { operation: 'restoreFiles', ownerId, args: [[7, 8], 'synthetic-tab'] },
    ])
  } finally {
    await vite?.close()
    await app.close()
    if (previousProxyTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousProxyTarget
  }
})

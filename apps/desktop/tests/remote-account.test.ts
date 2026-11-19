import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createRemoteAuthClient, RemoteAuthError } from '@gugu/core/auth/client'
import type { RemoteSession, RemoteUser } from '@gugu/core/auth/contracts'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { createRemoteSessionStore } from '../src/main/auth/store.js'
import { createRemoteAccountHandlers } from '../src/main/auth/session.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { force: true, recursive: true }))) })

const user: RemoteUser = {
  id: '9e51a4bf-07e1-4db8-9050-54a8c7356e8d', username: '合成用户', displayName: null,
  email: 'synthetic@example.test', isActive: true, avatarUrl: null, createdAt: '', imChannels: [],
  timezone: null, emailSubscribed: false,
}
const session: RemoteSession = {
  provider: 'self-hosted', origin: 'https://gugu.example.test', accountId: user.id, token: 'synthetic-token',
}

function encryption() {
  const key = randomBytes(32)
  return {
    async isAsyncEncryptionAvailable() { return true },
    async encryptStringAsync(value: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    async decryptStringAsync(value: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return { result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(), shouldReEncrypt: false }
    },
  }
}

it('远程账号通过加密记录跨重启恢复，断网保留记录，到期及本机退出清除记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-remote-account-'))
  dirs.push(dir)
  const crypto = encryption()
  const input = { provider: 'self-hosted', server: session.origin, username: user.username, password: 'synthetic-password' }
  let mode: 'connected' | 'offline' | 'expired' = 'connected'
  const client = {
    login: async () => ({ session, user }),
    async restore(saved: RemoteSession) {
      expect(saved).toEqual(session)
      if (mode === 'offline') throw new RemoteAuthError('unavailable', '合成网络故障')
      if (mode === 'expired') throw new RemoteAuthError('session_expired', '合成撤销')
      return user
    },
  }
  const first = createRemoteAccountHandlers(createRemoteSessionStore(dir, crypto), client)
  expect(await first[DESKTOP_CHANNELS.remoteLogin](input)).toEqual({ state: 'connected', origin: session.origin, user })
  const file = join(dir, 'remote-session')
  const encrypted = await readFile(file)
  expect(encrypted.includes(Buffer.from(session.token))).toBe(false)
  expect(encrypted.includes(Buffer.from(input.password))).toBe(false)

  const next = createRemoteAccountHandlers(createRemoteSessionStore(dir, crypto), client)
  expect(await next[DESKTOP_CHANNELS.remoteAccount]()).toMatchObject({ state: 'connected' })
  mode = 'offline'
  expect(await next[DESKTOP_CHANNELS.remoteAccount]()).toEqual({ state: 'offline', origin: session.origin })
  expect(await readFile(file)).toEqual(encrypted)
  mode = 'expired'
  expect(await next[DESKTOP_CHANNELS.remoteAccount]()).toEqual({ state: 'expired', origin: session.origin })
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  await next[DESKTOP_CHANNELS.remoteLogin](input)
  expect(await next[DESKTOP_CHANNELS.remoteLogout]()).toEqual({ state: 'signed-out' })
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('客户端隔离服务器来源，拒绝跨站跳转和无加密的远程地址', async () => {
  const calls: { url: URL; authorization: string | null; redirect?: RequestRedirect }[] = []
  const client = createRemoteAuthClient(async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect })
    if (url.pathname.endsWith('/login')) return Response.json({ access_token: session.token, token_type: 'bearer', user })
    return Response.json(user)
  })
  const input = { provider: 'self-hosted' as const, server: session.origin, username: '示例', password: 'synthetic-password' }
  await expect(client.login({ ...input, server: 'http://gugu.example.test' })).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(client.login({ ...input, provider: 'official-saas' })).rejects.toMatchObject({ code: 'unsupported' })
  expect(calls).toHaveLength(0)
  await client.login(input)
  expect(calls.map(call => [call.url.origin, call.authorization, call.redirect])).toEqual([
    [session.origin, null, 'error'],
    [session.origin, 'Bearer ' + session.token, 'error'],
  ])
  const redirected = createRemoteAuthClient(async () => Response.redirect('https://other.example.test'))
  await expect(redirected.login(input)).rejects.toMatchObject({ code: 'unavailable' })
})

it('远程 BYOK 拒绝从旧账号页面提交操作', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-remote-byok-'))
  dirs.push(dir)
  const store = createRemoteSessionStore(dir, encryption())
  const calls: RemoteSession[] = []
  const handlers = createRemoteAccountHandlers(store, undefined, async current => {
    calls.push(current)
    return { enabled: true, status: 'ready', items: [] }
  })
  const target = { origin: session.origin, accountId: session.accountId }
  await store.write(session)
  await expect(handlers[DESKTOP_CHANNELS.remoteByok](target, { action: 'list' })).resolves.toMatchObject({ items: [] })
  await store.write({ ...session, origin: 'https://other.example.test' })
  await expect(handlers[DESKTOP_CHANNELS.remoteByok](target, {
    action: 'delete', id: 1,
  })).rejects.toMatchObject({ code: 'session_changed' })
  expect(calls).toEqual([session])
})

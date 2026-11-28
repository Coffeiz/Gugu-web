import { createRemoteByokClient, RemoteByokError } from '@gugu/core/byok/client'
import { byokCommand, byokTarget } from '@gugu/core/byok/contracts'
import { bindRemoteSession, createRemoteAuthClient, RemoteAuthError } from '@gugu/auth/client'
import { remoteLoginInputSchema, type RemoteAccountState, type RemoteLoginInput, type RemoteSession, type RemoteUser } from '@gugu/auth/contracts'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { DesktopError } from '../core-host.js'
import type { createRemoteSessionStore } from './store.js'

export function createRemoteAccountHandlers(
  store: ReturnType<typeof createRemoteSessionStore>,
  client = createRemoteAuthClient(),
  byok = createRemoteByokClient(bindRemoteSession()),
  getDeviceId?: () => Promise<string>,
) {
  // 登录切换、恢复和退出一次只执行一个，避免旧请求清掉新会话。
  let tail: Promise<unknown> = Promise.resolve()
  function run<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation)
    tail = result.catch(() => {})
    return result
  }

  async function connected(session: RemoteSession, user: RemoteUser): Promise<RemoteAccountState> {
    const state = { state: 'connected' as const, origin: session.origin, user }
    if (session.provider !== 'official-saas') return state
    try {
      return { ...state, provider: session.provider, projects: await client.saasProjects(session) }
    } catch {
      return { ...state, provider: session.provider, projectsUnavailable: true }
    }
  }

  return {
    [DESKTOP_CHANNELS.remoteByok]: (target: unknown, value: unknown) => run(async () => {
      const command = byokCommand.safeParse(value)
      const expected = byokTarget.safeParse(target)
      if (!command.success || !expected.success) throw new DesktopError('invalid_request', '凭据参数无效')
      const session = await store.read()
      if (!session) throw new DesktopError('session_expired', '请先登录远程服务器')
      if (session.origin !== expected.data.origin || session.accountId !== expected.data.accountId) {
        throw new DesktopError('session_changed', '远程账号已切换，请重新打开账号页面')
      }
      try {
        return await byok(session, command.data)
      } catch (error) {
        if (error instanceof RemoteByokError) throw new DesktopError(error.code, error.message)
        throw error
      }
    }),
    [DESKTOP_CHANNELS.remoteAccount]: (): Promise<RemoteAccountState> => run(async () => {
      const session = await store.read()
      if (!session) return { state: 'signed-out' }
      try {
        const user = await client.restore(session)
        return connected(session, user)
      } catch (error) {
        if (error instanceof RemoteAuthError && error.code === 'session_expired') {
          await store.clear()
          return { state: 'expired', origin: session.origin }
        }
        return { state: 'offline', origin: session.origin }
      }
    }),
    [DESKTOP_CHANNELS.remoteLogin]: (value: unknown): Promise<RemoteAccountState> => {
      const input = remoteLoginInputSchema.safeParse(value)
      if (!input.success) return Promise.reject(new DesktopError('invalid_request', '请填写服务器地址、账号和密码'))
      return login(input.data)
    },
    [DESKTOP_CHANNELS.remoteLogout]: (): Promise<RemoteAccountState> => run(async () => {
      const session = await store.read()
      if (session?.provider === 'official-saas') await client.logoutSaas(session)
      await store.clear()
      return { state: 'signed-out' }
    }),
  }

  function login(input: RemoteLoginInput): Promise<RemoteAccountState> {
    return run(async () => {
      try {
        const { session, user } = await client.login(input, await getDeviceId?.())
        await store.write(session)
        return connected(session, user)
      } catch (error) {
        if (error instanceof RemoteAuthError) throw new DesktopError(error.code, error.message)
        throw error
      }
    })
  }
}

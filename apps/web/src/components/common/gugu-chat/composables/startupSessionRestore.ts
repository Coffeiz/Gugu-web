import type { SessionLoadOutcome } from './useChatSessions'

interface StartupSessionRestoreOptions {
  loadSession: () => Promise<SessionLoadOutcome>
  onUnavailable: () => void
  onFailure: () => void
}

/** 启动恢复被用户后续操作取代时，不得把新会话重置成默认问候。 */
export async function restoreStartupSession(options: StartupSessionRestoreOptions) {
  const outcome = await options.loadSession()
  if (outcome === 'unavailable') options.onUnavailable()
  else if (outcome === 'failed') options.onFailure()
}

import { createTerminalShellFactsReader } from '@gugu/core/terminals/shell-facts'

/** Host 提供当前管理配置和 MXC 就绪状态，用户与工作区事实由 Core 按 owner 查询。 */
export function createTerminalShellSnapshotReader(db: Parameters<typeof createTerminalShellFactsReader>[0], dialect: 'postgres' | 'sqlite', runtime: () => Promise<{
  shellEnabled: boolean; shellDangerousEnabled: boolean; sandboxEnabled: boolean; sandboxReady: boolean;
  sandboxReason?: string; filesystemAuthorizationEnabled: boolean
  networkProfile: 'none' | 'egress'
}>) {
  const read = createTerminalShellFactsReader(db, dialect)
  return async (owner: string, terminal: string) => {
    const settings = await runtime()
    const data = await read(owner, terminal, settings.filesystemAuthorizationEnabled)
    if (!data) return null
    return { sessionId: data.sessionId, workspaceId: data.workspaceId, workspaceTarget: JSON.stringify(data.workspaceTarget), networkProfile: settings.networkProfile, facts: {
      adminEnabled: settings.shellEnabled, adminDangerousEnabled: settings.shellDangerousEnabled,
      sandboxEnabled: settings.sandboxEnabled, sandboxReady: settings.sandboxReady, sandboxReason: settings.sandboxReason,
      filesystemAuthorizationAvailable: true, sessionOwned: data.sessionOwned, workspaceValid: data.workspaceValid,
      userEnabled: data.userEnabled, userDangerousEnabled: data.userDangerousEnabled, fullUserSandboxWrite: data.fullUserSandboxWrite,
    } }
  }
}

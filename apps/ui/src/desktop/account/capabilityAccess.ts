import type { ByokCommand, ByokSummary } from '@gugu/core/byok/contracts'
import type { LocalCapabilityAccess } from '@/services/localPreferencesAccess'
import { callDesktopBridge, desktopRemoteAccount, desktopRemoteByok } from '../bridge/bridge'

export function createDesktopCapabilityAccess(): LocalCapabilityAccess {
  let selectedAccount: { origin: string; accountId: string } | undefined
  function target() {
    if (!selectedAccount) throw new Error('请先登录远程服务器以配置专项能力')
    return selectedAccount
  }
  return {
    async smtpSettings() {
      const result = await callDesktopBridge(bridge => bridge.personalSmtp('get'))
      return result && 'configured' in result ? result : null
    },
    saveSmtp: input => callDesktopBridge(bridge => bridge.personalSmtp('save', input)),
    async testSmtp(input) {
      const result = await callDesktopBridge(bridge => bridge.personalSmtp('test', input))
      if (!result || !('ok' in result)) throw new Error('SMTP 测试结果无效')
      return result
    },
    async list() {
      const account = await desktopRemoteAccount.status()
      selectedAccount = account?.state === 'connected' ? { origin: account.origin, accountId: account.user.id } : undefined
      if (!selectedAccount) return []
      const result = await desktopRemoteByok(selectedAccount, { action: 'list' })
      return result && 'items' in result ? result.items : []
    },
    async save(item, id) {
      const account = target()
      let command: ByokCommand
      if (id) command = { action: 'update', id, input: { provider: item.provider, enabled: true, ...(item.value ? { value: item.value } : {}) } }
      else command = { action: 'create', makeDefault: true,
        input: { ...item, value: item.value ?? '', api_format: '', base_url: '', model: '' } }
      const result = await desktopRemoteByok(account, command)
      if (!result || !('id' in result)) throw new Error('服务器未确认保存凭据')
      return result satisfies ByokSummary
    },
    async remove(id) { await desktopRemoteByok(target(), { action: 'delete', id }) },
    async test(item, id) {
      const account = target()
      const command: ByokCommand = item.value
        ? { action: 'test-preview', input: { ...item, value: item.value } }
        : { action: 'test', id: id! }
      const result = await desktopRemoteByok(account, command)
      if (!result || !('ok' in result)) throw new Error('凭据测试结果无效')
      return result
    },
  }
}

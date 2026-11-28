import { normalizeImWorkspaceArgument, parseImWorkspaceDeletion } from '@gugu/core/im/shortcut'

export interface DesktopWorkspaceCommands {
  list(): Promise<readonly { id: string; name: string; commandNumber?: number | null }[]>
  remove(id: string): Promise<unknown>
}

export async function runDesktopWorkspaceExtra(rawArgument: string, commands?: DesktopWorkspaceCommands,
  authorize: () => Promise<boolean> = async () => true, readBinding?: () => Promise<string>): Promise<string | null> {
  const argument = normalizeImWorkspaceArgument(rawArgument)
  if (argument === 'status') {
    const binding = await readBinding?.()
    return [binding, '完整用户沙箱授权：桌面端不提供此权限。Shell 执行仍使用当前桌面会话的权限设置。']
      .filter(Boolean).join('\n')
  }
  if (/^(?:status|god|revoke)(?:\s|$)/u.test(argument))
    return '桌面端当前不提供完整用户沙箱授权。使用 /workspace status 查看权限状态。'

  const deletion = parseImWorkspaceDeletion(argument)
  if (!deletion) return null
  if (deletion.kind === 'usage') return '用法：/workspace delete <ID> [confirm]'
  if (!commands) return '当前入口未接入工作区删除。'
  const target = (await commands.list()).find(row => row.commandNumber === deletion.id)
  if (!target) return '工作区不存在。'
  if (deletion.kind === 'prompt')
    return `删除「${target.name}」会解除工作区登记，文件会保留。确认请发送 /workspace delete ${deletion.id} confirm。`
  if (!await authorize()) return '工作区删除未获授权。'
  await commands.remove(target.id)
  return `已删除工作区「${target.name}」。`
}

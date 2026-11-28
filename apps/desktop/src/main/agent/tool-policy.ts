/** 桌面 Agent 不提供文件回收站工具；本地文件操作统一通过桌面 Shell。 */
export const DESKTOP_DISABLED_AGENT_TOOLS = Object.freeze([
  'delete_file',
  'delete_folder',
  'list_trash',
  'restore_file',
  'restore_folder',
  'permanent_delete',
])

export function desktopAgentToolPolicy() {
  return { disabledTools: [...DESKTOP_DISABLED_AGENT_TOOLS] }
}

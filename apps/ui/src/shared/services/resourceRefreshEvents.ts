/** 咕咕通过工具修改资源后，通知当前页面重新读取对应列表。 */
export const RESOURCE_REFRESH_EVENTS = {
  skills: 'gugu:skills-changed',
  mcp: 'gugu:mcp-changed',
  scheduledTasks: 'gugu:scheduled-tasks-changed',
} as const

export function notifyResourceChanged(resource: keyof typeof RESOURCE_REFRESH_EVENTS): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(RESOURCE_REFRESH_EVENTS[resource]))
  }
}

/** 将跨端实时事件桥接到依赖浏览器本地事件的资源页。 */
export function notifyLiveResourceChanged(resource: string): void {
  if (resource === 'skills') notifyResourceChanged('skills')
}

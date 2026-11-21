export interface SidebarRunStatus {
  runId: string
  running: boolean
}

/** 已切换到新 Run 的会话忽略旧流迟到的开始或结束事件。 */
export function acceptsSidebarRunStatus(previous: SidebarRunStatus | undefined, next: SidebarRunStatus, fromUserEvents: boolean): boolean {
  if (!next.running) return previous?.runId === next.runId
  return fromUserEvents || !previous?.running || previous.runId === next.runId
}

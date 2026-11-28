export interface ChatNavigationRequest {
  requestId: number
  sessionId: number
  messageId: number | null
}

interface ChatNavigationOptions {
  isCurrent: (requestId: number) => boolean
  open: () => void
  mount: () => Promise<unknown>
  loadSession: (sessionId: number) => Promise<unknown>
  waitForSessionSettlement: (sessionId: number) => Promise<unknown>
  waitForStableScrollLayout: () => Promise<unknown>
  currentSessionId: () => number | null
  clear: (requestId: number) => boolean
  reveal: (messageId: number) => Promise<boolean>
  flash: (messageId: number) => void
  showUnavailable: () => void
}

/** 每个 await 后校验请求身份，避免过期导航消费或执行更新的导航请求。 */
export async function runChatNavigation(request: ChatNavigationRequest, options: ChatNavigationOptions) {
  const isCurrent = () => options.isCurrent(request.requestId)

  options.open()
  await options.mount()
  if (!isCurrent()) return

  await options.loadSession(request.sessionId)
  if (!isCurrent()) return

  await options.waitForSessionSettlement(request.sessionId)
  if (!isCurrent()) return

  await options.waitForStableScrollLayout()
  if (!isCurrent()) return

  if (options.currentSessionId() !== request.sessionId) {
    if (options.clear(request.requestId) && request.messageId != null) options.showUnavailable()
    return
  }

  if (!options.clear(request.requestId) || request.messageId == null) return

  const revealed = await options.reveal(request.messageId)
  if (!isCurrent()) return
  if (revealed) options.flash(request.messageId)
  else options.showUnavailable()
}

export type AuthScope = 'user' | 'admin'

const TOKEN_KEYS: Record<AuthScope, string> = {
  user: 'user_token',
  admin: 'admin_token',
}

const LOGIN_PATHS: Record<AuthScope, string> = {
  user: '/login',
  admin: '/admin/login',
}

let redirecting: AuthScope | null = null

/** 只处理已认证请求明确返回的 401，不把 403、5xx 或网络错误当成登出。 */
export function handleUnauthorized(scope: AuthScope): void {
  localStorage.removeItem(TOKEN_KEYS[scope])
  if (window.location.pathname === LOGIN_PATHS[scope] || redirecting === scope) return
  redirecting = scope
  window.location.assign(LOGIN_PATHS[scope])
  // 仅用于合并同一轮请求触发的重复跳转，不能影响用户重新登录后的后续会话。
  window.setTimeout(() => {
    if (redirecting === scope) redirecting = null
  }, 1000)
}

export function isUnauthorizedResponse(response: Response, scope: AuthScope = 'user'): boolean {
  if (response.status !== 401) return false
  handleUnauthorized(scope)
  return true
}

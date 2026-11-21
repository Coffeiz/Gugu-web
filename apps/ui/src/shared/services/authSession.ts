export type AuthScope = 'user' | 'admin'

const LOGIN_PATHS: Record<AuthScope, string> = {
  user: '/login',
  admin: '/admin/login',
}

let redirecting: AuthScope | null = null

/** 只处理已认证请求明确返回的 401，不把 403、5xx 或网络错误当成登出。 */
export function handleUnauthorized(scope: AuthScope): void {
  // 清理旧版本曾写入的 Bearer 凭据；新会话仅由服务端 HttpOnly Cookie 管理。
  localStorage.removeItem(scope === 'user' ? 'user_token' : 'admin_token')
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

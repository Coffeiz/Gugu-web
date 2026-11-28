export interface SafeEgressReadSettings {
  enabled: boolean
  proxy_url: string
  proxy_auth_secret: string
}

/** 读取配置只公开认证存在标记；历史 URL 若包含凭据则拒绝回显。 */
export function publicSafeEgressSettings(settings: SafeEgressReadSettings) {
  const raw = settings.proxy_url.trim()
  // GET 不验证可连接性或规范化历史地址，但不能把 URL userinfo 回显。
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*@/i.test(raw)) throw new Error('安全出站代理配置包含认证信息')
  let parsed: URL | null = null
  try { parsed = new URL(raw) } catch { /* 保留 Python 对历史非标准地址的只读语义。 */ }
  if (parsed?.username || parsed?.password) throw new Error('安全出站代理配置包含认证信息')
  return { enabled: settings.enabled, proxy_url: settings.proxy_url, has_auth: Boolean(settings.proxy_auth_secret) }
}

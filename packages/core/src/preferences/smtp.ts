import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, type Clock } from '../data/codec.js'

export interface SmtpSettings { host: string; port: number; user: string; fromAddr: string; useSsl: boolean; enabled: boolean }
export interface SmtpStore {
  read(ownerId: string): Promise<SmtpSettings | null>
  write(ownerId: string, settings: SmtpSettings, encryptedPassword: string | null): Promise<void>
}
function text(body: Record<string, unknown>, camel: string, snake: string, fallback: string, max: number): string {
  const value = body[camel] === undefined ? body[snake] : body[camel]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > max) throw new CoreError('invalid_request', `${camel} 无效`)
  return value
}
function boolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) return true
    if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) return false
  }
  throw new CoreError('invalid_request', `${field} 无效`)
}
export function parseSmtpSettings(value: unknown): { settings: SmtpSettings; password: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('invalid_request', '请求体无效')
  const body = value as Record<string, unknown>, host = text(body, 'host', 'host', '', 255)
  if (!host) throw new CoreError('invalid_request', 'host 无效')
  const raw = body.port === undefined ? 587 : body.port
  const port = typeof raw === 'string' && /^\+?\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new CoreError('invalid_request', 'port 无效')
  if (body.password != null && (typeof body.password !== 'string' || body.password.length > 1000)) throw new CoreError('invalid_request', 'password 无效')
  return { settings: { host, port, user: text(body, 'user', 'user', '', 300), fromAddr: text(body, 'fromAddr', 'from_addr', '', 300), useSsl: boolean(body.useSsl === undefined ? body.use_ssl : body.useSsl, 'useSsl', false), enabled: boolean(body.enabled, 'enabled', true) }, password: (body.password as string | null | undefined) ?? null }
}
/** 密码仅交给注入的加密器，不进入返回值或错误。 */
export function createUserSmtpSettings(store: SmtpStore, encrypt: (password: string) => string | Promise<string>) {
  return {
    async get(owner: string) { const settings = await store.read(owner); return settings ? { ...settings, configured: true } : null },
    async put(owner: string, body: unknown) {
      const { settings, password } = parseSmtpSettings(body)
      let encrypted: string | null = null
      if (password !== null) {
        try { encrypted = await encrypt(password) }
        catch { throw new CoreError('storage_error', 'SMTP 密码加密失败') }
      }
      await store.write(owner, settings, encrypted)
      return { ...settings, configured: true }
    },
  }
}
/** 单语句 upsert 使并发设置不会在保留密码时覆盖密文。 */
export function createKyselySmtpStore<DB>(db: Kysely<DB>, backend: 'sqlite' | 'postgres', clock: Clock = nowUtc): SmtpStore {
  const owner = (raw: string) => { const value = dataContext(raw).ownerId; return backend === 'sqlite' ? value.replaceAll('-', '') : value }
  return {
    async read(rawOwner) {
      const result = await sql<{ host: string; port: number; user: string; from_addr: string; use_ssl: boolean | number; enabled: boolean | number }>`SELECT host,port,"user",from_addr,use_ssl,enabled FROM user_smtp_configs WHERE user_id=${owner(rawOwner)}`.execute(db)
      const row = result.rows[0]
      return row ? { host: row.host, port: Number(row.port), user: row.user, fromAddr: row.from_addr, useSsl: Boolean(row.use_ssl), enabled: Boolean(row.enabled) } : null
    },
    async write(rawOwner, settings, password) {
      const ssl = backend === 'sqlite' ? Number(settings.useSsl) : settings.useSsl
      const enabled = backend === 'sqlite' ? Number(settings.enabled) : settings.enabled
      const timestamp = databaseTime(clock(), backend)
      await sql`INSERT INTO user_smtp_configs(user_id,host,port,"user",password,from_addr,use_ssl,enabled,updated_at)
        VALUES(${owner(rawOwner)},${settings.host},${settings.port},${settings.user},${password ?? ''},${settings.fromAddr},${ssl},${enabled},${timestamp})
        ON CONFLICT(user_id) DO UPDATE SET host=excluded.host,port=excluded.port,"user"=excluded."user",password=CASE WHEN CAST(${password} AS TEXT) IS NULL THEN user_smtp_configs.password ELSE excluded.password END,from_addr=excluded.from_addr,use_ssl=excluded.use_ssl,enabled=excluded.enabled,updated_at=excluded.updated_at`.execute(db)
    },
  }
}

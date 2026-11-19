import { CompiledQuery, Kysely, PostgresDialect, type PostgresPool } from 'kysely'
import type { PoolClient } from 'pg'
import type { Database } from './schema.js'

export interface BorrowedPostgresQuery {
  /** 仅用于已开启的外层事务，不允许改变事务或连接生命周期。 */
  query<Row>(text: string, parameters?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }>
}
const borrowed = new WeakSet<PoolClient>()
const mindSavepoint = /^(?:SAVEPOINT mind_undo_adapter|ROLLBACK TO SAVEPOINT mind_undo_adapter|RELEASE SAVEPOINT mind_undo_adapter)$/i
/** 扫描注释及引号，不能把 PostgreSQL 的嵌套注释当作第一处闭合。 */
function leadingWords(text: string): string[] | null {
  const words: string[] = []
  let index = 0, prefix = true
  while (index < text.length) {
    if (/\s/.test(text[index]!)) { index++; continue }
    if (text.startsWith('--', index)) { const end = text.slice(index + 2).search(/[\r\n]/); index = end < 0 ? text.length : index + 3 + end; continue }
    if (text.startsWith('/*', index)) {
      let depth = 1; index += 2
      while (depth && index < text.length) {
        if (text.startsWith('/*', index)) { depth++; index += 2 }
        else if (text.startsWith('*/', index)) { depth--; index += 2 }
        else index++
      }
      if (depth) return null
      continue
    }
    const quote = text[index]
    if (quote === "'" || quote === '"') {
      const escaped = quote === "'" && index > 0 && /[eE]/.test(text[index - 1]!) && (index < 2 || !/[\w$]/.test(text[index - 2]!))
      prefix = false; index++
      while (index < text.length) {
        if (escaped && text[index] === '\\') { index += 2; continue }
        if (text[index] === quote) { if (text[index + 1] === quote) { index += 2; continue } index++; break }
        index++
      }
      continue
    }
    if (quote === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(text.slice(index))?.[0]
      if (tag) { const end = text.indexOf(tag, index + tag.length); if (end < 0) return null; prefix = false; index = end + tag.length; continue }
    }
    const word = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(text.slice(index))?.[0]
    if (word) { if (prefix) words.push(word.toLowerCase()); index += word.length; continue }
    prefix = false; index++
  }
  return words
}
function allowed(text: string, allowMindSavepoint: boolean): boolean {
  if (typeof text !== 'string' || !text.trim() || text.includes(';')) return false
  const words = leadingWords(text)
  if (!words) return false
  const [first, second, third, fourth, fifth] = words
  const forbidden = ['begin', 'commit', 'rollback', 'savepoint', 'release', 'end', 'abort'].includes(first ?? '')
    || (first === 'start' && second === 'transaction') || (first === 'prepare' && second === 'transaction')
    || (first === 'set' && (['transaction', 'constraints'].includes(second ?? '')
      || (['local', 'session'].includes(second ?? '') && ['transaction', 'constraints'].includes(third ?? ''))
      || (second === 'session' && third === 'characteristics' && fourth === 'as' && fifth === 'transaction')))
  return !forbidden || (allowMindSavepoint && mindSavepoint.test(text.trim()))
}

async function borrow<T>(client: PoolClient, allowMindSavepoint: boolean, work: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  if (borrowed.has(client)) throw new Error('事务连接已被借用')
  borrowed.add(client)
  let active = true, pending: Promise<unknown> | null = null, driverQuery: Promise<unknown> | null = null
  const proxy = {
    query(text: string, parameters: readonly unknown[]) {
      if (!active) throw new Error('事务连接借用已结束')
      if (driverQuery) throw new Error('事务连接不支持并发查询')
      if (!allowed(text, allowMindSavepoint)) throw new Error('借用事务不允许事务控制或多语句')
      const current = client.query(text, [...parameters])
      driverQuery = current
      return current.finally(() => { if (driverQuery === current) driverQuery = null })
    },
    release() { /* 借用期间不释放外层 client。 */ },
  }
  const pool = { options: {}, async connect() { return proxy }, async end() { /* 外层拥有连接池。 */ } } as unknown as PostgresPool
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  function tracked<TValue>(run: () => Promise<TValue>): Promise<TValue> {
    if (!active) throw new Error('事务连接借用已结束')
    if (pending) throw new Error('事务连接不支持并发查询')
    const current = run()
    pending = current
    return current.finally(() => { if (pending === current) pending = null })
  }
  try {
    const result = await db.connection().execute(async connection => {
      const executor = connection.getExecutor()
      const guardedExecutor = new Proxy(executor, {
        get(target, property) {
          if (property === 'executeQuery') return (compiled: { sql: string }, ...args: unknown[]) => {
            if (!allowed(compiled.sql, allowMindSavepoint)) throw new Error('借用事务不允许事务控制或多语句')
            return tracked(() => Reflect.apply(target.executeQuery, target, [compiled, ...args]))
          }
          if (property !== 'transformQuery' && property !== 'compileQuery') return undefined
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      // 只暴露 raw SQL 所需的 executor，不提供 transaction/destroy/connection 等能力。
      const scoped = { getExecutor: () => guardedExecutor } as unknown as Kysely<Database>
      return work(scoped)
    })
    if (pending) { await Promise.allSettled([pending]); throw new Error('事务连接存在未等待的查询') }
    return result
  } finally {
    active = false
    if (pending) await Promise.allSettled([pending])
    if (driverQuery) await Promise.allSettled([driverQuery])
    try { await db.destroy() } finally { borrowed.delete(client) }
  }
}

/** 与旧 Agent 借用接口等价，只允许单条非事务控制 SQL。 */
export async function withBorrowedPostgresQuery<T>(client: PoolClient, work: (query: BorrowedPostgresQuery) => Promise<T>): Promise<T> {
  return borrow(client, false, async db => work({
    async query<Row>(text: string, parameters: readonly unknown[] = []) {
      if (!allowed(text, false)) throw new Error('借用事务不允许事务控制或多语句')
      const result = await db.getExecutor().executeQuery<Row>(CompiledQuery.raw(text, [...parameters]))
      return { rows: result.rows, rowCount: Number(result.numAffectedRows ?? result.rows.length) }
    },
  }))
}

/** 仅供 Mind adapter 使用；允许其固定 savepoint，不允许控制外层事务。 */
export async function withBorrowedMindPostgres<T>(client: PoolClient, work: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  return borrow(client, true, work)
}

/** 会话删除借用同一 PostgreSQL 事务，不允许控制外层事务。 */
export function withBorrowedAgentPostgres<T>(client: PoolClient, work: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  return borrow(client, false, work)
}

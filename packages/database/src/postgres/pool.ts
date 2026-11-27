import type { Pool, PoolClient, PoolConfig } from 'pg'
import { connectionFailed } from './transaction.js'

type ConnectCallback = Parameters<Pool['connect']>[0]

/** 在归还边界保护直接借用的连接，覆盖手写事务与 Kysely 驱动。 */
export function createPostgresPool(PgPool: typeof Pool, config: PoolConfig): Pool {
  class GuardedPool extends PgPool {
    override connect(): Promise<PoolClient>
    override connect(callback: ConnectCallback): void
    override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
      if (!callback) return super.connect().then(guardCheckout)
      super.connect((error, client, done) => {
        if (error || !client) return callback(error, client, done)
        guardCheckout(client)
        callback(error, client, client.release)
      })
    }
  }
  return new GuardedPool(config)
}

function guardCheckout(client: PoolClient): PoolClient {
  const query = client.query
  const release = client.release
  let released = false
  let broken = false
  const observeError = (error: unknown) => { broken ||= connectionFailed(error) }

  // pg 同时支持 Promise、回调和游标。保留原生调用形态，只观察查询错误。
  client.query = new Proxy(query, {
    apply(target, receiver, args) {
      const last = args.length - 1
      const callback = args[last]
      if (typeof callback === 'function') {
        args[last] = (error: unknown, ...values: unknown[]) => {
          observeError(error)
          return callback(error, ...values)
        }
      }
      try {
        const result = Reflect.apply(target, receiver, args)
        if (result instanceof Promise) return result.catch(error => {
          observeError(error)
          throw error
        })
        return result
      } catch (error) {
        observeError(error)
        throw error
      }
    },
  })
  client.release = error => {
    if (released) return release(error)
    released = true
    client.query = query
    release(error || broken || client.getTransactionStatus() !== 'I')
  }
  return client
}

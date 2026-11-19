import { connectRedisSocket, encodeCommand, parseResp, redisEndpoint, type RespValue, type RedisSocket } from './redis-protocol.js'

export interface LiveSubscriptionMessage {
  channel: string
  data: string
}

export interface LiveSubscription {
  next(signal: AbortSignal): Promise<LiveSubscriptionMessage | null>
  close(): Promise<void>
}

export type LiveSubscriptionFactory = (channels: readonly string[]) => Promise<LiveSubscription>

/** 不暴露 Redis 地址、响应内容或服务端错误文本。 */
export class RedisLiveSubscriptionError extends Error {
  constructor() {
    super('Redis live subscription unavailable')
    this.name = 'RedisLiveSubscriptionError'
  }
}

function abortError(): Error {
  const error = new Error('Live subscription aborted')
  error.name = 'AbortError'
  return error
}

function createConnection(redisUrl: string, channels: readonly string[]): Promise<LiveSubscription> {
  let endpoint: ReturnType<typeof redisEndpoint>
  let socket: RedisSocket
  try {
    endpoint = redisEndpoint(redisUrl)
    socket = connectRedisSocket(endpoint)
  } catch {
    throw new RedisLiveSubscriptionError()
  }

  return new Promise<LiveSubscription>((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let failed = false
    let ended = false
    let failure: RedisLiveSubscriptionError | null = null
    let queue: RespValue[] = []
    let waiters: Array<{
      resolve: (value: RespValue) => void
      reject: (error: Error) => void
      signal?: AbortSignal
      abort?: () => void
    }> = []

    const settleFailure = () => {
      if (failed) return
      failed = true
      failure = new RedisLiveSubscriptionError()
      for (const waiter of waiters.splice(0)) {
        waiter.signal?.removeEventListener('abort', waiter.abort!)
        waiter.reject(failure)
      }
    }

    const deliver = (value: RespValue) => {
      const waiter = waiters.shift()
      if (!waiter) {
        queue.push(value)
        return
      }
      waiter.signal?.removeEventListener('abort', waiter.abort!)
      waiter.resolve(value)
    }

    socket.on('data', (chunk: Buffer | string) => {
      if (failed) return
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      try {
        while (buffer.length > 0) {
          const parsed = parseResp(buffer)
          if (!parsed) break
          buffer = buffer.subarray(parsed.bytes)
          deliver(parsed.value)
        }
      } catch {
        settleFailure()
        socket.destroy()
      }
    })
    socket.on('error', settleFailure)
    socket.once('close', () => {
      ended = true
      settleFailure()
    })
    socket.setTimeout(10_000, () => socket.destroy())

    const nextReply = (signal?: AbortSignal): Promise<RespValue> => {
      if (signal?.aborted) return Promise.reject(abortError())
      if (queue.length) return Promise.resolve(queue.shift()!)
      if (failure) return Promise.reject(failure)
      return new Promise((replyResolve, replyReject) => {
        const waiter: (typeof waiters)[number] = { resolve: replyResolve, reject: replyReject, signal }
        if (signal) {
          waiter.abort = () => {
            waiters = waiters.filter((entry) => entry !== waiter)
            replyReject(abortError())
          }
          signal.addEventListener('abort', waiter.abort, { once: true })
        }
        waiters.push(waiter)
      })
    }

    const command = async (...parts: string[]): Promise<RespValue> => {
      if (failed || ended || socket.destroyed) throw failure ?? new RedisLiveSubscriptionError()
      socket.write(encodeCommand(parts))
      return nextReply()
    }

    const initialize = async () => {
      try {
        const connected = new Promise<void>((connectedResolve, connectedReject) => {
          const event = endpoint.tls ? 'secureConnect' : 'connect'
          socket.once(event, connectedResolve)
          socket.once('error', connectedReject)
        })
        await connected
        const username = endpoint.username
        const password = endpoint.password
        if (password) {
          const auth = username ? await command('AUTH', username, password) : await command('AUTH', password)
          if (auth !== 'OK') throw new RedisLiveSubscriptionError()
        }
        const database = endpoint.database
        if (database && !/^\d+$/.test(database)) throw new RedisLiveSubscriptionError()
        if (database && Number(database) !== 0) {
          if (await command('SELECT', database) !== 'OK') throw new RedisLiveSubscriptionError()
        }

        socket.write(encodeCommand(['SUBSCRIBE', ...channels]))
        for (let index = 0; index < channels.length; index += 1) {
          const reply = await nextReply()
          if (!Array.isArray(reply) || reply[0] !== 'subscribe' || reply[1] !== channels[index])
            throw new RedisLiveSubscriptionError()
        }
        socket.setTimeout(0)

        let closed = false
        const subscription: LiveSubscription = {
          async next(signal) {
            try {
              for (;;) {
                const reply = await nextReply(signal)
                if (Array.isArray(reply) && reply[0] === 'message'
                  && typeof reply[1] === 'string' && typeof reply[2] === 'string') {
                  return { channel: reply[1], data: reply[2] }
                }
                if (signal.aborted) throw abortError()
                throw new RedisLiveSubscriptionError()
              }
            } catch (error) {
              if (error instanceof Error && error.name === 'AbortError') throw error
              throw new RedisLiveSubscriptionError()
            }
          },
          async close() {
            if (closed) return
            closed = true
            if (socket.destroyed || failed) {
              socket.destroy()
              return
            }
            let timeout: ReturnType<typeof setTimeout> | undefined
            try {
              socket.write(encodeCommand(['UNSUBSCRIBE', ...channels]))
              let acknowledgements = 0
              await Promise.race([
                (async () => {
                  while (acknowledgements < channels.length) {
                    const reply = await nextReply()
                    if (Array.isArray(reply) && reply[0] === 'unsubscribe') acknowledgements += 1
                    else if (!Array.isArray(reply) || reply[0] !== 'message')
                      throw new RedisLiveSubscriptionError()
                  }
                })(),
                new Promise<void>((timerResolve) => { timeout = setTimeout(timerResolve, 3_000) }),
              ])
            } catch {
              // Closing a dropped Redis connection is best-effort; never expose the Redis error.
            } finally {
              if (timeout) clearTimeout(timeout)
              socket.destroy()
            }
          },
        }
        resolve(subscription)
      } catch {
        settleFailure()
        socket.destroy()
        reject(new RedisLiveSubscriptionError())
      }
    }

    void initialize()
  })
}

export function createRedisLiveSubscription(redisUrl: string | null | undefined): LiveSubscriptionFactory {
  return async (channels) => {
    if (!redisUrl || !channels.length || channels.some((channel) => !channel || /[\r\n]/.test(channel)))
      throw new RedisLiveSubscriptionError()
    return createConnection(redisUrl, channels)
  }
}

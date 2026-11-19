import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

export type ImRuntimeOwnership = { runtime: 'python' } | { runtime: 'node'; pythonGatewayStopped: boolean; pythonImConsumerStopped: boolean }
/** 只读部署归属；这些显式断言不自行停止Python或修改用户配置。 */
export function readImRuntimeOwnership(env: NodeJS.ProcessEnv): ImRuntimeOwnership {
  const owner = env.IM__RUNTIME_OWNER?.trim().toLowerCase() || 'python'
  if (owner === 'python') return { runtime: 'python' }
  if (owner !== 'node') throw new Error('IM 消费归属配置无效')
  const truth = (value: string | undefined) => value === 'true' || value === '1'
  return { runtime: 'node', pythonGatewayStopped: truth(env.IM__PYTHON_GATEWAY_STOPPED), pythonImConsumerStopped: truth(env.IM__PYTHON_WORKER_STOPPED) }
}
export interface ImHostOwnershipLease { readonly lost: Promise<void>; close(): Promise<void> }
/** 装配尚未返回组件但资源清理不确定时，同样不能释放Node唯一归属。 */
export class ImHostAssemblyCleanupError extends Error {
  constructor() { super('IM 生产装配资源清理未完成') }
}
/** Node进程之间互斥；Python不识别此锁，因此仍必须显式完成双消费者停机交接。 */
export async function acquireImHostOwnership(pool: Pick<Pool, 'connect'>): Promise<ImHostOwnershipLease> {
  let client: PoolClient
  try { client = await pool.connect() } catch { throw new Error('IM 消费归属锁不可用') }
  const hash = createHash('sha256').update('gugu-node-im-host-owner-v1').digest(), keys = [hash.readInt32BE(0), hash.readInt32BE(4)]
  let closed = false, failed = false, resolveLost!: () => void
  const lost = new Promise<void>(resolve => { resolveLost = resolve })
  const onLost = () => { if (!closed) { failed = true; resolveLost() } }
  client.on('error', onLost); client.on('end', onLost)
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1,$2) AS locked', keys)
    if (result.rows[0]?.locked !== true || failed) throw new Error('IM 消费归属锁不可用')
  } catch {
    client.removeListener('error', onLost); client.removeListener('end', onLost); client.release(true)
    throw new Error('IM 消费归属锁不可用')
  }
  return { lost, async close() {
    if (closed) return
    closed = true
    try {
      if (!failed && (await client.query('SELECT pg_advisory_unlock($1,$2) AS unlocked', keys)).rows[0]?.unlocked !== true) throw new Error()
    } catch { failed = true; throw new Error('IM 消费归属锁释放失败') }
    finally { client.removeListener('error', onLost); client.removeListener('end', onLost); client.release(failed) }
  } }
}
interface LifecycleService { start(): void | Promise<void>; stop(): Promise<void>; health?(): unknown }
export interface ImHostComponents {
  supervisor: LifecycleService
  worker: LifecycleService
  /** 每次扫描有界；必须只选择已证明的IM来源，不得把Web调度项改成IM。 */
  scanDispatch(signal: AbortSignal): Promise<void>
  recoverDeliveries(signal: AbortSignal): Promise<void>
  pumpPending(signal: AbortSignal): Promise<void>
  pumpInteractions(signal: AbortSignal): Promise<void>
  /** 保留服务独立扫描；旧组件夹具可不装配，正式工厂必须接通。 */
  maintain?(signal:AbortSignal):Promise<void>
  reflection: LifecycleService
  close(): Promise<void>
}
type LoopName = 'dispatch' | 'delivery' | 'pending' | 'interaction' | 'maintenance'
/** 正式bootstrap交付完整组件；lazy构造确保Python默认归属零Node连接、零消费者和零后台写入。 */
export function createImHostLifecycle(options: {
  ownership: ImRuntimeOwnership
  acquire(): Promise<ImHostOwnershipLease>
  components(): Promise<ImHostComponents>
  intervalMs?: number
  diagnose(code: 'ownership_lost' | 'dispatch_unavailable' | 'delivery_unavailable' | 'pending_unavailable' | 'interaction_unavailable' | 'maintenance_unavailable' | 'cleanup_failed'): void
}) {
  const interval = options.intervalMs ?? 10000
  if (!Number.isSafeInteger(interval) || interval < 10 || interval > 300000) throw new Error('IM 后台扫描间隔无效')
  const controller = new AbortController(), tasks: Promise<void>[] = [], started: LifecycleService[] = []
  let state: 'disabled' | 'stopped' | 'starting' | 'running' | 'stopping' | 'uncertain' = options.ownership.runtime === 'python' ? 'disabled' : 'stopped'
  let lease: ImHostOwnershipLease | undefined, components: ImHostComponents | undefined, startPromise: Promise<void> | undefined, stopPromise: Promise<void> | undefined
  let construction = Promise.resolve(), finishConstruction = () => {}
  let assemblyCleanupUnknown = false
  const health: Partial<Record<LoopName, 'stopped' | 'running' | 'degraded'>> = { dispatch: 'stopped', delivery: 'stopped', pending: 'stopped', interaction: 'stopped' }
  const pendingWake = new Set<LoopName>(), waiting = new Map<LoopName, () => void>()
  const report = (code: Parameters<typeof options.diagnose>[0]) => { try { options.diagnose(code) } catch { /* 固定诊断失败不能释放消费归属。 */ } }
  function loop(name: LoopName, run: (signal: AbortSignal) => Promise<void>) {
    tasks.push((async () => {
      while (!controller.signal.aborted) {
        try { await run(controller.signal); health[name] = 'running' }
        catch { if (!controller.signal.aborted) { health[name] = 'degraded'; report(`${name}_unavailable`) } }
        if (pendingWake.delete(name)) continue
        if (!controller.signal.aborted) await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); waiting.delete(name); pendingWake.delete(name); resolve() }
          const timer = setTimeout(done, interval)
          waiting.set(name, done); controller.signal.addEventListener('abort', done, { once: true })
          if (controller.signal.aborted || pendingWake.has(name)) done()
        })
      }
      health[name] = 'stopped'
    })())
  }
  async function stop() {
    if (state === 'disabled') return
    return stopPromise ??= (async () => {
      state = 'stopping'
      // 先阻止新协议入站，再中断队列读和后台扫描；已在运行的业务排空，不主动取消Agent。
      let failed = false
      controller.abort()
      // start与stop可并发；已进入start的服务先取消，尚在取得连接的构造必须完成后再关底层资源。
      for (const service of [...started].reverse()) try { await service.stop() } catch { failed = true }
      await construction
      failed ||= assemblyCleanupUnknown
      await Promise.allSettled(tasks)
      if (components) try { await components.close() } catch { failed = true }
      if (failed) {
        // 清理不确定时保留仍有效的进程归属锁，不能允许另一个Node重复消费。
        state = 'uncertain'; report('cleanup_failed'); throw new Error('IM 运行资源清理未完成')
      }
      try { await lease?.close() } catch { state = 'uncertain'; report('cleanup_failed'); throw new Error('IM 运行资源清理未完成') }
      state = 'stopped'
    })()
  }
  return {
    /** 已提交的控制/入站事务只唤醒后台循环，不把整段Agent执行堵在平台callback上。 */
    wake(name: LoopName) { if (state !== 'disabled' && !controller.signal.aborted) { pendingWake.add(name); waiting.get(name)?.() } },
    health() { return { ownership: options.ownership.runtime, status: state, loops: { ...health }, supervisor: components?.supervisor.health?.() ?? null, worker: components?.worker.health?.() ?? null } },
    start(): Promise<void> {
      if (state === 'disabled') return Promise.resolve()
      return startPromise ??= (async () => {
        if (controller.signal.aborted || state !== 'stopped') throw new Error('IM 运行生命周期不可重复启动')
        if (options.ownership.runtime !== 'node' || !options.ownership.pythonGatewayStopped || !options.ownership.pythonImConsumerStopped) throw new Error('IM 消费归属尚未切换')
        state = 'starting'
        construction = new Promise<void>(resolve => { finishConstruction = resolve })
        try {
          lease = await options.acquire()
          controller.signal.throwIfAborted()
          void lease.lost.then(() => { if (!controller.signal.aborted) { report('ownership_lost'); void stop().catch(() => undefined) } })
          components = await options.components()
          controller.signal.throwIfAborted()
          for (const service of [components.reflection, components.worker, components.supervisor]) {
            controller.signal.throwIfAborted(); started.push(service); await service.start()
          }
          controller.signal.throwIfAborted()
          finishConstruction()
          state = 'running'
          loop('dispatch', components.scanDispatch); loop('delivery', components.recoverDeliveries)
          loop('pending', components.pumpPending); loop('interaction', components.pumpInteractions)
          if(components.maintain)loop('maintenance',components.maintain)
        } catch (error) {
          assemblyCleanupUnknown ||= error instanceof ImHostAssemblyCleanupError
          finishConstruction(); await stop(); throw new Error('IM 运行启动未完成')
        }
      })()
    }, stop,
  }
}

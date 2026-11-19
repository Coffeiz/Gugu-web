/** Host 配置监督器；配置读取、通知连接及平台生命周期由生产装配显式注入。 */
export interface GatewayBotSpec {
  key: string;
  /** 可信配置版本，必须随影响连接的字段改变；不可使用凭据作为公开版本。 */
  revision: string;
}
export interface GatewayConnection {
  /** 仅在资源全部释放时resolve；reject表示清理未知，监督器不得替代启动。 */
  closed: Promise<void>;
  /** 必须中断连接并等待所有入站任务退出。 */
  stop(): Promise<void>;
}
/** 首次连接尚未交付，但底层资源释放未知；不能按普通握手失败启动替代消费者。 */
export class GatewayConnectionCleanupError extends Error {
  constructor() { super('网关初始连接资源清理未完成'); }
}
export interface GatewaySubscription {
  disconnected: Promise<void>;
  close(): Promise<void>;
}
export interface GatewayClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
export interface GatewaySupervisorPorts<S extends GatewayBotSpec> {
  read(): Promise<readonly S[]>;
  subscribe(notify: () => void, signal: AbortSignal): Promise<GatewaySubscription>;
  connect(spec: S, signal: AbortSignal): Promise<GatewayConnection>;
  clock?: GatewayClock;
  /** 只发送固定事件码，不传播凭据、用户输入或异常文本。 */
  report?(event: 'config-unavailable' | 'listener-unavailable' | 'connection-failed' | 'cleanup-failed'): void;
}
const clock: GatewayClock = {
  now: () => performance.now(),
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(finish, ms);
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
    });
  },
};

export function createGatewaySupervisor<S extends GatewayBotSpec>(ports: GatewaySupervisorPorts<S>) {
  const time = ports.clock ?? clock;
  const lifetime = new AbortController();
  const active = new Map<string, { spec: S; connection: GatewayConnection; started: number; controller: AbortController }>();
  const retries = new Map<string, { revision: string; controller: AbortController }>();
  const failures = new Map<string, number>();
  const uncertain = new Set<string>();
  const timers = new Set<Promise<void>>();
  let desired = new Map<string, S>();
  let serial = Promise.resolve();
  let queued = false;
  let stopping = false;
  let listener: Promise<void> | undefined;
  let subscription: GatewaySubscription | undefined;
  let configRetry: AbortController | undefined;
  let configDelay = 5_000;
  let startResult: Promise<void> | undefined;
  let configuration: 'unknown' | 'ready' | 'unavailable' = 'unknown';
  let notifications: 'connecting' | 'connected' | 'disconnected' | 'stopped' = 'stopped';

  function later(ms: number, controller: AbortController, action: () => void) {
    const task = time.sleep(ms, controller.signal).then(action, () => undefined);
    timers.add(task);
    void task.finally(() => timers.delete(task));
  }
  function retry(spec: S) {
    const count = (failures.get(spec.key) ?? 0) + 1;
    failures.set(spec.key, count);
    const controller = new AbortController();
    retries.set(spec.key, { revision: spec.revision, controller });
    later(Math.min(10_000 * 2 ** Math.min(count - 1, 5), 300_000), controller, () => {
      if (retries.get(spec.key)?.controller !== controller) return;
      retries.delete(spec.key);
      notify();
    });
  }
  async function drain(entry: { connection: GatewayConnection; controller: AbortController }) {
    entry.controller.abort();
    // 清理失败时拒绝替代启动，不能让两个消费者同时存在。
    await entry.connection.stop();
  }
  async function reconcile() {
    if (stopping) return;
    let specs: readonly S[];
    try { specs = await ports.read(); }
    catch {
      configuration = 'unavailable';
      ports.report?.('config-unavailable');
      if (!configRetry && !stopping) {
        const controller = new AbortController();
        configRetry = controller;
        later(configDelay, controller, () => { configRetry = undefined; notify(); });
        configDelay = Math.min(configDelay * 2, 60_000);
      }
      return;
    }
    if (stopping) return;
    configuration = 'ready';
    configRetry?.abort(); configRetry = undefined; configDelay = 5_000;
    desired = new Map(specs.map(spec => [spec.key, spec]));
    for (const [key, pending] of retries) {
      if (desired.get(key)?.revision === pending.revision) continue;
      pending.controller.abort(); retries.delete(key); failures.delete(key);
    }
    for (const [key, entry] of active) {
      if (desired.get(key)?.revision === entry.spec.revision) continue;
      try { await drain(entry); }
      catch (error) { uncertain.add(key); throw error; }
      active.delete(key); uncertain.delete(key); failures.delete(key);
    }
    for (const spec of desired.values()) {
      if (stopping || active.has(spec.key) || retries.has(spec.key) || uncertain.has(spec.key)) continue;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      lifetime.signal.addEventListener('abort', cancel, { once: true });
      try {
        const connection = await ports.connect(spec, controller.signal);
        const entry = { spec, connection, controller, started: time.now() };
        active.set(spec.key, entry);
        void connection.closed.then(() => {
          if (stopping || controller.signal.aborted || active.get(spec.key) !== entry) return;
          active.delete(spec.key);
          uncertain.delete(spec.key);
          if (time.now() - entry.started < 5_000) retry(spec);
          else { failures.delete(spec.key); notify(); }
        }, () => {
          // 无法证明旧消费者已释放时保留归属，不能通过重启制造双消费。
          if (active.get(spec.key) === entry) {
            uncertain.add(spec.key);
            if (!stopping) ports.report?.('cleanup-failed');
          }
        });
        if (stopping) { await drain(entry); active.delete(spec.key); }
      } catch (error) {
        if (error instanceof GatewayConnectionCleanupError) {
          uncertain.add(spec.key);
          if (!stopping) ports.report?.('cleanup-failed');
        } else if (!stopping) { ports.report?.('connection-failed'); retry(spec); }
      } finally { lifetime.signal.removeEventListener('abort', cancel); }
    }
  }
  function notify() {
    if (stopping || queued) return;
    queued = true;
    serial = serial.then(async () => {
      queued = false;
      try { await reconcile(); } catch { ports.report?.('cleanup-failed'); }
    });
  }
  async function listen(ready: () => void) {
    let delay = 1_000;
    while (!stopping) {
      try {
        subscription = await ports.subscribe(notify, lifetime.signal);
        if (stopping) break;
        notifications = 'connected';
        // 每次成功订阅都重新读权威快照，补回离线通知。
        notify(); ready(); delay = 1_000;
        let aborted!: () => void;
        try {
          await Promise.race([
            subscription.disconnected,
            new Promise<void>(resolve => {
              aborted = resolve;
              lifetime.signal.addEventListener('abort', aborted, { once: true });
            }),
          ]);
        } finally { lifetime.signal.removeEventListener('abort', aborted); }
      } catch { if (!stopping) ports.report?.('listener-unavailable'); }
      finally {
        notifications = stopping ? 'stopped' : 'disconnected';
        if (subscription) {
          try { await subscription.close(); } catch { ports.report?.('cleanup-failed'); }
          subscription = undefined;
        }
      }
      if (!stopping) {
        await time.sleep(delay, lifetime.signal).catch(() => undefined);
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }
  return {
    start(): Promise<void> {
      if (stopping) return Promise.reject(new Error('监督器已停止'));
      if (!startResult) startResult = new Promise<void>(resolve => {
        notifications = 'connecting';
        lifetime.signal.addEventListener('abort', () => resolve(), { once: true });
        listener = listen(resolve);
      });
      return startResult;
    },
    /** 等待目前已排队的配置对账，供健康检查/受控测试使用。 */
    settled: () => serial,
    /** Host提交后的配置/绑定失效沿同一串行全量对账处理。 */
    refresh: notify,
    status: () => ({ running: active.size, retrying: retries.size, stopping }),
    /** 固定状态及计数；不公开Bot标识、配置版本、凭据或底层异常。 */
    health: () => ({ configuration, notifications, configured: desired.size,
      running: [...active.keys()].filter(key => !uncertain.has(key)).length, cleanupUnknown: uncertain.size, retrying: retries.size, stopping }),
    async stop() {
      stopping = true; lifetime.abort(); configRetry?.abort();
      for (const retry of retries.values()) retry.controller.abort();
      retries.clear();
      for (const entry of active.values()) entry.controller.abort();
      await listener;
      await serial;
      // 排空所有连接后再返回；失败向调用方传播，不能声称已释放消费者。
      const entries = [...active.entries()];
      const results = await Promise.allSettled(entries.map(([, entry]) => drain(entry)));
      results.forEach((result, index) => {
        const key = entries[index]![0];
        if (result.status === 'fulfilled') { active.delete(key); uncertain.delete(key); }
        else uncertain.add(key);
      });
      await Promise.allSettled([...timers]);
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), '网关连接未能完全停止');
      // 初次握手失败时可能没有可交付的connection，不能因active为空声称已释放消费者。
      if (uncertain.size) throw new GatewayConnectionCleanupError();
    },
  };
}

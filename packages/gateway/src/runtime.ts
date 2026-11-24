import { GatewayConnectionCleanupError, type GatewayBotSpec, type GatewayClock, type GatewayConnection, type GatewaySubscription, type GatewaySupervisorPorts } from './contracts.js'

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
  let onConfigured: (() => void) | undefined;
  let serial = Promise.resolve();
  let queued = false;
  let refreshAfterSleep = false;
  let stopping = false;
  let suspended = false;
  let connecting: AbortController | undefined;
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
  async function drainActiveConnections() {
    const entries = [...active.entries()];
    const results = await Promise.allSettled(entries.map(([, entry]) => drain(entry)));
    return results.flatMap((result, index) => {
      const key = entries[index]![0];
      if (result.status === 'rejected') {
        uncertain.add(key);
        return [result.reason];
      }
      active.delete(key); uncertain.delete(key); failures.delete(key);
      return [];
    });
  }
  async function reconcile() {
    if (stopping || suspended) return;
    let specs: readonly S[];
    try { specs = await ports.read(); }
    catch (error) {
      configuration = 'unavailable';
      ports.report?.('config-unavailable', error);
      if (!configRetry && !stopping) {
        const controller = new AbortController();
        configRetry = controller;
        later(configDelay, controller, () => { configRetry = undefined; notify(); });
        configDelay = Math.min(configDelay * 2, 60_000);
      }
      return;
    }
    if (stopping || suspended) return;
    const afterSleep = refreshAfterSleep;
    refreshAfterSleep = false;
    configuration = 'ready';
    configRetry?.abort(); configRetry = undefined; configDelay = 5_000;
    const previousCount = desired.size;
    desired = new Map(specs.map(spec => [spec.key, spec]));
    if (desired.size !== previousCount) onConfigured?.();
    for (const [key, pending] of retries) {
      if (!afterSleep && desired.get(key)?.revision === pending.revision) continue;
      pending.controller.abort(); retries.delete(key); failures.delete(key);
    }
    for (const [key, entry] of active) {
      if (desired.get(key)?.revision === entry.spec.revision && (!afterSleep || uncertain.has(key))) continue;
      try { await drain(entry); }
      catch (error) { uncertain.add(key); throw error; }
      active.delete(key); uncertain.delete(key); failures.delete(key);
    }
    for (const spec of desired.values()) {
      if (stopping || suspended || active.has(spec.key) || retries.has(spec.key) || uncertain.has(spec.key)) continue;
      const controller = new AbortController();
      connecting = controller;
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
        }, error => {
          // 无法证明旧消费者已释放时保留归属，不能通过重启制造双消费。
          if (active.get(spec.key) === entry) {
            uncertain.add(spec.key);
            if (!stopping) ports.report?.('cleanup-failed', error);
          }
        });
        if (stopping || suspended) { await drain(entry); active.delete(spec.key); }
      } catch (error) {
        if (error instanceof GatewayConnectionCleanupError) {
          uncertain.add(spec.key);
          if (!stopping) ports.report?.('cleanup-failed', error);
        } else if (!stopping && !suspended) { ports.report?.('connection-failed', error); retry(spec); }
      } finally { connecting = undefined; lifetime.signal.removeEventListener('abort', cancel); }
    }
  }
  function notify() {
    if (stopping || suspended || queued) return;
    queued = true;
    serial = serial.then(async () => {
      queued = false;
      try { await reconcile(); } catch (error) { ports.report?.('cleanup-failed', error); }
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
      } catch (error) { if (!stopping) ports.report?.('listener-unavailable', error); }
      finally {
        notifications = stopping ? 'stopped' : 'disconnected';
        if (subscription) {
          try { await subscription.close(); } catch (error) { ports.report?.('cleanup-failed', error); }
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
    onConfigurationChanged(listener: () => void) { onConfigured = listener; },
    suspend() {
      if (stopping || suspended) return serial;
      suspended = true;
      connecting?.abort();
      configRetry?.abort(); configRetry = undefined;
      for (const retry of retries.values()) retry.controller.abort();
      retries.clear(); failures.clear();
      for (const entry of active.values()) entry.controller.abort();
      serial = serial.then(async () => {
        for (const error of await drainActiveConnections()) ports.report?.('cleanup-failed', error);
      });
      return serial;
    },
    /** 睡眠前的长连接可能仍显示在线，重新对账并排空旧连接后再启动。 */
    resume() {
      suspended = false;
      refreshAfterSleep = true;
      notify();
      return serial;
    },
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
      const errors = await drainActiveConnections();
      await Promise.allSettled([...timers]);
      if (errors.length) throw new AggregateError(errors, '网关连接未能完全停止');
      // 初次握手失败时可能没有可交付的connection，不能因active为空声称已释放消费者。
      if (uncertain.size) throw new GatewayConnectionCleanupError();
    },
  };
}

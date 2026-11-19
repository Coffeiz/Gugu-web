import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGatewaySupervisor, GatewayConnectionCleanupError } from '@gugu/gateway';
import type { GatewayBotSpec, GatewayClock } from '@gugu/gateway';

test('连接清理未知时保留旧归属，不启动替代消费者', async () => {
  let notify = () => {};
  let connected = 0, stopped = 0;
  const reports: string[] = [];
  const supervisor = createGatewaySupervisor({
    async read() { return [{ key: 'qq:7', revision: '1' }]; },
    async subscribe(callback) {
      notify = callback;
      return { disconnected: new Promise<void>(() => {}), async close() {} };
    },
    async connect() {
      connected++;
      return { closed: Promise.reject(new Error('合成清理故障')), async stop() { stopped++; } };
    },
    report(event) { reports.push(event); },
  });
  await supervisor.start(); await supervisor.settled(); await flush();
  notify(); await supervisor.settled();
  assert.equal(connected, 1);
  assert.deepEqual(supervisor.status(), { running: 1, retrying: 0, stopping: false });
  assert.deepEqual(reports, ['cleanup-failed']);
  assert.deepEqual(supervisor.health(), { configuration: 'ready', notifications: 'connected', configured: 1,
    running: 0, cleanupUnknown: 1, retrying: 0, stopping: false });
  await supervisor.stop();
  assert.equal(stopped, 1);
  assert.equal(supervisor.health().cleanupUnknown, 0);
  assert.equal(supervisor.health().notifications, 'stopped');
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

test('首次握手清理未知时冻结Bot归属，刷新/改版/删除不替代连接且停止拒绝释放归属', async () => {
  let connections = 0;
  let specs: GatewayBotSpec[] = [{ key: 'feishu:synthetic', revision: '1' }];
  const reports: string[] = [];
  const supervisor = createGatewaySupervisor({
    async read() { return specs; },
    async subscribe() { return { disconnected: new Promise<void>(() => {}), async close() {} }; },
    async connect() { connections++; throw new GatewayConnectionCleanupError(); },
    report: code => { reports.push(code); },
  });
  await supervisor.start(); await supervisor.settled();
  assert.equal(connections, 1);
  assert.deepEqual(supervisor.health(), { configuration: 'ready', notifications: 'connected', configured: 1,
    running: 0, cleanupUnknown: 1, retrying: 0, stopping: false });
  supervisor.refresh(); await supervisor.settled();
  specs = [{ key: 'feishu:synthetic', revision: '2' }];
  supervisor.refresh(); await supervisor.settled();
  specs = []; supervisor.refresh(); await supervisor.settled();
  specs = [{ key: 'feishu:synthetic', revision: '3' }, { key: 'qq:synthetic', revision: '1' }];
  supervisor.refresh(); await supervisor.settled();
  assert.equal(connections, 2, '未知Bot不能重连；其他Bot仍独立尝试连接');
  assert.equal(supervisor.health().cleanupUnknown, 2);
  assert.equal(supervisor.health().running, 0);
  assert.deepEqual(reports, ['cleanup-failed', 'cleanup-failed']);
  await assert.rejects(supervisor.stop(), GatewayConnectionCleanupError);
});
function fixture() {
  let now = 0;
  const waits: { at: number; resolve(): void }[] = [];
  const clock: GatewayClock = {
    now: () => now,
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        const item = { at: now + ms, resolve: () => { signal.removeEventListener('abort', abort); resolve(); } };
        const abort = () => { const index = waits.indexOf(item); if (index >= 0) waits.splice(index, 1); reject(new Error('取消')); };
        signal.addEventListener('abort', abort, { once: true }); waits.push(item);
      });
    },
  };
  let specs: GatewayBotSpec[] = [{ key: 'telegram:synthetic', revision: '1' }];
  let failRead = false;
  let notify = () => {};
  let disconnected = deferred();
  let stopGate: ReturnType<typeof deferred> | undefined;
  const connections: { revision: string; closed: ReturnType<typeof deferred>; stopped: boolean }[] = [];
  const events: string[] = [];
  const supervisor = createGatewaySupervisor({
    clock,
    async subscribe(callback) {
      events.push('subscribe'); notify = callback; disconnected = deferred();
      return { disconnected: disconnected.promise, async close() { events.push('unsubscribe'); } };
    },
    async read() { events.push('read'); if (failRead) throw new Error('合成故障'); return specs; },
    async connect(spec) {
      events.push(`connect:${spec.revision}`);
      const record = { revision: spec.revision, closed: deferred(), stopped: false };
      connections.push(record);
      return { closed: record.closed.promise, async stop() {
        events.push(`stop:${record.revision}`); await stopGate?.promise;
        record.stopped = true; record.closed.resolve();
      } };
    },
  });
  return {
    supervisor, events, connections,
    update(next: GatewayBotSpec[]) { specs = next; notify(); },
    silentUpdate(next: GatewayBotSpec[]) { specs = next; },
    failRead(value: boolean) { failRead = value; notify(); },
    disconnect: () => disconnected.resolve(),
    gate() { stopGate = deferred(); return stopGate; },
    async advance(ms: number) {
      now += ms;
      for (const item of [...waits]) if (item.at <= now) { waits.splice(waits.indexOf(item), 1); item.resolve(); }
      await flush(); await supervisor.settled();
    },
  };
}

test('先订阅再读快照；数据库失败保留连接，重连补回停用配置', async () => {
  const f = fixture(); await f.supervisor.start(); await f.supervisor.settled();
  assert.deepEqual(f.events.slice(0, 3), ['subscribe', 'read', 'connect:1']);
  assert.equal(f.supervisor.health().configuration, 'ready');
  f.failRead(true); await f.supervisor.settled();
  assert.equal(f.connections[0]!.stopped, false);
  assert.equal(f.supervisor.health().configuration, 'unavailable');
  assert.equal(f.supervisor.health().running, 1);
  f.failRead(false); await f.supervisor.settled();
  assert.equal(f.supervisor.health().configuration, 'ready');
  f.silentUpdate([]);
  f.disconnect(); await flush(); await f.advance(1_000);
  assert.equal(f.connections[0]!.stopped, true);
  assert.equal(f.events.filter(event => event === 'subscribe').length, 2);
  assert.equal(f.supervisor.status().running, 0);
  assert.equal(f.supervisor.health().notifications, 'connected');
  assert.equal(f.supervisor.health().configured, 0);
  await f.supervisor.stop();
});

test('配置改变必须排空旧连接，停止期间不能启动替代消费者', async () => {
  const f = fixture(); await f.supervisor.start(); await f.supervisor.settled();
  const gate = f.gate(); f.update([{ key: 'telegram:synthetic', revision: '2' }]); await flush();
  assert.equal(f.connections.length, 1);
  let stopped = false; const stopping = f.supervisor.stop().then(() => { stopped = true; });
  await flush(); assert.equal(stopped, false);
  gate.resolve(); await stopping;
  assert.equal(f.connections.length, 1);
  assert.equal(f.connections[0]!.stopped, true);
  assert.equal(f.supervisor.status().running, 0);
});

test('秒崩指数退避，配置变更取消旧重试，停用后不复活', async () => {
  const f = fixture(); await f.supervisor.start(); await f.supervisor.settled();
  f.connections[0]!.closed.resolve(); await flush();
  await f.advance(9_999); assert.equal(f.connections.length, 1);
  await f.advance(1); assert.equal(f.connections.length, 2);
  f.connections[1]!.closed.resolve(); await flush();
  await f.advance(19_999); assert.equal(f.connections.length, 2);
  f.update([{ key: 'telegram:synthetic', revision: '2' }]); await f.supervisor.settled();
  assert.equal(f.connections.length, 3);
  f.update([]); await f.supervisor.settled(); await f.advance(300_000);
  assert.equal(f.connections.length, 3);
  await f.supervisor.stop();
});

test('运行超过秒崩窗口后立即恢复；停止撤销后续退避', async () => {
  const f = fixture(); await f.supervisor.start(); await f.supervisor.settled();
  await f.advance(5_000); f.connections[0]!.closed.resolve(); await flush(); await f.supervisor.settled();
  assert.equal(f.connections.length, 2);
  f.connections[1]!.closed.resolve(); await flush(); await f.supervisor.stop(); await f.advance(300_000);
  assert.equal(f.connections.length, 2);
});

test('正常换配置的连接关闭不触发旧版本秒崩重试', async () => {
  const f = fixture(); await f.supervisor.start(); await f.supervisor.settled();
  f.update([{ key: 'telegram:synthetic', revision: '2' }]); await f.supervisor.settled(); await flush();
  assert.deepEqual(f.events.filter(event => /^(connect|stop):/.test(event)), ['connect:1', 'stop:1', 'connect:2']);
  assert.equal(f.supervisor.status().retrying, 0);
  await f.supervisor.stop();
});

test('连续秒崩退避上限300秒，其他Bot可独立启动', async () => {
  const f = fixture(); await f.supervisor.start(); await f.supervisor.settled();
  for (const delay of [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]) {
    const count = f.connections.length;
    f.connections[count - 1]!.closed.resolve(); await flush();
    await f.advance(delay - 1); assert.equal(f.connections.length, count);
    await f.advance(1); assert.equal(f.connections.length, count + 1);
  }
  f.connections.at(-1)!.closed.resolve(); await flush();
  f.update([{ key: 'telegram:synthetic', revision: '1' }, { key: 'qq:synthetic', revision: '1' }]);
  await f.supervisor.settled();
  assert.equal(f.supervisor.status().running, 1);
  assert.equal(f.supervisor.status().retrying, 1);
  await f.supervisor.stop();
});

test('数据库快照读取失败5秒后自动补读，不要求额外配置通知', async () => {
  const f = fixture(); f.failRead(true);
  await f.supervisor.start(); await f.supervisor.settled();
  const before = f.events.filter(event => event === 'read').length;
  await f.advance(4_999); assert.equal(f.events.filter(event => event === 'read').length, before);
  await f.advance(1); assert.equal(f.events.filter(event => event === 'read').length, before + 1);
  assert.equal(f.supervisor.status().running, 0);
  await f.supervisor.stop();
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQqConnection } from '../../../src/modules/im/gateway/qq-connection.js';
import type { QqMessageEvent, QqSocket } from '../../../src/modules/im/gateway/qq-connection.js';
import type { GatewayClock } from '../../../src/modules/im/gateway/supervisor.js';

const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
function socket() {
  const queue: unknown[] = [];
  let wake = () => {};
  let ended = false;
  const sent: Readonly<Record<string, unknown>>[] = [];
  let closes = 0;
  const value: QqSocket = {
    packets: (async function* () {
      while (!ended) {
        if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
        while (!ended && queue.length) yield queue.shift();
      }
    })(),
    async send(packet) { sent.push(packet); },
    async close() { closes++; ended = true; wake(); },
  };
  return { value, sent, closes: () => closes, push(packet: unknown) { queue.push(packet); wake(); } };
}
function fixture() {
  let now = 0;
  const waits: { at: number; resolve(): void }[] = [];
  const clock: GatewayClock = { now: () => now, sleep(ms, signal) {
    return new Promise<void>((resolve, reject) => {
      const pending = { at: now + ms, resolve() { signal.removeEventListener('abort', abort); resolve(); } };
      const abort = () => { const index = waits.indexOf(pending); if (index >= 0) waits.splice(index, 1); reject(new Error('取消')); };
      if (signal.aborted) { reject(new Error('取消')); return; }
      waits.push(pending); signal.addEventListener('abort', abort, { once: true });
    });
  } };
  const sockets: ReturnType<typeof socket>[] = [];
  const events: { type: QqMessageEvent; data: Readonly<Record<string, unknown>> }[] = [];
  const reports: string[] = [];
  let failOpen = false, opens = 0;
  let handler: ((signal: AbortSignal) => Promise<void>) | undefined;
  const connection = createQqConnection({
    clock,
    async getAccessToken() { return 'synthetic-qq-token'; },
    async getGateway(token) { assert.equal(token, 'synthetic-qq-token'); return 'wss://gateway.example.invalid/'; },
    async openSocket(url) {
      opens++; assert.equal(url, 'wss://gateway.example.invalid/');
      if (failOpen) throw new Error('synthetic-qq-token');
      const next = socket(); sockets.push(next); return next.value;
    },
    async onEvent(type, data, signal) { events.push({ type, data }); await handler?.(signal); },
    report(event) { reports.push(event); },
  });
  return { connection, sockets, events, reports, waits, opens: () => opens,
    failOpen() { failOpen = true; }, setHandler(value: typeof handler) { handler = value; },
    async advance(ms: number) {
      now += ms;
      for (const pending of [...waits]) if (pending.at <= now) { waits.splice(waits.indexOf(pending), 1); pending.resolve(); }
      await flush();
    },
  };
}

test('HELLO识别intents，READY保存seq并在断线后RESUME，INVALID_SESSION清理恢复状态', async () => {
  const f = fixture(); await flush();
  const first = f.sockets[0]!; first.push({ op: 10, d: { heartbeat_interval: 1_000 } }); await flush();
  assert.deepEqual(first.sent[0], { op: 2, d: { token: 'QQBot synthetic-qq-token', intents: (1 << 25) | (1 << 30) | (1 << 12) | (1 << 26), shard: [0, 1] } });
  first.push({ op: 0, s: 4, t: 'READY', d: { session_id: 'synthetic-session' } });
  first.push({ op: 7 }); await flush(); assert.equal(first.closes(), 1);
  await f.advance(1_000); const second = f.sockets[1]!;
  second.push({ op: 10 }); await flush();
  assert.deepEqual(second.sent[0], { op: 6, d: { token: 'QQBot synthetic-qq-token', session_id: 'synthetic-session', seq: 4 } });
  second.push({ op: 9 }); await flush(); await f.advance(1_000);
  f.sockets[2]!.push({ op: 10 }); await flush(); assert.equal(f.sockets[2]!.sent[0]!.op, 2);
  await f.connection.stop(); assert.equal(f.waits.length, 0);
});

test('心跳发送last_seq，ACK续命，超过2.5个周期关闭重连', async () => {
  const f = fixture(); await flush(); const first = f.sockets[0]!;
  first.push({ op: 10, d: { heartbeat_interval: 1_000 } }); first.push({ op: 0, t: 'READY', s: 8, d: { session_id: 's' } }); await flush();
  await f.advance(1_000); assert.deepEqual(first.sent.at(-1), { op: 1, d: 8 });
  first.push({ op: 11 }); await flush();
  await f.advance(1_000); await f.advance(1_000); assert.equal(first.closes(), 0);
  await f.advance(1_000); assert.equal(first.closes(), 1); assert.ok(f.reports.includes('heartbeat-timeout'));
  await f.advance(1_000); assert.equal(f.sockets.length, 2);
  await f.connection.stop();
});

test('只分发白名单事件且逐条await，业务错误可观察并重连', async () => {
  const f = fixture(); await flush();
  let release!: () => void; let calls = 0;
  f.setHandler(async () => { calls++; if (calls === 1) await new Promise<void>(resolve => { release = resolve; }); else throw new Error('synthetic-qq-token'); });
  const first = f.sockets[0]!;
  first.push({ op: 0, t: 'UNKNOWN', d: {} });
  first.push({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'one' } });
  first.push({ op: 0, t: 'GROUP_MESSAGE_CREATE', d: { id: 'two' } });
  await flush(); assert.equal(f.events.length, 1);
  release(); await flush(); assert.deepEqual(f.events.map(event => event.data.id), ['one', 'two']);
  assert.ok(f.reports.includes('event-failed')); assert.ok(!f.reports.join().includes('synthetic-qq-token'));
  assert.equal(first.closes(), 1); await f.connection.stop();
});

test('失败连接按1/2/5/10/30/60/60秒退避，停止取消重试', async () => {
  const f = fixture(); f.failOpen(); await flush();
  assert.equal(f.opens(), 1);
  for (const delay of [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 60_000]) {
    const count = f.opens(); await f.advance(delay - 1); assert.equal(f.opens(), count);
    await f.advance(1); assert.equal(f.opens(), count + 1);
  }
  await f.connection.stop(); const count = f.opens(); await f.advance(60_000); assert.equal(f.opens(), count); assert.equal(f.waits.length, 0);
});

test('停止中止业务回调并等待排空，不再分发后续事件', async () => {
  const f = fixture(); await flush();
  let cancelled = false;
  f.setHandler(signal => new Promise<void>(resolve => { signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }); }));
  f.sockets[0]!.push({ op: 0, t: 'INTERACTION_CREATE', d: { id: 'first' } });
  f.sockets[0]!.push({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'second' } }); await flush();
  await f.connection.stop(); assert.equal(cancelled, true); assert.equal(f.events.length, 1); assert.equal(f.sockets[0]!.closes(), 1);
});

test('停止取消尚未完成的Socket握手，凭据异常不进入公开closed错误', async () => {
  let opened = false, cancelled = false;
  const connection = createQqConnection({
    async getAccessToken() { return 'synthetic-token'; },
    async getGateway() { return 'wss://gateway.example.invalid/'; },
    async openSocket(_url, signal) {
      opened = true;
      return new Promise<QqSocket>((_resolve, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('synthetic-token')); }, { once: true }));
    },
    async onEvent() {},
  });
  await flush(); assert.equal(opened, true);
  await connection.stop(); await connection.closed; assert.equal(cancelled, true);
});

test('Socket关闭失败报告固定错误且禁止继续建立重复连接', async () => {
  const first = socket(); let opens = 0; const reports: string[] = [];
  const connection = createQqConnection({
    async getAccessToken() { return 'synthetic-token'; },
    async getGateway() { return 'wss://gateway.example.invalid/'; },
    async openSocket() { opens++; return { ...first.value, async close() { await first.value.close(); throw new Error('synthetic-token'); } }; },
    async onEvent() {}, report(event) { reports.push(event); },
  });
  const ended = assert.rejects(connection.closed, { message: 'QQ 连接未能完全停止' });
  await flush(); first.push({ op: 7 }); await ended;
  assert.equal(opens, 1); assert.deepEqual(reports, ['cleanup-failed']);
  await assert.rejects(connection.stop(), { message: 'QQ 连接未能完全停止' });
});

test('业务接收入队失败不提交seq，重连RESUME保持最后已确认水位', async () => {
  const f = fixture(); await flush(); const first = f.sockets[0]!;
  first.push({ op: 10 }); first.push({ op: 0, t: 'READY', s: 5, d: { session_id: 'synthetic-session' } });
  first.push({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 6, d: { id: 'accepted' } }); await flush();
  f.setHandler(async () => { throw new Error('合成入队故障'); });
  first.push({ op: 0, t: 'GROUP_MESSAGE_CREATE', s: 7, d: { id: 'failed' } }); await flush();
  await f.advance(1_000); f.sockets[1]!.push({ op: 10 }); await flush();
  assert.deepEqual(f.sockets[1]!.sent[0], { op: 6, d: { token: 'QQBot synthetic-qq-token', session_id: 'synthetic-session', seq: 6 } });
  await f.connection.stop();
});

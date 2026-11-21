import assert from 'node:assert/strict';
import { Agent } from 'node:https';
import { test } from 'node:test';
import { EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers';
import { createFeishuConnection } from '@gugu/gateway/feishu';
import {GatewayConnectionCleanupError} from '@gugu/gateway';

const appId = 'cli_0123456789abcdef';
const appSecret = 'synthetic-secret';
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function fixture(options: { closeFails?: boolean; timeoutMs?: number } = {}) {
  let sdkOptions!: ConstructorParameters<typeof WSClient>[0];
  let dispatcher!: EventDispatcher;
  let sdkCloses = 0, networkCloses = 0, responseCancels = 0;
  let handler: ((data: unknown, signal: AbortSignal) => Promise<void>) | undefined;
  let cardHandler: ((data: unknown, signal: AbortSignal) => Promise<void>) | undefined;
  const received: unknown[] = [], reports: string[] = [], validated: string[] = [], requests: ProviderHttpRequest[] = [];
  let discoveryStatus = 200;
  let discovery: unknown = { code: 0, data: { URL: 'wss://ws.example.invalid/ws?ticket=synthetic-ticket', ClientConfig: { PingInterval: 30, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 1 } } };
  const agent = new Agent();
  const transport: ProviderTransport = { async request(input) {
    requests.push(input);
    return { status: discoveryStatus, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(discovery)); })(), cancel() { responseCancels++; } };
  }, async close() {} };
  const pending = createFeishuConnection({
    appId, appSecret, transport, readyTimeoutMs: options.timeoutMs ?? 1000,
    wsNetwork: { agent, async validateEndpoint(url) { validated.push(url); }, async close() { networkCloses++; agent.destroy(); } },
    createSdkClient(input) {
      sdkOptions = input;
      return { async start({ eventDispatcher }) { dispatcher = eventDispatcher; }, close({ force }) { assert.equal(force, true); sdkCloses++; if (options.closeFails) throw new Error(appSecret); } };
    },
    async onMessage(data, signal) { received.push(data); await handler?.(data, signal); },
    async onCardAction(data, signal) { received.push(data); await cardHandler?.(data, signal); return { toast: { type: 'info', content: '已收到选择' } }; },
    report(event) { reports.push(event); },
  });
  return { pending, received, reports, requests, validated, sdkOptions: () => sdkOptions, dispatcher: () => dispatcher,
    closes: () => ({ sdkCloses, networkCloses, responseCancels }),
    setHandler(value: typeof handler) { handler = value; },
    setCardHandler(value: typeof cardHandler) { cardHandler = value; },
    discovery(status: number, value: unknown) { discoveryStatus = status; discovery = value; },
  };
}
function event(type: string, content: Record<string, unknown>) {
  return { schema: '2.0', header: { event_type: type, event_id: 'synthetic-event', create_time: '1794900000000', app_id: appId }, event: content };
}

test('SDK start返回不表示ready，只有真实onReady语义后返回GatewayConnection', async () => {
  const f = fixture(); let ready = false; void f.pending.then(() => { ready = true; });
  await flush(); assert.equal(ready, false);
  f.sdkOptions().onReady!(); const connection = await f.pending; assert.equal(ready, true);
  f.sdkOptions().onReconnecting!(); f.sdkOptions().onReconnected!(); assert.deepEqual(f.reports, ['reconnecting', 'reconnected']);
  await connection.stop(); await connection.closed; assert.equal(f.closes().sdkCloses, 1); assert.equal(f.closes().networkCloses, 1);
});
test('普通消息保持顺序，阻塞消息时真实dispatcher卡片控制回调立即返回', async () => {
  const f = fixture(); f.sdkOptions().onReady!(); const connection = await f.pending;
  let release!: () => void;
  let messages = 0;
  f.setHandler(async () => { if (messages++ === 0) await new Promise<void>(resolve => { release = resolve; }); });
  const message = f.dispatcher().invoke(event('im.message.receive_v1', { message: { message_id: 'om_synthetic', content: '{"text":"合成消息"}' } }), { needCheck: false });
  const card = f.dispatcher().invoke(event('card.action.trigger', { action: { value: { token: 'synthetic-action' } } }), { needCheck: false });
  const second = f.dispatcher().invoke(event('im.message.receive_v1', { message: { message_id: 'om_second', content: '{"text":"合成消息二"}' } }), { needCheck: false });
  assert.deepEqual(await card, { toast: { type: 'info', content: '已收到选择' } });
  assert.equal(f.received.length, 2); assert.equal(messages, 1);
  release(); await message; await second; assert.equal(f.received.length, 3); assert.equal(messages, 2);
  for (const type of ['im.message.reaction.created_v1', 'im.message.reaction.deleted_v1']) await f.dispatcher().invoke(event(type, {}), { needCheck: false });
  assert.equal(f.received.length, 3); await connection.stop();
});
test('stop强制关闭SDK后等待在途callback排空，凭据及事件正文不进入logger', async () => {
  const f = fixture(); f.sdkOptions().onReady!(); const connection = await f.pending;
  let release!: () => void;
  f.setHandler(async (_data, signal) => new Promise<void>(resolve => { release = () => { assert.equal(signal.aborted, true); resolve(); }; }));
  const message = f.dispatcher().invoke(event('im.message.receive_v1', { message: { content: '合成消息' } }), { needCheck: false });
  await flush(); let stopped = false;
  const stop = connection.stop().then(() => { stopped = true; }); await flush();
  assert.equal(f.closes().sdkCloses, 1); assert.equal(stopped, false);
  for (const method of ['error', 'warn', 'info', 'debug', 'trace'] as const) f.sdkOptions().logger![method](appSecret, '合成消息', new Error(appSecret));
  assert.ok(!f.reports.join().includes(appSecret)); release(); await message; await stop;
});
test('discovery仅允许固定官方POST且通过安全transport，返回WS URL先经可信Agent校验', async () => {
  const f = fixture(); const http = f.sdkOptions().httpInstance!;
  await http.request({ method: 'post', url: 'https://open.feishu.cn/callback/ws/endpoint', data: { AppID: appId, AppSecret: appSecret } });
  assert.equal(f.requests.length, 1); assert.deepEqual(f.validated, ['wss://ws.example.invalid/ws?ticket=synthetic-ticket']);
  assert.equal(f.closes().responseCancels, 1);
  await assert.rejects(http.request({ method: 'post', url: 'https://evil.example/', data: { AppID: appId, AppSecret: appSecret } }), { message: '飞书连接失败' });
  assert.equal(f.requests.length, 1);
  f.discovery(302, {});
  await assert.rejects(http.request({ method: 'post', url: 'https://open.feishu.cn/callback/ws/endpoint', data: { AppID: appId, AppSecret: appSecret } }), { message: '飞书连接失败' });
  f.sdkOptions().onReady!(); await (await f.pending).stop();
});
test('初始握手onError及超时安全失败并回收SDK，不伪称ready', async () => {
  for (const mode of ['error', 'timeout']) {
    const f = fixture({ timeoutMs: 5 }); const rejected = assert.rejects(f.pending, { message: '飞书连接失败' });
    if (mode === 'error') f.sdkOptions().onError!(new Error(appSecret));
    await rejected; assert.equal(f.closes().sdkCloses, 1); assert.equal(f.closes().networkCloses, 1);
  }
});
test('初始握手失败且SDK清理未知必须返回可识别归属错误，不泄露原凭据异常',async()=>{
 for(const mode of ['error','timeout']){
  const f=fixture({timeoutMs:5,closeFails:true})
  const rejected=assert.rejects(f.pending,error=>error instanceof GatewayConnectionCleanupError&&!error.message.includes(appSecret)&&!('cause'in error))
  if(mode==='error')f.sdkOptions().onError!(new Error(appSecret))
  await rejected;assert.equal(f.closes().sdkCloses,1);assert.equal(f.closes().networkCloses,1)
 }
})
test('清理失败reject closed/stop，跨Bot dispatcher不共享业务输入', async () => {
  const a = fixture({ closeFails: true }), b = fixture();
  a.sdkOptions().onReady!(); b.sdkOptions().onReady!(); const ca = await a.pending, cb = await b.pending;
  await b.dispatcher().invoke(event('im.message.receive_v1', { message: { content: '仅B' } }), { needCheck: false });
  assert.equal(a.received.length, 0); assert.equal(b.received.length, 1);
  await assert.rejects(ca.stop(), { message: '飞书连接失败' }); await assert.rejects(ca.closed, { message: '飞书连接失败' });
  assert.ok(a.reports.includes('cleanup-failed')); await cb.stop();
});

test('真实dispatcher解析header后拒绝其他app事件，消息与卡片均不进入业务端口', async () => {
  const f = fixture(); f.sdkOptions().onReady!(); const connection = await f.pending;
  for (const type of ['im.message.receive_v1', 'card.action.trigger']) {
    const wrong = event(type, { message: { content: '合成消息' } }); wrong.header.app_id = 'cli_0000000000000000';
    await f.dispatcher().invoke(wrong, { needCheck: false });
  }
  assert.equal(f.received.length, 0); assert.deepEqual(f.reports, ['misrouted-event', 'misrouted-event']); await connection.stop();
});

test('停止分别排空消息和卡片控制回调，双方退出前不释放网络资源', async () => {
  const f = fixture(); f.sdkOptions().onReady!(); const connection = await f.pending;
  let releaseMessage!: () => void, releaseCard!: () => void;
  f.setHandler(async (_data, signal) => new Promise<void>(resolve => { releaseMessage = () => { assert.equal(signal.aborted, true); resolve(); }; }));
  f.setCardHandler(async (_data, signal) => new Promise<void>(resolve => { releaseCard = () => { assert.equal(signal.aborted, true); resolve(); }; }));
  const message = f.dispatcher().invoke(event('im.message.receive_v1', { message: { content: '合成消息' } }), { needCheck: false });
  const card = f.dispatcher().invoke(event('card.action.trigger', { action: { value: { token: 'synthetic-action' } } }), { needCheck: false });
  await flush(); assert.equal(f.received.length, 2);
  let stopped = false; const stopping = connection.stop().then(() => { stopped = true; });
  await flush(); assert.equal(f.closes().sdkCloses, 1); assert.equal(f.closes().networkCloses, 0);
  releaseMessage(); await message; await flush(); assert.equal(stopped, false); assert.equal(f.closes().networkCloses, 0);
  releaseCard(); await card; await stopping; assert.equal(stopped, true); assert.equal(f.closes().networkCloses, 1);
});

test('飞书卡片消费超时只返回处理中提示，后台失败仍可诊断', async context => {
  const f = fixture();
  await flush();
  f.sdkOptions().onReady!();
  const connection = await f.pending;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let fail!: (error: Error) => void;
  f.setCardHandler(() => new Promise((_resolve, reject) => { fail = reject; }));
  try {
    const reply = f.dispatcher().invoke(event('card.action.trigger', {}), { needCheck: false });
    await flush();
    context.mock.timers.tick(2_000);
    assert.deepEqual(await reply, {
      toast: { type: 'info', content: '已收到操作，仍在处理中；请稍后查看，暂勿重复点击。' },
    });
    fail(new Error('合成消费错误'));
    await flush();
    assert.ok(f.reports.includes('event-failed'));
  } finally {
    fail?.(new Error('结束合成消费'));
    await connection.stop();
  }
});

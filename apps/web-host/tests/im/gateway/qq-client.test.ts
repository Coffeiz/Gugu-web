import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers';
import { createQqClient, QqApiError } from '../../../src/modules/im/gateway/platforms/qq/client.js';

test('QQ鉴权await后撤权，在实际消息transport请求前复核且不重试发送',async()=>{
  let calls=0,allowed=true
  const client=createQqClient({appId:'synthetic-app',appSecret:'synthetic-secret',sandbox:false,transport:{async request(){
    calls++;allowed=false
    return{status:200,headers:{},body:(async function*(){yield Buffer.from(JSON.stringify({access_token:'synthetic-access',expires_in:7200}))})(),async cancel(){}}
  }}})
  try{
    await assert.rejects(client.call('POST','/v2/users/synthetic-user/messages',{body:{content:'合成消息'},authorize:async()=>allowed}),error=>error instanceof QqApiError&&error.statusCode===403&&error.outcome==='FAILED_CONFIRMED')
    assert.equal(calls,1)
  }finally{await client.close()}
})

function fixture(sandbox = false) {
  let now = 0, tokens = 0, cancels = 0;
  let status = 200;
  let data: unknown = { id: 'synthetic-message', stream_msg_id: 'synthetic-stream' };
  let first401 = false, throwNetwork = false;
  let gate: Promise<void> | undefined;
  const requests: ProviderHttpRequest[] = [];
  const transport: ProviderTransport = { async request(input, signal) {
    requests.push(input); const auth = input.url.includes('getAppAccessToken');
    if (auth) { tokens++; if (gate) await gate; }
    if (!auth && throwNetwork) throw new Error('synthetic-secret');
    const responseStatus = !auth && first401 ? 401 : auth ? 200 : status;
    first401 = false;
    return { status: responseStatus, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(auth ? { access_token: `synthetic-token-${tokens}`, expires_in: '120' } : data)); })(), cancel() { cancels++; } };
  }, async close() {} };
  let addresses = [{ address: '8.8.8.8', family: 4 as const }];
  const client = createQqClient({ appId: 'synthetic-app', appSecret: 'synthetic-secret', sandbox, transport, now: () => now, resolveGateway: async () => addresses });
  return { client, requests, tokens: () => tokens, cancels: () => cancels,
    advance(ms: number) { now += ms; }, response(code: number, value: unknown) { status = code; data = value; },
    reject401() { first401 = true; }, networkFailure() { throwNetwork = true; },
    gate(value: Promise<void>) { gate = value; }, privateDns() { addresses = [{ address: '127.0.0.1', family: 4 }]; },
  };
}
const message = '/v2/users/synthetic_user/messages';
test('固定token地址与字段、并发单飞、60秒到期刷新、sandbox隔离', async () => {
  for (const sandbox of [false, true]) {
    const f = fixture(sandbox); let release!: () => void;
    f.gate(new Promise<void>(resolve => { release = resolve; }));
    const first = f.client.getAccessToken(), second = f.client.getAccessToken();
    release(); assert.equal(await first, 'synthetic-token-1'); assert.equal(await second, 'synthetic-token-1'); assert.equal(f.tokens(), 1);
    assert.equal(f.requests[0]!.url, 'https://bots.qq.com/app/getAppAccessToken');
    assert.deepEqual(JSON.parse(Buffer.from(f.requests[0]!.body as Uint8Array).toString()), { appId: 'synthetic-app', clientSecret: 'synthetic-secret' });
    await f.client.call('POST', message, { body: { msg_type: 0, content: '合成消息', msg_seq: 1 } });
    assert.equal(f.requests.at(-1)!.url, `https://${sandbox ? 'sandbox.api.sgroup.qq.com' : 'api.sgroup.qq.com'}${message}`);
    assert.equal(f.requests.at(-1)!.headers.Authorization, 'QQBot synthetic-token-1');
    f.advance(60_000); await f.client.getAccessToken(); assert.equal(f.tokens(), 2); await f.client.close();
  }
});
test('明确401只换token重试一次，不把凭据写进URL', async () => {
  const f = fixture(); await f.client.getAccessToken(); f.reject401();
  await f.client.call('POST', message, { body: { msg_type: 0, content: '合成消息' } });
  assert.equal(f.tokens(), 2); assert.equal(f.requests.filter(request => request.url.endsWith('/messages')).length, 2);
  assert.ok(f.requests.every(request => !request.url.includes('synthetic-token'))); await f.client.close();
});
test('消息/stream成功必须有平台ID，200缺ID是UNKNOWN且不重发', async () => {
  for (const path of [message, '/v2/users/synthetic_user/stream_messages']) {
    const f = fixture(); f.response(200, {});
    await assert.rejects(f.client.call('POST', path), (error: unknown) => error instanceof QqApiError && error.outcome === 'UNKNOWN');
    assert.equal(f.requests.length, 2); await f.client.close();
  }
});
test('上游永久拒绝与5xx/网络未知结果区分，原正文及异常不暴露且不盲重试', async () => {
  for (const kind of ['bad', 'server', 'network']) {
    const f = fixture();
    if (kind === 'network') f.networkFailure(); else f.response(kind === 'bad' ? 400 : 500, { code: 40034024, message: 'synthetic-secret' });
    await assert.rejects(f.client.call('POST', message), (error: unknown) => {
      assert.ok(error instanceof QqApiError); assert.equal(error.outcome, kind === 'bad' ? 'FAILED_CONFIRMED' : 'UNKNOWN');
      assert.equal(error.retryable, kind !== 'bad'); assert.equal(error.cause, undefined); assert.ok(!JSON.stringify(error).includes('synthetic-secret')); return true;
    });
    assert.equal(f.requests.length, 2); await f.client.close();
  }
});
test('白名单API路径支持消息、流、媒体分块元信息及interaction；拒绝任意URL和穿越', async () => {
  const f = fixture();
  for (const [method, path] of [['POST', '/v2/groups/synthetic_group/messages'], ['POST', '/v2/users/synthetic_user/stream_messages'], ['POST', '/v2/groups/synthetic_group/upload_prepare'], ['POST', '/v2/groups/synthetic_group/upload_part_finish'], ['POST', '/v2/groups/synthetic_group/files'], ['PUT', '/interactions/synthetic_action']] as const) await f.client.call(method, path);
  const count = f.requests.length;
  for (const path of ['https://evil.example/', '/v2/users/a/../messages', '/v2/users/a/messages?token=x', '/v2/users/a%2fb/messages', '/admin']) await assert.rejects(f.client.call('POST', path), QqApiError);
  assert.equal(f.requests.length, count); await f.client.close();
});
test('Gateway只接受官方WSS路径并校验公网DNS，固定端口/无凭据及query', async () => {
  const f = fixture(); f.response(200, { url: 'wss://api.sgroup.qq.com/websocket/' }); assert.equal(await f.client.getGateway(), 'wss://api.sgroup.qq.com/websocket/');
  for (const url of ['ws://api.sgroup.qq.com/websocket/', 'wss://evil.example/websocket/', 'wss://api.sgroup.qq.com/other', 'wss://api.sgroup.qq.com:8443/websocket/', 'wss://token@api.sgroup.qq.com/websocket/', 'wss://api.sgroup.qq.com/websocket/?token=x']) {
    f.response(200, { url }); await assert.rejects(f.client.getGateway(), QqApiError);
  }
  f.response(200, { url: 'wss://api.sgroup.qq.com/websocket/' }); f.privateDns(); await assert.rejects(f.client.getGateway(), QqApiError); await f.client.close();
});
test('重定向不跟随、200业务错误与超大响应安全失败并取消响应', async () => {
  for (const [status, data] of [[302, {}], [200, { code: 11292, message: 'synthetic-secret' }], [200, { id: 'synthetic', content: 'x'.repeat(4 * 1024 * 1024) }]] as const) {
    const f = fixture(); f.response(status, data); await assert.rejects(f.client.call('POST', message), QqApiError);
    assert.equal(f.requests.length, 2); assert.equal(f.cancels(), 2); await f.client.close();
  }
});

test('读取中取消与总超时释放连接，结果UNKNOWN不重发或泄漏底层错误', async () => {
  for (const mode of ['abort', 'timeout']) {
    const controller = new AbortController(); let messages = 0, cancels = 0;
    const transport: ProviderTransport = { async request(input, signal) {
      const auth = input.url.includes('getAppAccessToken'); if (!auth) messages++;
      return { status: 200, headers: {}, body: (async function* () {
        if (!auth) await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('synthetic-secret')), { once: true });
          if (mode === 'abort') controller.abort();
        });
        yield Buffer.from(JSON.stringify({ access_token: 'synthetic-token', expires_in: '7200' }));
      })(), cancel() { cancels++; } };
    } };
    const client = createQqClient({ appId: 'synthetic-app', appSecret: 'synthetic-secret', sandbox: false, transport });
    await assert.rejects(client.call('POST', message, { signal: controller.signal, timeoutMs: 5 }), (error: unknown) => error instanceof QqApiError && error.outcome === 'UNKNOWN' && error.cause === undefined && !JSON.stringify(error).includes('synthetic-secret'));
    assert.equal(messages, 1); assert.ok(cancels >= 2); await client.close();
  }
});

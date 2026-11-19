import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers';
import { createFeishuClient, FeishuApiError } from '../../../src/modules/im/gateway/platforms/feishu/client.js';

function fixture() {
  let now = 0; let tokenCount = 0; let apiStatus = 200;
  let apiData: unknown = { code: 0, data: { message_id: 'synthetic-message' } };
  let binary: Buffer | undefined; let cancelled = 0;
  let authGate: Promise<void> | undefined;
  const requests: ProviderHttpRequest[] = [];
  const transport: ProviderTransport = { async request(request, signal) {
    requests.push(request); const auth = request.url.endsWith('/tenant_access_token/internal');
    if (auth) {
      tokenCount++;
      if (authGate) await Promise.race([authGate, new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic-secret')), { once: true }))]);
    }
    return { status: auth ? 200 : apiStatus, headers: {}, body: (async function* () { yield !auth && binary ? binary : Buffer.from(JSON.stringify(auth ? { code: 0, tenant_access_token: `synthetic-token-${tokenCount}`, expire: 120 } : apiData)); })(), cancel() { cancelled++; } };
  }, async close() {} };
  const client = createFeishuClient({ appId: 'cli_synthetic', appSecret: 'synthetic-secret', transport, now: () => now });
  return { client, requests, cancelled: () => cancelled, tokens: () => tokenCount, advance(ms: number) { now += ms; }, error(status: number, data: unknown) { apiStatus = status; apiData = data; }, binary(value: Buffer) { binary = value; }, gate(value: Promise<void>) { authGate = value; } };
}
const messagePath = '/open-apis/im/v1/messages?receive_id_type=chat_id';
test('固定官方主机、租户token单飞缓存且到期前60秒刷新', async () => {
  const f = fixture(); await Promise.all([f.client.call('GET', '/open-apis/bot/v3/info'), f.client.call('POST', messagePath, { body: { receive_id: 'oc_synthetic', content: '合成正文', msg_type: 'text' } })]);
  assert.equal(f.tokens(), 1); await f.client.call('GET', '/open-apis/bot/v3/info'); assert.equal(f.tokens(), 1);
  f.advance(60_000); await f.client.call('GET', '/open-apis/bot/v3/info'); assert.equal(f.tokens(), 2);
  for (const request of f.requests) assert.equal(new URL(request.url).origin, 'https://open.feishu.cn');
  const message = f.requests.find(request => request.url.includes('receive_id_type'))!;
  assert.equal(message.headers.Authorization, 'Bearer synthetic-token-1');
  assert.equal(message.headers['content-type'], 'application/json; charset=utf-8');
  await f.client.close();
});
test('仅受控消息/reaction/CardKit路径可访问，PUT/PATCH保持协议方法与JSON包络', async () => {
  const f = fixture();
  for (const [method, path] of [['POST', '/open-apis/im/v1/messages/om_synthetic/reactions'], ['POST', '/open-apis/cardkit/v1/cards'], ['PUT', '/open-apis/cardkit/v1/cards/card_synthetic/elements/markdown_1/content'], ['PUT', '/open-apis/cardkit/v1/cards/card_synthetic'], ['PATCH', '/open-apis/cardkit/v1/cards/card_synthetic/settings']] as const) {
    await f.client.call(method, path, { body: { sequence: 1 } }); assert.equal(f.requests.at(-1)!.method, method);
  }
  const count = f.requests.length;
  for (const path of ['https://evil.example/', '/open-apis/admin/users', '/open-apis/im/v1/messages/../secrets', messagePath + '&url=evil', '/open-apis/cardkit/v1/cards/a%2fb']) await assert.rejects(f.client.call('POST', path), FeishuApiError);
  assert.equal(f.requests.length, count); await f.client.close();
});
test('媒体multipart仅使用传入内存，资源下载校验路径和实际大小', async () => {
  const f = fixture();
  await f.client.call('POST', '/open-apis/im/v1/images', { body: { image_type: 'message' }, files: { image: { name: '合成.png', data: Buffer.from('合成图片'), contentType: 'image/png' } } });
  const upload = f.requests.at(-1)!; assert.match(upload.headers['content-type']!, /^multipart\/form-data; boundary=/); assert.ok(Buffer.from(upload.body as Uint8Array).toString().includes('合成图片'));
  f.binary(Buffer.from('1234')); assert.equal(Buffer.from(await f.client.downloadResource('om_synthetic', 'img_synthetic', 'image', { maxBytes: 4 })).toString(), '1234');
  await assert.rejects(f.client.downloadResource('om_synthetic', 'img_synthetic', 'image', { maxBytes: 3 }), FeishuApiError);
  await assert.rejects(f.client.downloadResource('../escape', 'img_synthetic', 'image', { maxBytes: 4 }), FeishuApiError);
  await f.client.close();
});
test('上游凭据回显、重定向与超大正文均释放响应且仅暴露安全状态', async () => {
  for (const kind of ['api', 'redirect', 'size']) {
    const f = fixture();
    if (kind === 'api') f.error(403, { code: 999, msg: 'synthetic-secret', data: '合成敏感正文' });
    if (kind === 'redirect') f.error(302, {});
    if (kind === 'size') f.binary(Buffer.alloc(4 * 1024 * 1024 + 1));
    await assert.rejects(f.client.call('GET', '/open-apis/bot/v3/info'), (error: unknown) => {
      assert.ok(error instanceof FeishuApiError); assert.equal(error.cause, undefined); assert.ok(!JSON.stringify(error).includes('synthetic-secret')); assert.ok(!error.message.includes('合成敏感正文')); return true;
    });
    assert.equal(f.cancelled(), 2); await f.client.close();
  }
});
test('并发刷新时取消单个等待者不取消其他调用', async () => {
  const f = fixture(); let release!: () => void; f.gate(new Promise<void>(resolve => { release = resolve; }));
  const controller = new AbortController();
  const first = f.client.call('GET', '/open-apis/bot/v3/info', { signal: controller.signal });
  const rejected = assert.rejects(first, FeishuApiError);
  const second = f.client.call('GET', '/open-apis/bot/v3/info');
  controller.abort(); await rejected; release(); await second; assert.equal(f.tokens(), 1); await f.client.close();
});

test('取消最后一个token等待者中止刷新，随后调用可重新获取', async () => {
  let attempts = 0, aborted = 0;
  const transport: ProviderTransport = { async request(request, signal) {
    if (request.url.includes('tenant_access_token')) {
      attempts++;
      if (attempts === 1) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(new Error('synthetic-secret')); }, { once: true }));
    }
    return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(request.url.includes('tenant_access_token') ? { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 } : { code: 0 })); })(), cancel() {} };
  } };
  const client = createFeishuClient({ appId: 'cli_synthetic', appSecret: 'synthetic-secret', transport });
  const controller = new AbortController();
  const pending = assert.rejects(client.call('GET', '/open-apis/bot/v3/info', { signal: controller.signal }), FeishuApiError);
  for (let index = 0; index < 10; index++) await Promise.resolve();
  controller.abort(); await pending;
  await client.call('GET', '/open-apis/bot/v3/info'); assert.equal(attempts, 2); assert.equal(aborted, 1); await client.close();
});

test('API读取中取消及总超时取消连接并消除底层敏感错误', async () => {
  for (const mode of ['abort', 'timeout']) {
    const controller = new AbortController(); let cancelled = 0;
    const transport: ProviderTransport = { async request(request, signal) {
      const auth = request.url.includes('tenant_access_token');
      return { status: 200, headers: {}, body: (async function* () {
        if (!auth) await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('synthetic-secret')), { once: true });
          if (mode === 'abort') controller.abort();
        });
        yield Buffer.from(JSON.stringify({ code: 0, tenant_access_token: 'synthetic-token', expire: 7200 }));
      })(), cancel() { cancelled++; } };
    } };
    const client = createFeishuClient({ appId: 'cli_synthetic', appSecret: 'synthetic-secret', transport });
    await assert.rejects(client.call('GET', '/open-apis/bot/v3/info', { signal: controller.signal, timeoutMs: 5 }), (error: unknown) => error instanceof FeishuApiError && error.cause === undefined && !JSON.stringify(error).includes('synthetic-secret'));
    assert.ok(cancelled >= 2); await client.close();
  }
});

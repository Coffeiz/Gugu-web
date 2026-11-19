import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderHttpRequest, ProviderHttpResponse, ProviderTransport } from '@gugu/core/providers';
import { createTelegramBotApi, TelegramApiError, validateTelegramBotToken } from '../../../src/modules/im/gateway/telegram-api.js';

const token = '123456:synthetic_Telegram_Token_0000';
function fixture(status = 200, data: unknown = { ok: true, result: { id: 1 } }) {
  const requests: ProviderHttpRequest[] = [];
  let cancelled = 0; let closed = 0;
  let headers: Record<string, string> = {};
  let chunks: Buffer[] = [Buffer.from(JSON.stringify(data))];
  const transport: ProviderTransport = {
    async request(input) {
      requests.push(input);
      return { status, headers, body: (async function* () { yield* chunks; })(), cancel() { cancelled++; } };
    },
    async close() { closed++; },
  };
  return { api: createTelegramBotApi({ transport }), requests, cancelled: () => cancelled, closed: () => closed,
    setBody(value: Buffer[]) { chunks = value; }, setHeaders(value: Record<string, string>) { headers = value; } };
}

test('官方固定主机JSON请求返回result，完成释放响应和显式关闭transport', async () => {
  const f = fixture(); assert.deepEqual(await f.api.call(token, 'getMe'), { id: 1 });
  const request = f.requests[0]!;
  assert.equal(request.url, `https://api.telegram.org/bot${token}/getMe`);
  assert.equal(request.allowLocal, undefined);
  assert.equal(request.method, 'POST');
  assert.deepEqual(JSON.parse(Buffer.from(request.body as Uint8Array).toString()), {});
  assert.equal(f.cancelled(), 1); await f.api.close(); assert.equal(f.closed(), 1);
});

test('Token与方法名在网络调用前严格校验，错误不包含输入', async () => {
  assert.equal(validateTelegramBotToken(` ${token} `), token);
  const f = fixture();
  for (const bad of ['1234:short', `${token}/path`, `${token}?url=evil`, '0'.repeat(161)]) {
    await assert.rejects(f.api.call(bad, 'getMe'), { message: 'Telegram Bot Token 格式无效' });
  }
  await assert.rejects(f.api.call(token, '../getMe'), { message: 'Telegram API 方法名无效' });
  assert.equal(f.requests.length, 0);
});

test('Multipart字段、布尔值和文件内容进入同一请求，禁止头部注入', async () => {
  const f = fixture(); await f.api.call(token, 'sendDocument', { payload: { chat_id: 1, disable_notification: true }, files: { document: { name: '合成文件.txt', data: Buffer.from('合成附件'), contentType: 'text/plain' } } });
  const request = f.requests[0]!; const body = Buffer.from(request.body as Uint8Array).toString();
  assert.match(request.headers['content-type']!, /^multipart\/form-data; boundary=gugu-/);
  assert.ok(body.includes('name="disable_notification"\r\n\r\ntrue'));
  assert.ok(body.includes('filename="合成文件.txt"')); assert.ok(body.includes('合成附件'));
  await assert.rejects(f.api.call(token, 'sendDocument', { files: { document: { name: 'bad\r\nheader', data: Buffer.alloc(0), contentType: 'text/plain' } } }), TelegramApiError);
  assert.equal(f.requests.length, 1);
});

test('上游错误只投影状态及整数retryAfter，不保留正文、URL、cause', async () => {
  const f = fixture(429, { ok: false, description: token, error_code: 429, parameters: { retry_after: 3 } });
  await assert.rejects(f.api.call(token, 'getUpdates'), (error: unknown) => {
    assert.ok(error instanceof TelegramApiError); assert.equal(error.statusCode, 429); assert.equal(error.errorCode, 429); assert.equal(error.retryAfter, 3);
    assert.equal(error.cause, undefined); assert.ok(!JSON.stringify(error).includes(token)); assert.ok(!error.stack!.includes(token)); return true;
  });
  const invalid = fixture(400, { error_code: true, parameters: { retry_after: '2' } });
  await assert.rejects(invalid.api.call(token, 'getMe'), (error: unknown) => error instanceof TelegramApiError && error.errorCode === undefined && error.retryAfter === undefined);
});

test('3xx不跟随，非法JSON与过大响应释放连接并安全失败', async () => {
  for (const kind of ['redirect', 'json', 'size']) {
    const f = fixture(kind === 'redirect' ? 302 : 200);
    if (kind === 'json') f.setBody([Buffer.from(token)]);
    if (kind === 'size') f.setBody([Buffer.alloc(4 * 1024 * 1024 + 1)]);
    await assert.rejects(f.api.call(token, 'getMe'), TelegramApiError);
    assert.equal(f.requests.length, 1); assert.equal(f.cancelled(), 1);
  }
});

test('文件路径穿越与非官方目标在请求前拒绝，下载同时限制声明和实际字节数', async () => {
  const f = fixture();
  for (const path of ['../secret', 'photos/./file', 'https://evil.example/a', 'photos/%2e%2e/a', 'a?key=value']) await assert.rejects(f.api.downloadFile(token, path), TelegramApiError);
  assert.equal(f.requests.length, 0);
  f.setBody([Buffer.from('1234')]);
  assert.equal(Buffer.from(await f.api.downloadFile(token, 'photos/a.jpg', { maxBytes: 4 })).toString(), '1234');
  assert.equal(f.requests[0]!.url, `https://api.telegram.org/file/bot${token}/photos/a.jpg`);
  await assert.rejects(f.api.downloadFile(token, 'photos/a.jpg', { maxBytes: 3 }), TelegramApiError);
  f.setHeaders({ 'Content-Length': '5' });
  await assert.rejects(f.api.downloadFile(token, 'photos/a.jpg', { maxBytes: 4 }), TelegramApiError);
  await assert.rejects(f.api.downloadFile(token, 'photos/a.jpg', { maxBytes: 21 * 1024 * 1024 }), TelegramApiError);
});

test('读取中取消和总超时传入transport并释放响应，不泄露底层异常', async () => {
  for (const mode of ['cancel', 'timeout']) {
    const controller = new AbortController(); let cancelled = 0;
    const transport: ProviderTransport = { async request(_request, signal): Promise<ProviderHttpResponse> {
      return { status: 200, headers: {}, body: (async function* () {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error(token)), { once: true });
          if (mode === 'cancel') controller.abort();
        });
        yield Buffer.alloc(0);
      })(), cancel() { cancelled++; } };
    } };
    const api = createTelegramBotApi({ transport });
    await assert.rejects(api.call(token, 'getUpdates', { signal: controller.signal, timeoutMs: 5 }), (error: unknown) => error instanceof TelegramApiError && !error.message.includes(token) && error.cause === undefined);
    assert.ok(cancelled >= 1); await api.close();
  }
});

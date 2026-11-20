import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers';
import { createQqClient } from '@gugu/gateway/qq';
import { createQqMediaUploader, QqMediaUploadError, QQ_ATTACHMENT_MAX_BYTES } from '@gugu/gateway/qq';

const hash = (kind: string, data: Uint8Array) => createHash(kind).update(data).digest('hex');
const input = { target: 'groups' as const, openid: 'synthetic_group', fileType: 4 as const, data: Buffer.from('12345'), fileName: '合成报告.pdf' };
const url = (index: number) => `https://synthetic-bucket.cos.ap-guangzhou.myqcloud.com/part-${index}?q-signature=synthetic-signature`;
function prepare(count = 2, blockSize: unknown = '3') {
  return { upload_id: 'synthetic-upload', block_size: blockSize, parts: Array.from({ length: count }, (_, index) => ({ index: index + 1, block_size: blockSize, presigned_url: url(index + 1) })), upload_config: { concurrency: 2 } };
}
function fixture(overrides: { prepare?: Record<string, unknown>; complete?: Record<string, unknown>; cos?: (request: ProviderHttpRequest, signal: AbortSignal) => Promise<number>; timeoutMs?: number } = {}) {
  const calls: { path: string; body: Record<string, unknown> | undefined }[] = [], chunks: ProviderHttpRequest[] = [];
  let cancels = 0;
  const client: Pick<ReturnType<typeof createQqClient>, 'call'> = { async call(_method, path, args) {
    calls.push({ path, body: args?.body }); args?.signal?.throwIfAborted();
    if (path.endsWith('/upload_prepare')) return overrides.prepare ?? prepare();
    if (path.endsWith('/upload_part_finish')) return {};
    if (path.endsWith('/files')) return overrides.complete ?? { file_info: 'synthetic-media' };
    throw new Error('不应发送消息');
  } };
  const transport: ProviderTransport = { async request(request, signal) {
    chunks.push(request); const status = await overrides.cos?.(request, signal) ?? 200;
    return { status, headers: {}, body: (async function* () { yield Buffer.from('不可记录的COS响应'); })(), cancel() { cancels++; } };
  }, async close() {} };
  return { uploader: createQqMediaUploader({ client, transport, timeoutMs: overrides.timeoutMs }), calls, chunks, cancels: () => cancels };
}
test('真实QqClient→upload_prepare→COS PUT→part_finish→files完整协议，无普通消息发送', async () => {
  const requests: ProviderHttpRequest[] = [];
  const transport: ProviderTransport = { async request(request) {
    requests.push(request); let result: Record<string, unknown> = {};
    if (request.url.includes('getAppAccessToken')) result = { access_token: 'synthetic-token', expires_in: '7200' };
    else if (request.url.endsWith('/upload_prepare')) result = prepare(2, '３');
    else if (request.url.endsWith('/files')) result = { file_info: 'synthetic-media' };
    return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(result)); })(), cancel() {} };
  }, async close() {} };
  const client = createQqClient({ appId: 'synthetic-app', appSecret: 'synthetic-secret', sandbox: false, transport });
  const uploader = createQqMediaUploader({ client, transport });
  assert.deepEqual(await uploader.upload(input), { file_info: 'synthetic-media' });
  const chunks = requests.filter(request => request.method === 'PUT');
  assert.equal(chunks.length, 2); assert.deepEqual(chunks.map(request => Buffer.from(request.body as Uint8Array).toString()), ['123', '45']);
  assert.ok(chunks.every(request => request.headers.Authorization === undefined));
  const finished = requests.filter(request => request.url.endsWith('/upload_part_finish')).map(request => JSON.parse(Buffer.from(request.body as Uint8Array).toString()));
  assert.deepEqual(finished.map(part => [part.part_index, part.block_size, part.md5]), [[1, 3, hash('md5', Buffer.from('123'))], [2, 2, hash('md5', Buffer.from('45'))]]);
  assert.equal(requests.filter(request => request.url.endsWith('/files')).length, 1);
  assert.ok(requests.every(request => !request.url.endsWith('/messages')));
  await uploader.close(); await client.close();
});
test('hash覆盖全量MD5/SHA1与精确10_002_432字节前缀；小文件同样使用分块', async () => {
  const data = Buffer.alloc(10_002_433, 1); data[data.length - 1] = 2;
  const f = fixture({ prepare: prepare(1, data.length) });
  await f.uploader.upload({ ...input, data });
  assert.deepEqual(f.calls[0]!.body, { file_type: 4, file_name: input.fileName, file_size: data.length, md5: hash('md5', data), sha1: hash('sha1', data), md5_10m: hash('md5', data.subarray(0, 10_002_432)) });
  assert.notEqual(f.calls[0]!.body!.md5, f.calls[0]!.body!.md5_10m); await f.uploader.close();
  const small = fixture({ prepare: prepare(1, 524288) }); await small.uploader.upload({ ...input, data: Buffer.from('小附件') }); assert.equal(small.chunks.length, 1); await small.uploader.close();
});
test('30MiB上限与非法目标在prepare前拒绝，分片数/序号/容量不一致在COS前拒绝', async () => {
  const f = fixture();
  await assert.rejects(f.uploader.upload({ ...input, data: Buffer.alloc(QQ_ATTACHMENT_MAX_BYTES + 1) }), QqMediaUploadError);
  await assert.rejects(f.uploader.upload({ ...input, openid: '../another-group' }), QqMediaUploadError); assert.equal(f.calls.length, 0); await f.uploader.close();
  const invalid = [prepare(1), { ...prepare(), parts: [{ index: 1, presigned_url: url(1) }, { index: 1, presigned_url: url(2) }] }, { ...prepare(), parts: [{ index: 1, presigned_url: url(1), block_size: 2 }, { index: 2, presigned_url: url(2) }] }, { ...prepare(), block_size: true }];
  for (const value of invalid) { const next = fixture({ prepare: value }); await assert.rejects(next.uploader.upload(input), QqMediaUploadError); assert.equal(next.chunks.length, 0); await next.uploader.close(); }
});
test('COS只接受HTTPS腾讯域，无userinfo/非443端口，拒绝重定向并不完成媒体', async () => {
  for (const bad of ['http://bucket.myqcloud.com/a', 'https://bucket.myqcloud.com.evil.example/a', 'https://token@bucket.myqcloud.com/a', 'https://bucket.myqcloud.com:8443/a']) {
    const value = prepare(); value.parts[0]!.presigned_url = bad;
    const f = fixture({ prepare: value }); await assert.rejects(f.uploader.upload(input), QqMediaUploadError); assert.equal(f.chunks.length, 0); await f.uploader.close();
  }
  const f = fixture({ cos: async () => 302 }); await assert.rejects(f.uploader.upload(input), QqMediaUploadError); assert.equal(f.calls.filter(call => call.path.endsWith('/files')).length, 0); await f.uploader.close();
});
test('最多10并发，单分片失败会取消并排空其他worker，禁止重prepare或complete', async () => {
  const value = prepare(12, 1); value.upload_config.concurrency = 100;
  let active = 0, max = 0, release!: () => void;
  const trigger = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ prepare: value, cos: async (_request, signal) => {
    active++; max = Math.max(max, active);
    try { await Promise.race([trigger, new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic-signature')), { once: true }))]); return 500; }
    finally { active--; }
  } });
  const pending = assert.rejects(f.uploader.upload({ ...input, data: Buffer.alloc(12) }), (error: unknown) => error instanceof QqMediaUploadError && error.outcome === 'UNKNOWN' && !JSON.stringify(error).includes('synthetic-signature'));
  for (let index = 0; index < 20; index++) await Promise.resolve(); assert.equal(max, 10); release(); await pending;
  assert.equal(active, 0); assert.equal(f.calls.filter(call => call.path.endsWith('/upload_prepare')).length, 1); assert.equal(f.calls.filter(call => call.path.endsWith('/files')).length, 0); await f.uploader.close();
});
test('整体deadline与外部取消中断在途分片，返回前等待资源退出', async () => {
  for (const mode of ['abort', 'timeout']) {
    const controller = new AbortController(); let active = 0;
    const f = fixture({ timeoutMs: 5, cos: async (_request, signal) => {
      active++; try { await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('synthetic-signature')), { once: true });
        if (mode === 'abort') queueMicrotask(() => controller.abort());
      }); return 200; } finally { active--; }
    } });
    await assert.rejects(f.uploader.upload({ ...input, signal: controller.signal }), (error: unknown) => error instanceof QqMediaUploadError && error.outcome === 'UNKNOWN');
    assert.equal(active, 0); assert.equal(f.calls.filter(call => call.path.endsWith('/files')).length, 0); await f.uploader.close();
  }
});
test('complete缺少file_info是未知结果，不当成功且不重复创建媒体', async () => {
  const f = fixture({ complete: {} });
  await assert.rejects(f.uploader.upload(input), (error: unknown) => error instanceof QqMediaUploadError && error.stage === 'complete' && error.outcome === 'UNKNOWN');
  assert.equal(f.calls.filter(call => call.path.endsWith('/files')).length, 1); await f.uploader.close();
});
test('真实公共transport仍拒绝敏感query参数，不通过改写URL绕过既有规则', async () => {
  const value = prepare(1, 5); value.parts[0]!.presigned_url = 'https://bucket.myqcloud.com/a?token=synthetic-secret';
  const client: Pick<ReturnType<typeof createQqClient>, 'call'> = { async call() { return value; } };
  // 默认真实Node transport在DNS及网络访问之前拒绝token参数，此测试不连接平台。
  const uploader = createQqMediaUploader({ client });
  await assert.rejects(uploader.upload(input), (error: unknown) => error instanceof QqMediaUploadError && error.cause === undefined && !JSON.stringify(error).includes('synthetic-secret'));
  await uploader.close();
});

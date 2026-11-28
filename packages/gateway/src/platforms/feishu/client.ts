import { randomBytes } from 'node:crypto';
import type { ProviderHttpRequest, ProviderHttpResponse, ProviderTransport } from '@gugu/core/providers';

type Method = ProviderHttpRequest['method'];
type Operation = 'auth' | 'message' | 'reaction' | 'media' | 'card' | 'identity' | 'close';
export class FeishuApiError extends Error {
  constructor(readonly operation: Operation, readonly statusCode?: number, readonly errorCode?: number) {
    super(`飞书 ${operation} 请求失败`); this.name = 'FeishuApiError';
  }
}
export interface FeishuUpload { name: string; data: Uint8Array; contentType: string }
export interface FeishuCallOptions { body?: Record<string, unknown>; files?: Record<string, FeishuUpload>; signal?: AbortSignal; timeoutMs?: number; authorize?(): Promise<boolean> }
const base = 'https://open.feishu.cn';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const segment = '[A-Za-z0-9_-]{1,256}';
function operation(method: Method, path: string): Operation {
  if (method === 'GET' && path === '/open-apis/bot/v3/info') return 'identity';
  if (method === 'POST' && /^\/open-apis\/im\/v1\/messages\?receive_id_type=(chat_id|open_id|user_id|union_id|email)$/.test(path)) return 'message';
  if (method === 'GET' && new RegExp(`^/open-apis/im/v1/messages/${segment}(?:\\?card_msg_content_type=(?:user_card_content|raw_card_content))?$`).test(path)) return 'message';
  if (method === 'POST' && new RegExp(`^/open-apis/im/v1/messages/${segment}/reactions$`).test(path)) return 'reaction';
  if (method === 'POST' && /^\/open-apis\/im\/v1\/(images|files)$/.test(path)) return 'media';
  if (method === 'POST' && path === '/open-apis/cardkit/v1/cards') return 'card';
  if (method === 'PUT' && new RegExp(`^/open-apis/cardkit/v1/cards/${segment}(?:/elements/${segment}/content)?$`).test(path)) return 'card';
  if (method === 'PATCH' && new RegExp(`^/open-apis/cardkit/v1/cards/${segment}/settings$`).test(path)) return 'card';
  throw new FeishuApiError('message');
}

/** 飞书固定官方API；实例绑定一份可信Bot凭据，不从请求正文取得身份或网络目标。 */
export function createFeishuClient(options: { appId: string; appSecret: string; transport?: ProviderTransport; now?: () => number }) {
  if (!options.appId || !options.appSecret) throw new FeishuApiError('auth');
  const { appId, appSecret } = options;
  const lifetime = new AbortController();
  const now = options.now ?? Date.now;
  let transport = options.transport;
  let opening: Promise<ProviderTransport> | undefined;
  let cached: { token: string; expires: number } | undefined;
  let refresh: { task: Promise<string>; controller: AbortController; waiters: number } | undefined;
  async function network() {
    lifetime.signal.throwIfAborted();
    if (!transport) {
      opening ??= import('@gugu/core/providers/node').then(({ NodeProviderTransport }) => new NodeProviderTransport());
      transport = await opening;
    }
    return transport;
  }
  async function request(op: Operation, method: Method, path: string, body: Uint8Array | undefined, headers: Record<string, string>, signal: AbortSignal | undefined, timeoutMs: number, maxBytes: number, parseJson: boolean, authorize?: () => Promise<boolean>): Promise<unknown> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new FeishuApiError(op);
    const timerController = new AbortController();
    const combined = AbortSignal.any([lifetime.signal, timerController.signal, ...(signal ? [signal] : [])]);
    let response: ProviderHttpResponse | undefined;
    const timer = setTimeout(() => timerController.abort(), timeoutMs);
    const cancel = () => { void (async () => { try { await response?.cancel(); } catch { /* 固定错误由主链路处理。 */ } })(); };
    combined.addEventListener('abort', cancel, { once: true });
    try {
      combined.throwIfAborted();
      const currentTransport = await network();
      if (authorize && !await authorize()) throw new FeishuApiError(op, 403);
      combined.throwIfAborted();
      response = await currentTransport.request({ url: base + path, method, headers, body, timeoutMs }, combined);
      combined.throwIfAborted();
      if (response.status >= 300 && response.status < 400) throw new FeishuApiError(op, response.status);
      const length = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-length')?.[1];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new FeishuApiError(op, response.status);
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body) {
        combined.throwIfAborted(); size += chunk.byteLength;
        if (size > maxBytes) throw new FeishuApiError(op, response.status);
        chunks.push(chunk);
      }
      combined.throwIfAborted();
      const data = Buffer.concat(chunks, size);
      if (!parseJson) {
        if (response.status < 200 || response.status >= 300) throw new FeishuApiError(op, response.status);
        return data;
      }
      const result: unknown = JSON.parse(data.toString('utf8'));
      if (response.status < 200 || response.status >= 300 || !object(result) || result.code !== 0) throw new FeishuApiError(op, response.status, object(result) && typeof result.code === 'number' && Number.isSafeInteger(result.code) ? result.code : undefined);
      return result;
    } catch (error) { if (error instanceof FeishuApiError) throw error; throw new FeishuApiError(op, response?.status); }
    finally { clearTimeout(timer); combined.removeEventListener('abort', cancel); try { await response?.cancel(); } catch { /* 不传播原始清理异常。 */ } }
  }
  async function token(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted || lifetime.signal.aborted) throw new FeishuApiError('auth');
    if (cached && cached.expires > now() + 60_000) return cached.token;
    if (!refresh) {
      const controller = new AbortController();
      const entry = { controller, waiters: 0, task: Promise.resolve('') };
      entry.task = (async () => {
        const data = await request('auth', 'POST', '/open-apis/auth/v3/tenant_access_token/internal', Buffer.from(JSON.stringify({ app_id: appId, app_secret: appSecret })), { 'content-type': 'application/json; charset=utf-8' }, controller.signal, 10_000, 4 * 1024 * 1024, true);
        if (!object(data) || typeof data.tenant_access_token !== 'string' || !data.tenant_access_token) throw new FeishuApiError('auth');
        const expires = data.expire ?? 7200;
        if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= 0) throw new FeishuApiError('auth');
        if (controller.signal.aborted) throw new FeishuApiError('auth');
        cached = { token: data.tenant_access_token, expires: now() + expires * 1000 };
        return cached.token;
      })().finally(() => { if (refresh === entry) refresh = undefined; });
      refresh = entry;
    }
    const entry = refresh; entry.waiters++;
    const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    let abort!: () => void;
    try {
      return await Promise.race([entry.task, new Promise<never>((_resolve, reject) => {
        abort = () => reject(new FeishuApiError('auth'));
        combined.addEventListener('abort', abort, { once: true }); if (combined.aborted) abort();
      })]);
    } finally {
      combined.removeEventListener('abort', abort); entry.waiters--;
      if (entry.waiters === 0 && refresh === entry) { refresh = undefined; entry.controller.abort(); }
    }
  }
  function multipart(body: Record<string, unknown>, files: Record<string, FeishuUpload>) {
    const boundary = `gugu-${randomBytes(24).toString('hex')}`;
    const pieces: Uint8Array[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) throw new FeishuApiError('media');
      pieces.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}\r\n`));
    }
    for (const [key, file] of Object.entries(files)) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(key) || !file.name || /[\r\n\0"\\]/.test(file.name) || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(file.contentType) || !(file.data instanceof Uint8Array) || file.data.byteLength > 100 * 1024 * 1024) throw new FeishuApiError('media');
      pieces.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${file.name}"\r\nContent-Type: ${file.contentType}\r\n\r\n`), file.data, Buffer.from('\r\n'));
    }
    pieces.push(Buffer.from(`--${boundary}--\r\n`));
    return { data: Buffer.concat(pieces), type: `multipart/form-data; boundary=${boundary}` };
  }
  async function call(method: Method, path: string, args: FeishuCallOptions = {}): Promise<Record<string, unknown>> {
    const op = operation(method, path);
    let payload: { data: Uint8Array; type: string };
    try {
      payload = args.files && Object.keys(args.files).length ? multipart(args.body ?? {}, args.files) : { data: Buffer.from(JSON.stringify(args.body ?? {})), type: 'application/json; charset=utf-8' };
    } catch { throw new FeishuApiError(op); }
    const auth = await token(args.signal);
    return await request(op, method, path, method === 'GET' ? undefined : payload.data, { Authorization: `Bearer ${auth}`, 'content-type': payload.type }, args.signal, args.timeoutMs ?? 15_000, 4 * 1024 * 1024, true, args.authorize) as Record<string, unknown>;
  }
  async function downloadResource(messageId: string, fileKey: string, type: 'image' | 'file', args: { maxBytes: number; signal?: AbortSignal; authorize?: FeishuCallOptions['authorize'] }): Promise<Uint8Array> {
    if (!new RegExp(`^${segment}$`).test(messageId) || !new RegExp(`^${segment}$`).test(fileKey) || !['image', 'file'].includes(type) || !Number.isSafeInteger(args.maxBytes) || args.maxBytes <= 0 || args.maxBytes > 100 * 1024 * 1024) throw new FeishuApiError('media');
    const auth = await token(args.signal);
    return await request('media', 'GET', `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`, undefined, { Authorization: `Bearer ${auth}` }, args.signal, 60_000, args.maxBytes, false, args.authorize) as Uint8Array;
  }
  return { call, downloadResource, async close() {
    lifetime.abort(); refresh?.controller.abort(); cached = undefined;
    try { if (!transport && opening) transport = await opening; await transport?.close?.(); } catch { throw new FeishuApiError('close'); }
  } };
}

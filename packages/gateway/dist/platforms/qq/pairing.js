import { dataContext } from '@gugu/core/contracts';
export class QqConnectionError extends Error {
    statusCode;
    name = 'QqConnectionError';
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
async function decryptSecret(encrypted, key) {
    const raw = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0)), bytes = Uint8Array.from(atob(key), c => c.charCodeAt(0));
    if (bytes.length !== 32 || raw.length < 28)
        throw new Error('密文格式无效');
    const aes = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['decrypt']);
    return new TextDecoder('utf-8', { fatal: true }).decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, aes, raw.subarray(12)));
}
export function createQqPairing(options) {
    const base = options.portalBase.replace(/\/$/, '');
    async function platform() { if (options.stateAvailable === false)
        throw new QqConnectionError(503, 'QQ 连接状态暂不可用'); if (!(await options.platforms()).includes('qq'))
        throw new QqConnectionError(503, '该即时通讯平台暂未开放'); }
    async function json(path, body, timeout) {
        let response;
        try {
            response = await options.transport.request({ url: base + path, method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeoutMs: timeout, allowLocal: options.allowLocal ?? false }, AbortSignal.timeout(timeout));
            if (response.status < 200 || response.status >= 300)
                throw new Error('上游请求失败');
            let text = '', size = 0;
            const decoder = new TextDecoder('utf-8', { fatal: true });
            for await (const chunk of response.body) {
                size += chunk.byteLength;
                if (size > 1024 * 1024)
                    throw new Error('上游响应过大');
                text += decoder.decode(chunk, { stream: true });
            }
            text += decoder.decode();
            const result = JSON.parse(text);
            if (!object(result))
                throw new Error('上游响应无效');
            return result;
        }
        catch {
            throw new QqConnectionError(502, path.includes('create') ? '创建 QQ 连接任务失败' : '轮询失败');
        }
        finally {
            await response?.cancel();
        }
    }
    const store = async (work) => { try {
        return await work();
    }
    catch {
        throw new QqConnectionError(503, 'QQ 连接状态暂不可用');
    } };
    return {
        async start(ownerId) {
            const owner = dataContext(ownerId).ownerId;
            await platform();
            const key = options.generateKey();
            const data = await json('/lite/create_bind_task', { key }, 15000);
            if (data.retcode !== 0)
                throw new QqConnectionError(502, 'QQ 返回错误');
            const detail = object(data.data) ? data.data : {}, task = detail.task_id;
            if (typeof task !== 'string' || !task || task.length > 512)
                throw new QqConnectionError(502, 'QQ 未返回 task_id');
            const saved = await store(() => options.store.saveIfAbsent(`qqconnect:${task}`, JSON.stringify({ uid: owner, key }), 600));
            if (!saved)
                throw new QqConnectionError(502, 'QQ 连接任务冲突，请重试');
            const scan = new URL(base + '/qqbot/openclaw/connect.html');
            scan.searchParams.set('task_id', task);
            scan.searchParams.set('_wv', '2');
            scan.searchParams.set('source', 'Gugu');
            return { task_id: task, scan_url: scan.toString() };
        },
        async poll(ownerId, taskId) {
            const owner = dataContext(ownerId).ownerId;
            await platform();
            const raw = await store(() => options.store.get(`qqconnect:${taskId}`));
            if (!raw)
                return { status: 'expired' };
            let meta;
            try {
                const value = JSON.parse(raw);
                if (!object(value))
                    throw new Error();
                meta = value;
            }
            catch {
                throw new QqConnectionError(503, 'QQ 连接状态暂不可用');
            }
            if (meta.uid !== owner)
                throw new QqConnectionError(403, '任务不属于当前用户');
            const data = await json('/lite/poll_bind_result', { task_id: taskId }, 10000);
            if (data.retcode !== 0)
                return { status: 'fail', reason: 'QQ 授权失败' };
            const detail = object(data.data) ? data.data : {};
            if (detail.status === 3) {
                await store(() => options.store.delete(`qqconnect:${taskId}`));
                return { status: 'expired' };
            }
            if (detail.status !== 2)
                return { status: 'waiting' };
            const app = detail.bot_appid ? String(detail.bot_appid) : '', encrypted = detail.bot_encrypt_secret;
            if (!app || typeof encrypted !== 'string' || !encrypted)
                return { status: 'fail', reason: '缺少 app_id 或 secret' };
            let secret;
            try {
                secret = await decryptSecret(encrypted, String(meta.key));
            }
            catch {
                return { status: 'fail', reason: 'secret 解密失败' };
            }
            const userOpenId = typeof detail.user_openid === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(detail.user_openid)
                ? detail.user_openid : undefined;
            const result = await options.saveBot(owner, app, secret, userOpenId);
            await store(() => options.store.delete(`qqconnect:${taskId}`));
            if (!result)
                return { status: 'fail', reason: '每个咕咕账号只能绑定一个 QQ 机器人' };
            await options.onSaved?.(owner);
            return { status: 'success', bot: result };
        },
    };
}

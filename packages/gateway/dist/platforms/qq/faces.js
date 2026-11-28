const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('QQ 消息引用或表情准备未完成');
const indexUrl = 'https://koishi.js.org/QFace/assets/qq_emoji/_index.json';
const assetsBase = 'https://koishi.js.org/QFace/';
const indexTtl = 6 * 3600 * 1000, failureDelay = 60_000;
/** Python QFace选择顺序；只接受固定公共资源目录，不能由索引注入远程目标。 */
export function selectQqFaceAsset(index, faceId) {
    const id = faceId.trim();
    if (!id)
        return null;
    const exact = index.filter(item => String(item.emojiId ?? '') === id);
    const fallback = index.filter(item => String(item.qzoneCode ?? '') === id && !exact.includes(item));
    for (const item of [...exact, ...fallback]) {
        const assets = Array.isArray(item.assets) ? item.assets.filter(object) : [];
        const selected = assets.find(asset => asset.type === 2) ?? assets.find(asset => asset.type === 0);
        if (!selected || typeof selected.path !== 'string' || !selected.path.startsWith('assets/qq_emoji/') || selected.path.includes('..') ||
            !/^[A-Za-z0-9_./-]+$/u.test(selected.path))
            continue;
        return { url: assetsBase + selected.path, filename: String(selected.name || 'qq-face.png'), mime: 'image/png' };
    }
    return null;
}
export function createQqFaceResolver(options) {
    const now = options.now ?? Date.now;
    const lifetime = new AbortController();
    let index, loadedAt = 0, retryAfter = 0, loading;
    async function loadIndex() {
        if (index && now() - loadedAt < indexTtl)
            return index;
        if (loading)
            return loading;
        loading = (async () => {
            const response = await options.transport.request({ url: indexUrl, method: 'GET', headers: {}, timeoutMs: 3000 }, lifetime.signal);
            try {
                if (response.status !== 200)
                    throw invalid();
                let size = 0;
                const chunks = [];
                for await (const chunk of response.body) {
                    lifetime.signal.throwIfAborted();
                    size += chunk.byteLength;
                    if (size > 4 * 1024 * 1024)
                        throw invalid();
                    chunks.push(chunk);
                }
                const raw = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
                if (!Array.isArray(raw))
                    throw invalid();
                index = raw.filter(object);
                loadedAt = now();
                return index;
            }
            finally {
                await response.cancel();
            }
        })();
        try {
            return await loading;
        }
        finally {
            loading = undefined;
        }
    }
    async function systemFace(type, id, signal) {
        if (!['1', '3'].includes(type) || !id.trim() || now() < retryAfter)
            return null;
        try {
            const result = selectQqFaceAsset(await loadIndex(), id);
            signal.throwIfAborted();
            return result;
        }
        catch {
            signal.throwIfAborted();
            retryAfter = now() + failureDelay;
            try {
                options.report?.('qface-unavailable');
            }
            catch { /* 增强能力故障只报告固定码，普通占位仍可处理。 */ }
            return null;
        }
    }
    async function appendAssets(parsed, signal) {
        const p = parsed.payload;
        if (p.emoji_refs.length && !parsed.mediaItems.length) {
            for (const ref of p.emoji_refs) {
                const asset = await systemFace(ref.face_type, ref.face_id, signal);
                if (!asset)
                    continue;
                parsed.mediaItems.push({ source: 'message', attachmentIndex: parsed.mediaItems.length, sourcePlatformMessageId: null,
                    item: { url: asset.url, filename: asset.filename, content_type: asset.mime, qq_face: true,
                        qq_face_type: ref.face_type, qq_face_id: ref.face_id, qface_generated: true } });
            }
        }
    }
    return {
        appendAssets,
        async close() {
            lifetime.abort();
            await loading?.catch(() => undefined);
        },
    };
}

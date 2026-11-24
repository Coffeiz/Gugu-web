import { QqMediaUploadError } from '../platforms/qq/media-upload.js';
export const imOutboundMediaLimits = Object.freeze({
    qq: 30 * 1024 * 1024,
    wechat: 20 * 1024 * 1024,
    telegram: 50_000_000,
    feishu: 100 * 1024 * 1024,
});
export function validateImOutboundFile(platform, file) {
    return typeof file.name === 'string' && !!file.name && [...file.name].length <= 180
        && !/[\x00-\x1f\x7f"\\/]/u.test(file.name) && typeof file.ext === 'string' && /^[A-Za-z0-9]{0,16}$/u.test(file.ext)
        && typeof file.mime === 'string' && !!file.mime
        && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= imOutboundMediaLimits[platform];
}
/** 宿主验证文件和会话归属后，按平台协议上传并投递。 */
export async function sendImMedia(input) {
    const { platform, scope, file, bytes, signal, authorize } = input;
    if (platform.platform !== scope.platform || !validateImOutboundFile(scope.platform, { ...file, size: bytes.byteLength })
        || signal?.aborted || !await authorize())
        return null;
    const recipient = scope.chatId ?? scope.platformUserId;
    const name = file.ext ? `${file.name}.${file.ext}` : file.name;
    const image = /^image\/(png|jpeg|gif|webp|bmp)$/.test(file.mime);
    switch (platform.platform) {
        case 'telegram':
            return { recipient, receipt: await platform.sender.file({ chatId: recipient, chatType: scope.chatType }, bytes, name, signal, authorize) };
        case 'feishu': {
            const chatId = scope.chatType === 'group' ? scope.chatId : input.feishuChatId;
            if (typeof chatId !== 'string' || !/^oc_[A-Za-z0-9_-]+$/.test(chatId))
                return null;
            return { recipient: chatId, receipt: await platform.sender.file(chatId, bytes, file.name, file.ext, signal, authorize) };
        }
        case 'wechat': {
            const contextToken = input.wechatContextToken;
            if (scope.chatType !== 'c2c' || typeof contextToken !== 'string' || !contextToken)
                return null;
            const target = { userId: scope.platformUserId, contextToken };
            const receipt = image
                ? await platform.sender.image(target, bytes, signal, authorize)
                : await platform.sender.file(target, bytes, name, signal, authorize);
            return { recipient, receipt };
        }
        case 'qq': {
            const send = await prepareQqMedia({ ...input, platform }, recipient, name, image);
            return send ? send() : null;
        }
    }
}
async function prepareQqMedia(input, recipient, name, image, partConcurrencyLimit) {
    const { platform, scope, bytes, signal, authorize } = input;
    let media;
    try {
        media = await platform.mediaUpload.upload({ target: scope.chatType === 'group' ? 'groups' : 'users', openid: recipient,
            fileType: image ? 1 : 4, data: bytes, fileName: name, signal, authorize, partConcurrencyLimit });
    }
    catch (error) {
        if (!(error instanceof QqMediaUploadError))
            throw error;
        input.onQqUploadFailure?.(error);
        return null;
    }
    const fileInfo = media.file_info;
    if (typeof fileInfo !== 'string')
        return null;
    return async () => {
        if (signal?.aborted || !await authorize())
            return null;
        const receipt = await platform.sender.media({ id: recipient, chatType: scope.chatType }, { fileInfo, image, filename: name }, signal, authorize, input.onQqMessageFailure);
        return { recipient, receipt };
    };
}
/** 上传最多预取一张，发送顺序及单件回执仍由原发送器决定。 */
export async function* sendQqImageBatch(inputs) {
    const lifetime = new AbortController();
    const prepare = async (input) => {
        const { scope, file, bytes } = input;
        const signal = input.signal ? AbortSignal.any([input.signal, lifetime.signal]) : lifetime.signal;
        if (scope.platform !== 'qq' || !/^image\/(png|jpeg|gif|webp|bmp)$/.test(file.mime)
            || !validateImOutboundFile('qq', { ...file, size: bytes.byteLength }) || signal.aborted || !await input.authorize())
            return null;
        const name = file.ext ? `${file.name}.${file.ext}` : file.name;
        return prepareQqMedia({ ...input, signal }, scope.chatId ?? scope.platformUserId, name, true, inputs.length > 1 ? 5 : undefined);
    };
    const start = (index) => {
        const item = inputs[index];
        return item ? prepare(item).catch(() => null) : undefined;
    };
    let current = start(0);
    let next = start(1);
    try {
        for (let index = 0; current; index++) {
            const send = await current;
            let outcome = 'rejected';
            if (send) {
                try {
                    outcome = (await send())?.receipt.outcome ?? 'rejected';
                }
                catch {
                    outcome = 'unknown';
                }
            }
            yield { index, outcome };
            current = next;
            next = start(index + 2);
        }
    }
    finally {
        lifetime.abort();
        await Promise.allSettled([current, next]);
    }
}

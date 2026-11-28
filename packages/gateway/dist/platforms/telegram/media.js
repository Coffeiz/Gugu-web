import { createImMediaBudget } from '../../runtime/media-budget.js';
import { lookup as lookupMime } from 'mime-types';
import { TelegramApiError } from './client.js';
/** 入站额度使用十进制 MB。 */
export const TELEGRAM_INGRESS_MAX_BYTES = 20_000_000;
const sizeNotice = 'Telegram 单个附件下载上限为 20 MB，超限附件未接收。';
const downloadNotice = '有附件暂时无法从 Telegram 下载，请稍后重试或重新发送。';
const stagingNotice = '有附件已从 Telegram 下载，但保存失败，请稍后重试或重新发送。';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => typeof value === 'number' && Number.isSafeInteger(value);
export class TelegramMediaIngressError extends Error {
    code;
    constructor(code) {
        super('Telegram 媒体处理未完成');
        this.code = code;
        this.name = 'TelegramMediaIngressError';
    }
}
function safeFilename(raw, mediaType) {
    const fallback = { photo: 'jpg', voice: 'ogg', video: 'mp4', video_note: 'mp4', animation: 'mp4' };
    const leaf = typeof raw === 'string' && raw ? raw.replaceAll('\\', '/').split('/').at(-1) : '附件';
    let filename = Array.from(leaf).filter(char => (char === ' ' || !/[\p{C}\p{Z}]/u.test(char)) && char !== '/' && char !== '\\').slice(0, 180).join('');
    if (!filename || filename === '.' || filename === '..')
        filename = '附件';
    const dot = filename.lastIndexOf('.');
    const name = dot > 0 && !filename.startsWith('.') ? filename.slice(0, dot) : filename;
    const ext = dot > 0 && !filename.startsWith('.') ? Array.from(filename.slice(dot + 1).toLowerCase()).slice(0, 10).join('') : '';
    return [Array.from(name).slice(0, 160).join('') || '附件', ext || fallback[mediaType] || 'bin'];
}
function mimeType(item, ext, mediaType) {
    const prefixes = { photo: 'image/', voice: 'audio/', audio: 'audio/', video: 'video/', video_note: 'video/', animation: 'video/' };
    const fallback = { photo: 'image/jpeg', voice: 'audio/ogg', audio: 'audio/mpeg', video: 'video/mp4', video_note: 'video/mp4', animation: 'video/mp4' };
    const candidate = typeof item.mime_type === 'string' ? item.mime_type : '';
    if (/^[A-Za-z0-9.+-]{1,127}\/[A-Za-z0-9.+-]{1,127}$/.test(candidate) && (!prefixes[mediaType] || candidate.toLowerCase().startsWith(prefixes[mediaType])))
        return candidate.toLowerCase();
    return fallback[mediaType] || lookupMime(`attachment.${ext}`) || 'application/octet-stream';
}
/** 下载实际文件并交给已授权的宿主暂存，允许同批其他附件继续处理。 */
export async function processTelegramAttachments(api, token, attachments, signal, stage, authorize) {
    const raw = attachments.filter(object).map(item => ({ ...item }));
    const checkCancelled = (signal) => {
        if (signal.aborted)
            throw new TelegramMediaIngressError('cancelled');
    };
    let sizeLimitExceeded = false, downloadFailed = false, stagingFailed = false, downloadBudgetExceeded = false;
    const budget = createImMediaBudget(TELEGRAM_INGRESS_MAX_BYTES);
    for (const [index, item] of raw.entries()) {
        checkCancelled(signal);
        const fileId = item.file_id;
        if (typeof fileId !== 'string' || !fileId || fileId.length > 512 || /[\x00-\x1f\x7f]/.test(fileId)) {
            downloadFailed = true;
            continue;
        }
        if (integer(item.file_size) && item.file_size > TELEGRAM_INGRESS_MAX_BYTES) {
            sizeLimitExceeded = true;
            continue;
        }
        if (downloadBudgetExceeded || !budget.remaining) {
            sizeLimitExceeded = true;
            continue;
        }
        let downloaded = false;
        try {
            if (authorize && !await authorize())
                throw new TelegramMediaIngressError('cancelled');
            const info = await api.call(token, 'getFile', { payload: { file_id: fileId }, signal, ...(authorize ? { authorize } : {}) });
            checkCancelled(signal);
            if (!object(info)) {
                downloadFailed = true;
                continue;
            }
            if (integer(info.file_size) && info.file_size > TELEGRAM_INGRESS_MAX_BYTES) {
                sizeLimitExceeded = true;
                continue;
            }
            const data = await api.downloadFile(token, typeof info.file_path === 'string' ? info.file_path : '', { maxBytes: TELEGRAM_INGRESS_MAX_BYTES, signal, ...(authorize ? { authorize } : {}) });
            checkCancelled(signal);
            if (!(data instanceof Uint8Array) || !data.byteLength || integer(info.file_size) && data.byteLength !== info.file_size) {
                downloadFailed = true;
                continue;
            }
            if (!budget.consume(data.byteLength)) {
                downloadBudgetExceeded = true;
                sizeLimitExceeded = true;
                continue;
            }
            downloaded = true;
            const mediaType = typeof item.media_type === 'string' ? item.media_type : '';
            const [name, ext] = safeFilename(item.file_name, mediaType);
            const attachmentIndex = item.source_attachment_index === undefined ? index : item.source_attachment_index;
            if (!integer(attachmentIndex) || attachmentIndex < 0)
                throw new Error();
            await stage({ name, ext, mime: mimeType(item, ext, mediaType), data,
                kind: mediaType === 'photo' ? 'image' : mediaType === 'voice' ? 'voice' : 'file',
                duration: typeof item.duration === 'number' && Number.isFinite(item.duration) ? item.duration : null,
                attachmentIndex }, signal);
        }
        catch (error) {
            checkCancelled(signal);
            if (error instanceof TelegramMediaIngressError)
                throw error;
            if (error instanceof TelegramApiError && error.operation === 'getFile' && error.statusCode === 413)
                sizeLimitExceeded = true;
            else if (downloaded)
                stagingFailed = true;
            else
                downloadFailed = true;
        }
    }
    return { sizeLimitExceeded, failureNotice: [sizeLimitExceeded ? sizeNotice : '', downloadFailed ? downloadNotice : '', stagingFailed ? stagingNotice : ''].filter(Boolean).join('\n') || null };
}
/** 引用只携带可信会话内的来源键与附件索引。 */
export function telegramAttachmentReference(item) {
    const sourceMessageId = item.source_platform_message_id;
    if (typeof sourceMessageId !== 'string' || !sourceMessageId)
        return null;
    const index = item.source_attachment_index;
    return { sourceMessageId, sourceIndex: integer(index) && index >= 0 ? index : 0 };
}

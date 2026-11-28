import { byteSource, multipartBody } from '@gugu/core/providers';
import { splitMarkdownV2 } from '@gugu/core/im/telegram-format';
import { validateTelegramBotToken } from './client.js';
import { verifyTelegramBotIdentity } from './pairing.js';
export const telegramDocumentLimit = 50_000_000;
export const telegramPhotoLimit = 10_000_000;
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
/** 官方 Bot API 只有 URL 路径 Token 认证；固定 origin、无重定向且不暴露底层异常。 */
export function createTelegramDeliveryApi(transport) {
    async function call(tokenValue, method, body = {}, contentType = 'application/json', timeoutMs = 20_000, suppliedSignal) {
        const token = validateTelegramBotToken(tokenValue);
        const signal = suppliedSignal ?? AbortSignal.timeout(timeoutMs);
        let response;
        try {
            response = await transport.request({
                url: `https://api.telegram.org/bot${token}/${method}`,
                method: 'POST', headers: { 'content-type': contentType }, body, timeoutMs,
            }, signal);
            let raw = '', size = 0;
            const decoder = new TextDecoder('utf-8', { fatal: true });
            for await (const chunk of response.body) {
                size += chunk.byteLength;
                if (size > 1024 * 1024)
                    throw new Error('Telegram API 响应超限');
                raw += decoder.decode(chunk, { stream: true });
            }
            raw += decoder.decode();
            const value = JSON.parse(raw);
            if (response.status >= 300 || !object(value) || value.ok !== true)
                throw Object.assign(new Error('Telegram API 请求失败'), {
                    statusCode: response.status, errorCode: object(value) ? value.error_code : undefined,
                });
            if (!object(value.result))
                throw new Error('Telegram API 响应无效');
            return value.result;
        }
        catch (error) {
            const statusCode = error?.statusCode;
            const errorCode = error?.errorCode;
            throw Object.assign(new Error('Telegram API 请求失败'), {
                ...(typeof statusCode === 'number' ? { statusCode } : {}),
                ...(typeof errorCode === 'number' ? { errorCode } : {}),
            });
        }
        finally {
            await response?.cancel();
        }
    }
    return {
        async sendMessage(token, chatId, text, plainText = false) {
            if (!chatId || chatId.length > 256 || !text)
                return false;
            const chunks = plainText ? text.match(/[\s\S]{1,2048}/gu) : splitMarkdownV2(text);
            for (const chunk of chunks) {
                const result = await call(token, 'sendMessage', { chat_id: chatId, text: chunk, ...(plainText ? {} : { parse_mode: 'MarkdownV2' }) });
                if (typeof result.message_id !== 'number' || !Number.isSafeInteger(result.message_id) || result.message_id <= 0)
                    return false;
            }
            return true;
        },
        async sendAttachment(token, chatId, file) {
            if (!chatId || chatId.length > 256 || file.bytes.byteLength === 0 || file.bytes.byteLength > telegramDocumentLimit
                || !file.filename || file.filename.length > 180 || /[\r\n]/u.test(file.mime))
                return false;
            const photo = /\.(?:jpe?g|png)$/iu.test(file.filename) && file.bytes.byteLength <= telegramPhotoLimit;
            const send = async (method, fieldName) => {
                const boundary = `guguTelegram${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
                const signal = AbortSignal.timeout(120_000);
                const body = multipartBody({ chat_id: chatId }, {
                    name: file.filename, mime: file.mime || 'application/octet-stream', source: byteSource(file.bytes),
                }, boundary, signal, fieldName);
                const result = await call(token, method, body, `multipart/form-data; boundary=${boundary}`, 120_000, signal);
                return typeof result.message_id === 'number' && Number.isSafeInteger(result.message_id) && result.message_id > 0;
            };
            if (!photo)
                return send('sendDocument', 'document');
            try {
                return await send('sendPhoto', 'photo');
            }
            catch (error) {
                if (error?.errorCode !== 400)
                    throw error;
                return send('sendDocument', 'document');
            }
        },
        verify: (token) => verifyTelegramBotIdentity(method => call(token, method)),
    };
}

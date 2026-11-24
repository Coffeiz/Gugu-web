import { normalizeQqFaces, normalizeQqAttachmentPlaceholders } from './message.js';
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('QQ 消息引用或表情准备未完成');
const facePattern = /<faceType=[^,>]+,faceId="[^"]*",ext="[^"]*">/gu;
export function createQqInboundPreparation(options) {
    if (typeof options.authorize !== 'function')
        throw invalid();
    const lifetime = new AbortController();
    async function prepare(scope, input, signal) {
        try {
            signal.throwIfAborted();
            lifetime.signal.throwIfAborted();
            scope = Object.freeze({ ...scope });
            const parsed = structuredClone(input), p = parsed.payload;
            if (scope.platform !== 'qq' || p.platform !== 'qq' || p.owner_user_id !== scope.ownerId || p.bot_id !== scope.botId || p.channel_id !== scope.botId ||
                p.chat_type !== scope.chatType || p.platform_user_id !== scope.platformUserId || (p.chat_type === 'group' ? p.chat_id !== scope.chatId : scope.chatId !== null))
                throw invalid();
            if (!await options.authorize(scope, signal))
                throw invalid();
            signal.throwIfAborted();
            const messageIndex = String(parsed.indexEntry.message_index || '');
            if (!messageIndex || parsed.indexEntry.sender_id !== scope.platformUserId)
                throw invalid();
            // 此处之前必须完成秘密/绑定/交互/取消预检；不记录被消费控制消息的正文或签名URL。
            await options.references.remember(scope, messageIndex, parsed.indexEntry, signal);
            if (parsed.quoteRequest) {
                const entry = await options.references.read(scope, parsed.quoteRequest.referenceIndex, signal);
                if (entry) {
                    p.reply_target_sender_id = typeof entry.sender_id === 'string' && entry.sender_id ? entry.sender_id : null;
                    p.reply_target_is_bot = typeof entry.sender_is_bot === 'boolean' ? entry.sender_is_bot : null;
                    if (parsed.quoteRequest.contentRequired) {
                        const quoted = Array.isArray(entry.attachments) ? entry.attachments.filter(object) : [];
                        if (!p.quoted_text) {
                            const text = normalizeQqFaces(normalizeQqAttachmentPlaceholders(String(entry.content || ''), quoted));
                            p.quoted_text = quoted.length && text === '[QQ表情]' ? null : text || null;
                        }
                        parsed.mediaItems.push(...quoted.map((item, index) => ({ source: 'quote', attachmentIndex: index,
                            sourcePlatformMessageId: parsed.quoteRequest.referenceIndex, item: { ...item, quoted: true, source_platform_message_id: parsed.quoteRequest.referenceIndex, source_attachment_index: index } })));
                    }
                }
            }
            if (parsed.splitFace.waitForImage) {
                await options.references.queueFace(scope, p.message_id, parsed.splitFace.emojiRefs, signal);
                return null;
            }
            const ownMedia = parsed.mediaItems.filter(item => item.source === 'message');
            const pending = !p.qq_face_marker && ownMedia.length ? await options.references.takeFace(scope, p.message_id, signal) : [];
            if (p.qq_face_marker || pending.length)
                for (const item of ownMedia)
                    item.item.qq_face = true;
            if (p.qq_face_marker && ownMedia.length)
                p.text = normalizeQqFaces(parsed.rawText.replace(facePattern, '').trim());
            if (pending.length) {
                p.text = '';
                parsed.splitFace.emojiRefs = pending;
            }
            await options.appendAssets(parsed, signal);
            if (parsed.splitFace.faceOnly && !parsed.mediaItems.length && !p.text.trim())
                p.text = '[QQ表情]';
            p.attention_raw_text = p.text;
            signal.throwIfAborted();
            // 网络索引查询可能跨过停用通知；媒体stage还会再次验证scope。
            if (!await options.authorize(scope, signal))
                throw invalid();
            return parsed;
        }
        catch {
            signal.throwIfAborted();
            throw invalid();
        }
    }
    return { prepare, close() { lifetime.abort(); } };
}
export const QQ_REFERENCE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const QQ_REFERENCE_MAX_ENTRIES = 50_000;
export const QQ_FACE_PENDING_MS = 3000;

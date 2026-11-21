import type { ImConversationScope } from '../ir/inbound.js'
import type { createFeishuSender } from '../platforms/feishu/sender.js'
import type { createQqMediaUploader } from '../platforms/qq/media-upload.js'
import type { createQqSender } from '../platforms/qq/sender.js'
import type { createTelegramSender } from '../platforms/telegram/sender.js'
import type { createWechatSender } from '../platforms/wechat/sender.js'

type MediaSender =
  | { platform: 'feishu'; sender: Pick<ReturnType<typeof createFeishuSender>, 'file'> }
  | { platform: 'qq'; sender: Pick<ReturnType<typeof createQqSender>, 'media'>; mediaUpload: Pick<ReturnType<typeof createQqMediaUploader>, 'upload'> }
  | { platform: 'telegram'; sender: Pick<ReturnType<typeof createTelegramSender>, 'file'> }
  | { platform: 'wechat'; sender: Pick<ReturnType<typeof createWechatSender>, 'image' | 'file'> }

export const imOutboundMediaLimits = Object.freeze({
  qq: 30 * 1024 * 1024,
  wechat: 20 * 1024 * 1024,
  telegram: 50_000_000,
  feishu: 100 * 1024 * 1024,
} satisfies Record<ImConversationScope['platform'], number>)

export function validateImOutboundFile(platform: ImConversationScope['platform'],
  file: { name: unknown; ext: unknown; mime: unknown; size: number }): file is { name: string; ext: string; mime: string; size: number } {
  return typeof file.name === 'string' && !!file.name && [...file.name].length <= 180
    && !/[\x00-\x1f\x7f"\\/]/u.test(file.name) && typeof file.ext === 'string' && /^[A-Za-z0-9]{0,16}$/u.test(file.ext)
    && typeof file.mime === 'string' && !!file.mime
    && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= imOutboundMediaLimits[platform]
}

/** 宿主验证文件和会话归属后，按平台协议上传并投递。 */
export async function sendImMedia(input: {
  platform: MediaSender
  scope: Pick<ImConversationScope, 'platform' | 'chatId' | 'chatType' | 'platformUserId'>
  file: { name: string; ext: string; mime: string }
  bytes: Uint8Array
  feishuChatId?: unknown
  wechatContextToken?: unknown
  authorize(): Promise<boolean>
  signal?: AbortSignal
}) {
  const { platform, scope, file, bytes, signal, authorize } = input
  if (platform.platform !== scope.platform || !validateImOutboundFile(scope.platform, { ...file, size: bytes.byteLength })
    || signal?.aborted || !await authorize()) return null
  const recipient = scope.chatId ?? scope.platformUserId
  const name = file.ext ? `${file.name}.${file.ext}` : file.name
  const image = /^image\/(png|jpeg|gif|webp|bmp)$/.test(file.mime)

  switch (platform.platform) {
    case 'telegram':
      return { recipient, receipt: await platform.sender.file({ chatId: recipient, chatType: scope.chatType }, bytes, name, signal, authorize) }
    case 'feishu': {
      const chatId = scope.chatType === 'group' ? scope.chatId : input.feishuChatId
      if (typeof chatId !== 'string' || !/^oc_[A-Za-z0-9_-]+$/.test(chatId)) return null
      return { recipient: chatId, receipt: await platform.sender.file(chatId, bytes, file.name, file.ext, signal, authorize) }
    }
    case 'wechat': {
      const contextToken = input.wechatContextToken
      if (scope.chatType !== 'c2c' || typeof contextToken !== 'string' || !contextToken) return null
      const target = { userId: scope.platformUserId, contextToken }
      const receipt = image
        ? await platform.sender.image(target, bytes, signal, authorize)
        : await platform.sender.file(target, bytes, name, signal, authorize)
      return { recipient, receipt }
    }
    case 'qq': {
      const media = await platform.mediaUpload.upload({ target: scope.chatType === 'group' ? 'groups' : 'users', openid: recipient,
        fileType: image ? 1 : 4, data: bytes, fileName: name, signal, authorize })
      if (typeof media.file_info !== 'string' || !await authorize()) return null
      const receipt = await platform.sender.media({ id: recipient, chatType: scope.chatType },
        { fileInfo: media.file_info, image, filename: name }, signal, authorize)
      return { recipient, receipt }
    }
  }
}

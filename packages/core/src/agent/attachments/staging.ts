export const CHAT_ATTACHMENT_STAGING_BYTES = 1024 * 1024 * 1024
export const CHAT_ATTACHMENT_AUDIO_MATERIALIZE_BYTES = 64 * 1024 * 1024

export type ChatAttachmentKind = 'image' | 'audio' | 'video' | 'text' | 'binary'

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'tif'])
const audioExtensions = new Set(['mp3', 'wav', 'flac', 'm4a', 'ogg', 'amr', 'silk', 'sil', 'slk', 'opus', 'aac', 'wma', 'webm', '3gp', '3gpp'])
const videoExtensions = new Set(['mp4', 'mov', 'avi', 'wmv', 'mkv'])
const textExtensions = new Set(['md', 'txt', 'json', 'csv', 'yaml', 'yml', 'log', 'py', 'js', 'ts', 'tsx', 'jsx', 'vue', 'html', 'css', 'scss', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'sh', 'sql', 'xml', 'toml', 'ini', 'conf', 'env', 'tex'])
const extractableOfficeExtensions = new Set(['pdf', 'docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'ods', 'pptx', 'ppt', 'odp'])
const audioProcessingExtensions = new Set(['webm', 'opus', 'silk', 'sil', 'slk', 'amr', 'aac', 'wma'])
const nativeAudioExtensions = new Set(['mp3', 'wav', 'flac', 'm4a', 'ogg'])

/** 对应 Python chat_attach.file_types.kind_for_ext；SVG 按原行为保持 binary。 */
export function classifyChatAttachment(extension: string): ChatAttachmentKind {
  const ext = extension.toLowerCase()
  if (imageExtensions.has(ext)) return 'image'
  if (audioExtensions.has(ext)) return 'audio'
  if (videoExtensions.has(ext)) return 'video'
  if (textExtensions.has(ext) || extractableOfficeExtensions.has(ext)) return 'text'
  return 'binary'
}

/** 对应 Python UploadFile.filename.rsplit('.', 1)，不对展示名做路径解释。 */
export function parseChatAttachmentFilename(filename: string | null | undefined): { name: string; ext: string } {
  const source = filename || 'file'
  const index = source.lastIndexOf('.')
  const name = index < 0 ? source : source.slice(0, index)
  const ext = index < 0 ? '' : source.slice(index + 1)
  return { name: name || 'file', ext }
}

export class ChatAttachmentCapacityError extends Error {
  readonly statusCode = 413
  constructor() { super('聊天附件暂存空间已满，请先清理旧附件后再试') }
}

export class ChatVoiceAttachmentTooLargeError extends Error {
  readonly statusCode = 400
  constructor(maxBytes: number) { super(`语音录音过大（上限 ${Math.floor(maxBytes / (1024 * 1024))}MB），请分段录制后再发送`) }
}

export function assertChatAttachmentCapacity(usedBytes: number, incomingBytes: number, capacityBytes = CHAT_ATTACHMENT_STAGING_BYTES): void {
  if (![usedBytes, incomingBytes, capacityBytes].every(Number.isSafeInteger) || usedBytes < 0 || incomingBytes < 0 || capacityBytes < 0)
    throw new TypeError('聊天附件容量无效')
  if (incomingBytes > Math.max(capacityBytes - usedBytes, 0)) throw new ChatAttachmentCapacityError()
}

export function planChatAttachmentProcessing(input: {
  ext: string; mime: string | null; size: number; voice: boolean; cap?: number
}): { needsAudioProcessing: boolean; materialize: boolean; transcode: boolean } {
  const ext = input.ext.toLowerCase(), mime = (input.mime ?? '').toLowerCase()
  const needsAudioProcessing = input.voice || mime.startsWith('audio') || mime.includes('voice') || audioProcessingExtensions.has(ext)
  const cap = input.cap ?? CHAT_ATTACHMENT_AUDIO_MATERIALIZE_BYTES
  if (input.voice && input.size > cap) throw new ChatVoiceAttachmentTooLargeError(cap)
  const materialize = needsAudioProcessing && input.size <= cap && (input.voice || !nativeAudioExtensions.has(ext))
  return { needsAudioProcessing, materialize, transcode: materialize && !nativeAudioExtensions.has(ext) }
}

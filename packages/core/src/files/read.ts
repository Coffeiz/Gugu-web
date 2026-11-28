import { CoreError } from '../contracts/index.js'

export type FileThumbnailPlan =
  | { kind: 'raw'; mimeType: string }
  | { kind: 'resize'; mimeType: string; maxDimension: number; quality: number }

export function planAttachmentThumbnail(input: {
  kind: string | null
  ext: string
  mimeType: string
  qqFace: boolean
  size: string
}): FileThumbnailPlan | null {
  const ext = input.ext.toLowerCase()
  if (input.kind !== 'image') return null
  if (ext === 'svg') return { kind: 'raw', mimeType: 'image/svg+xml' }
  if (input.size === 'full' && (input.qqFace || ['gif', 'webp'].includes(ext)
    || ['image/gif', 'image/webp'].includes(input.mimeType.toLowerCase())))
    return { kind: 'raw', mimeType: input.mimeType || `image/${ext || 'gif'}` }
  const profile = input.size === 'tiny' ? [20, 80] : input.size === 'card' ? [768, 80] : [192, 82]
  return { kind: 'resize', mimeType: 'image/jpeg', maxDimension: profile[0]!, quality: profile[1]! }
}

const imageMimeTypes = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
  'image/svg+xml', 'image/heic', 'image/heif',
])
const genericImageMimeTypes = new Set(['', 'application/octet-stream', 'binary/octet-stream'])
const detectedFormatMimeTypes: Record<string, string> = {
  JPEG: 'image/jpeg', PNG: 'image/png', GIF: 'image/gif', WEBP: 'image/webp',
  AVIF: 'image/avif', BMP: 'image/bmp',
}

/** 依 Python 文件预览规则判断 MIME 和目标尺寸；图像编解码由 Host 的平台适配实现。 */
export function planFileThumbnail(
  declaredMimeType: string | null | undefined,
  detectedFormat: string | null,
  size: string,
): FileThumbnailPlan | null {
  let mimeType = (declaredMimeType ?? '').toLowerCase().trim()
  if (mimeType === 'image/jpg') mimeType = 'image/jpeg'
  if (genericImageMimeTypes.has(mimeType)) {
    mimeType = detectedFormat ? detectedFormatMimeTypes[detectedFormat.toUpperCase()] ?? '' : ''
  }
  if (!imageMimeTypes.has(mimeType)) return null
  if (size === 'full' || mimeType === 'image/svg+xml') return { kind: 'raw', mimeType }
  const profile = size === 'tiny' ? [20, 75] : size === 'card' ? [768, 92] : [192, 82]
  return { kind: 'resize', mimeType, maxDimension: profile[0]!, quality: profile[1]! }
}

/** 根与路径授权由 Host 完成；open 必须绑定可信根及安全文件打开实现。 */
export async function openAuthorizedRelativeFile<Handle>(
  relativePath: string,
  open: (relativePath: string) => Promise<{ handle: Handle; size: number } | null>,
  isUnsafePath: (error: unknown) => boolean,
) {
  if (relativePath.split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')))
    throw new CoreError('not_found', '文件不存在')
  try { return await open(relativePath) }
  catch (error) {
    if (isUnsafePath(error)) throw new CoreError('not_found', '文件不存在')
    throw error
  }
}

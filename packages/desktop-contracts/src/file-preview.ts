const IMAGE_EXTS  = new Set(['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'SVG', 'BMP'])
const TEXT_EXTS   = new Set([
  'TXT', 'MD', 'JSON', 'CSV', 'JS', 'MJS', 'CJS', 'JSX', 'TS', 'MTS', 'CTS', 'TSX', 'VUE', 'CSS', 'HTML', 'HTM', 'PY', 'YAML', 'YML', 'XML', 'SH',
  'LRC', 'SRT', 'ASS', 'SSA', 'VTT', 'SUB', 'SBV', 'SMI', 'TTML', 'DFXP', 'SCC',
  'CUE', 'M3U', 'M3U8', 'PLS',
])
const VIDEO_EXTS  = new Set(['MP4', 'WEBM', 'MOV', 'M4V', 'OGV'])
const OFFICE_EXTS = new Set(['DOC', 'DOCX', 'XLS', 'XLSX', 'PPT', 'PPTX'])
const AUDIO_EXTS  = new Set(['MP3', 'WAV', 'OGG', 'FLAC', 'M4A', 'AAC', 'OPUS'])
const PREVIEWABLE = new Set(['PDF', ...IMAGE_EXTS, ...TEXT_EXTS, ...VIDEO_EXTS, ...OFFICE_EXTS, ...AUDIO_EXTS])
const BINARY_EXTS = new Set([
  '7Z', 'APK', 'BIN', 'BLEND', 'BZ2', 'CLASS', 'DEB', 'DLL', 'DMG', 'DOC', 'DOCX', 'EXE', 'FLAC',
  'GIF', 'GZ', 'HEIC', 'ICO', 'ISO', 'JAR', 'JPEG', 'JPG', 'MKV', 'MP3', 'MP4', 'M4A', 'M4V',
  'MOV', 'OGG', 'PDF', 'PNG', 'PPT', 'PPTX', 'RAR', 'SO', 'TAR', 'WAV', 'WEBM', 'WEBP',
  'XLS', 'XLSX', 'XZ', 'ZIP',
])
const TEXT_MIME_PREFIXES = ['text/']
const TEXT_MIMES = new Set([
  'application/json', 'application/xml', 'application/javascript', 'application/typescript',
  'application/sql', 'application/x-sh', 'application/yaml', 'application/x-yaml',
])

export function isImageExt(ext?: string | null)  { return IMAGE_EXTS.has((ext ?? '').toUpperCase()) }
export function isSvgMime(mime?: string | null)  { return (mime ?? '').toLowerCase() === 'image/svg+xml' }
export function isTextMime(mime?: string | null) {
  const value = (mime ?? '').toLowerCase()
  return TEXT_MIME_PREFIXES.some(prefix => value.startsWith(prefix)) || TEXT_MIMES.has(value)
    || value.endsWith('+json') || value.endsWith('+xml')
}
function isMediaMime(mime?: string | null) {
  const value = (mime ?? '').toLowerCase()
  return value.startsWith('image/') || value.startsWith('video/') || value.startsWith('audio/')
}
export function isTextExt(ext?: string | null, mime?: string | null) {
  // 图片身份优先：image/svg+xml 以 +xml 结尾会被 MIME 启发式误判成文本，
  // 导致 SVG 预览走文本分支开窗（44%×86% 竖长窗）和文本下载路径。
  // ext 缺失时 MIME 本身也可能说明是图片（如聊天附件只带 image/svg+xml）。
  if (isImageExt(ext) || isSvgMime(mime)) return false
  if (TEXT_EXTS.has((ext ?? '').toUpperCase()) || isTextMime(mime)) return true
  // 无扩展名（.gitignore/.env 等点文件与裸文件名）且无媒体身份 → 默认按文本打开：
  // 这类文件几乎都是文本，MIME 常为空或 octet-stream；带媒体 MIME 的无 ext 附件
  // （聊天里的 image/* 等）仍走媒体分支，不落到文本。
  return !ext && !isMediaMime(mime)
}
/** 未知扩展名也允许尝试预览，最终是否为文本由下载内容探测决定。 */
export function isTextFallbackCandidate(ext?: string | null, mime?: string | null) {
  const normalizedExt = (ext ?? '').trim().replace(/^\./, '').toUpperCase()
  if (!normalizedExt || PREVIEWABLE.has(normalizedExt) || BINARY_EXTS.has(normalizedExt)) return false
  if (isImageExt(ext) || isSvgMime(mime) || isMediaMime(mime)) return false
  return !isTextMime(mime) // 已有文本 MIME 走常规文本预览
}

export function isVideoExt(ext?: string | null)  { return VIDEO_EXTS.has((ext ?? '').toUpperCase()) }
export function isOfficeExt(ext?: string | null) { return OFFICE_EXTS.has((ext ?? '').toUpperCase()) }
export function isCsvExt(ext?: string | null) { return (ext ?? '').toUpperCase() === 'CSV' }
export function isAudioExt(ext?: string | null)  { return AUDIO_EXTS.has((ext ?? '').toUpperCase()) }

export function isFloatingPreviewable(ext?: string | null, mime?: string | null) {
  return isOfficeExt(ext) || isImageExt(ext) || isSvgMime(mime) || isVideoExt(ext) || isTextExt(ext, mime)
}

export function isPreviewable(ext?: string | null, mime?: string | null) {
  return PREVIEWABLE.has((ext ?? '').toUpperCase()) || isTextMime(mime) || isTextExt(ext, mime)
    || isTextFallbackCandidate(ext, mime)
}

/** 文件库与桌面展示工具共用打开方式，预览器不支持的类型交给系统。 */
export function shouldOpenFileInSystem(preference: 'preview' | 'system' | undefined, ext?: string | null, mime?: string | null,
  options?: { audioPlayerAvailable: boolean }) {
  // 有迷你播放器的界面直接播放音乐；用户仍可从文件菜单显式使用系统应用。
  if (options?.audioPlayerAvailable && isAudioExt(ext)) return false
  return preference === 'system' || !isFloatingPreviewable(ext, mime)
}

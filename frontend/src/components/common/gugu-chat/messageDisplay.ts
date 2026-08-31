import { isPreviewable } from '@/stores/preview'
import { i18n } from '@/i18n'
import type { ChatFile } from './chatTypes'

// 图片附件缩略图（与文件库共用 useThumbCache）
export const IMG_EXTS = new Set(['jpg','jpeg','png','gif','webp','avif','bmp','svg','heic','heif'])

// 缩略图来源优先级：本地 _thumbUrl（刚发的，即时）> file_id（已落库，服务端图）
// > attach_id（刷新后历史里的暂存图，走 /agent/attachment 端点，6h 内有效）；都没有则 ext 角标
export function isImageFile(f: ChatFile) {
  if (f._thumbUrl) return true
  const isImg = IMG_EXTS.has((f.ext || '').toLowerCase())
  return isImg && (!!f.file_id || !!f.attach_id)
}

export function isAnimatedImageFile(f: ChatFile) {
  const mime = (f.mime || '').toLowerCase()
  return (['gif', 'webp'].includes((f.ext || '').toLowerCase()) || mime === 'image/gif' || mime === 'image/webp')
    && (!!f.file_id || !!f.attach_id)
}

export function canPreview(f: ChatFile) {
  return (!!f.file_id || !!f.attach_id) && isPreviewable(f.ext)
}

export function fmtSize(b?: number) {
  if (!b) return ''
  if (b < 1024) return b + ' B'
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1048576).toFixed(1) + ' MB'
}

const _WAVE = [50, 80, 38, 95, 60, 72, 44, 88, 56, 68, 42, 84, 52]   // 装饰性波形高度
export function voiceBar(n: number) { return _WAVE[(n - 1) % _WAVE.length] + '%' }

export function fmtDur(sec?: number) {
  const s = Math.round(sec || 0)
  if (!s) return i18n.global.t('chatUi.voice')
  return s < 60 ? s + '″' : Math.floor(s / 60) + "'" + String(s % 60).padStart(2, '0')
}

// 兼容历史消息：旧记录可能还保存着 QQ 的内部表情协议串。
export function displayQQFaces(text: string): string {
  if (!text || !text.includes('<faceType=')) return text || ''
  return text.replace(
    /<faceType=[^,>]+,faceId="[^"]*",ext="([^"]*)">/g,
    (_match, encoded: string) => {
      if (encoded) {
        try {
          const padded = encoded + '='.repeat((4 - encoded.length % 4) % 4)
          const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0))
          const payload = JSON.parse(new TextDecoder().decode(bytes))
          if (typeof payload.text === 'string' && payload.text.trim()) return payload.text
        } catch { /* 历史协议串不完整时显示统一占位 */ }
      }
      return i18n.global.t('chatUi.qqFace')
    },
  )
}

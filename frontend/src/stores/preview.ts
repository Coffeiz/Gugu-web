import { defineStore } from 'pinia'
import { ref } from 'vue'
import { nextZ } from '@/composables/windowz'
import type { FileMeta } from '@/stores/filesCache'

// 预览窗口也承载聊天附件等非库文件，故用 Partial<FileMeta>（只需 id/ext，其余按需）
type PreviewFile = Partial<FileMeta>

export interface PreviewWindow {
  id: number
  file: PreviewFile
  siblings: PreviewFile[]
  x: number; y: number; w: number; h: number
  zIndex: number
  _idx: number
}

const IMAGE_EXTS  = new Set(['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'SVG', 'BMP'])
const TEXT_EXTS   = new Set(['TXT', 'MD', 'JSON', 'CSV', 'JS', 'TS', 'CSS', 'HTML', 'PY', 'YAML', 'XML', 'SH'])
const VIDEO_EXTS  = new Set(['MP4', 'WEBM', 'MOV', 'M4V', 'OGV'])
const OFFICE_EXTS = new Set(['DOC', 'DOCX', 'XLS', 'XLSX', 'PPT', 'PPTX'])
const AUDIO_EXTS  = new Set(['MP3', 'WAV', 'OGG', 'FLAC', 'M4A', 'AAC', 'OPUS'])
const PREVIEWABLE = new Set(['PDF', ...IMAGE_EXTS, ...TEXT_EXTS, ...VIDEO_EXTS, ...OFFICE_EXTS, ...AUDIO_EXTS])

export function isImageExt(ext?: string | null)  { return IMAGE_EXTS.has((ext ?? '').toUpperCase()) }
export function isTextExt(ext?: string | null)   { return TEXT_EXTS.has((ext ?? '').toUpperCase()) }
export function isVideoExt(ext?: string | null)  { return VIDEO_EXTS.has((ext ?? '').toUpperCase()) }
export function isOfficeExt(ext?: string | null) { return OFFICE_EXTS.has((ext ?? '').toUpperCase()) }
export function isAudioExt(ext?: string | null)  { return AUDIO_EXTS.has((ext ?? '').toUpperCase()) }

export function isPreviewable(ext?: string | null) {
  return PREVIEWABLE.has((ext ?? '').toUpperCase())
}

export const usePreviewStore = defineStore('preview', () => {
  // 图片 / 视频 → 浮动窗口列表
  const windows    = ref<PreviewWindow[]>([])
  // 其余类型（PDF、文本、音频）→ 原侧边 modal
  const singleFile = ref<PreviewFile | null>(null)

  let _nextId = 1
  // z 统一走 windowz.nextZ()（窗口带 20000+，点谁谁上；见 composables/windowz.ts）

  // siblings：调用方传同目录下的完整文件列表（可选），供图片预览左右切换用；
  // 只在图片间导航，siblings 里混着非图片文件会被 navigate() 自动跳过。
  function open(f: PreviewFile, siblings: PreviewFile[] | null = null) {
    if (isImageExt(f.ext) || isVideoExt(f.ext) || isTextExt(f.ext)) {
      const existing = windows.value.find(w => w.file.id === f.id)
      if (existing) { bringToFront(existing.id); return }
      const idx = windows.value.length
      const PW = 320, PH = 200
      windows.value.push({
        id:       _nextId++,
        file:     f,
        siblings: siblings || [],
        x:      Math.round((window.innerWidth  - PW) / 2) + idx * 30,
        y:      Math.round((window.innerHeight - PH) / 2) + idx * 30,
        w:      PW,
        h:      PH,
        zIndex: nextZ(),
        _idx:   idx,
      })
    } else {
      singleFile.value = f
    }
  }

  // 图片预览左右切换：在 win.siblings 里过滤出图片、按当前文件定位、按 dir(±1) 移动，
  // 到边界后循环（体验上更顺手，跟大多数看图软件一致）。siblings 不足 2 张图时静默不动。
  function navigate(id: number, dir: number) {
    const w = windows.value.find(w => w.id === id)
    if (!w || !w.siblings?.length) return
    const imgs = w.siblings.filter(f => isImageExt(f.ext))
    const curIdx = imgs.findIndex(f => f.id === w.file.id)
    if (curIdx === -1 || imgs.length < 2) return
    w.file = imgs[(curIdx + dir + imgs.length) % imgs.length]
  }

  function closeWindow(id: number) {
    windows.value = windows.value.filter(w => w.id !== id)
  }

  function bringToFront(id: number) {
    const w = windows.value.find(w => w.id === id)
    if (w) w.zIndex = nextZ()
  }

  // 兼容旧调用 previewStore.file / previewStore.close()
  const file  = singleFile
  function close() { singleFile.value = null }

  return { windows, singleFile, file, open, close, closeWindow, bringToFront, navigate }
})

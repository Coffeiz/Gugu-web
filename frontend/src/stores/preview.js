import { defineStore } from 'pinia'
import { ref } from 'vue'

const IMAGE_EXTS  = new Set(['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'SVG', 'BMP'])
const TEXT_EXTS   = new Set(['TXT', 'MD', 'JSON', 'CSV', 'JS', 'TS', 'CSS', 'HTML', 'PY', 'YAML', 'XML', 'SH'])
const VIDEO_EXTS  = new Set(['MP4', 'WEBM', 'MOV', 'M4V', 'OGV'])
const OFFICE_EXTS = new Set(['DOC', 'DOCX', 'XLS', 'XLSX', 'PPT', 'PPTX'])
const AUDIO_EXTS  = new Set(['MP3', 'WAV', 'OGG', 'FLAC', 'M4A', 'AAC', 'OPUS'])
const PREVIEWABLE = new Set(['PDF', ...IMAGE_EXTS, ...TEXT_EXTS, ...VIDEO_EXTS, ...OFFICE_EXTS, ...AUDIO_EXTS])

export function isImageExt(ext)  { return IMAGE_EXTS.has(ext?.toUpperCase()) }
export function isTextExt(ext)   { return TEXT_EXTS.has(ext?.toUpperCase()) }
export function isVideoExt(ext)  { return VIDEO_EXTS.has(ext?.toUpperCase()) }
export function isOfficeExt(ext) { return OFFICE_EXTS.has(ext?.toUpperCase()) }
export function isAudioExt(ext)  { return AUDIO_EXTS.has(ext?.toUpperCase()) }

export function isPreviewable(ext) {
  return PREVIEWABLE.has(ext?.toUpperCase())
}

export const usePreviewStore = defineStore('preview', () => {
  // 图片 / 视频 → 浮动窗口列表
  const windows    = ref([])
  // 其余类型（PDF、文本、音频）→ 原侧边 modal
  const singleFile = ref(null)

  let _nextId = 1
  let _topZ   = 11000   // 高于 GuguChat 窗口（10001/10002），从聊天打开的预览要盖在上面

  function open(f) {
    if (isImageExt(f.ext) || isVideoExt(f.ext) || isTextExt(f.ext)) {
      const existing = windows.value.find(w => w.file.id === f.id)
      if (existing) { bringToFront(existing.id); return }
      const idx = windows.value.length
      const PW = 320, PH = 200
      windows.value.push({
        id:     _nextId++,
        file:   f,
        x:      Math.round((window.innerWidth  - PW) / 2) + idx * 30,
        y:      Math.round((window.innerHeight - PH) / 2) + idx * 30,
        w:      PW,
        h:      PH,
        zIndex: ++_topZ,
        _idx:   idx,
      })
    } else {
      singleFile.value = f
    }
  }

  function closeWindow(id) {
    windows.value = windows.value.filter(w => w.id !== id)
  }

  function bringToFront(id) {
    const w = windows.value.find(w => w.id === id)
    if (w) w.zIndex = ++_topZ
  }

  // 兼容旧调用 previewStore.file / previewStore.close()
  const file  = singleFile
  function close() { singleFile.value = null }

  return { windows, singleFile, file, open, close, closeWindow, bringToFront }
})

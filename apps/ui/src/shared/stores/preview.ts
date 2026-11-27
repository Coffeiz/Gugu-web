import { isAudioExt, isFloatingPreviewable, isImageExt, isOfficeExt, isSvgMime, isTextFallbackCandidate } from '@gugu/desktop-contracts/file-preview'
export { isAudioExt, isCsvExt, isFloatingPreviewable, isImageExt, isOfficeExt, isPreviewable, isSvgMime, isTextExt, isTextFallbackCandidate, isTextMime, isVideoExt } from '@gugu/desktop-contracts/file-preview'
import { defineStore } from 'pinia'
import { inject, ref, type InjectionKey } from 'vue'
import { nextZ } from '@/composables/core/windowz'
import type { FileMeta } from '@/stores/filesCache'
import { useAudioStore } from '@/stores/audio'
import type { LiveEventPayload } from '@/types/live-events'
import type { PathFileRef } from '@/services/api'

// 预览窗口也承载聊天附件等非库文件，故用 Partial<FileMeta>（只需 filePath/ext，其余按需）
export type PreviewFile = Partial<FileMeta> & { virtualKey?: string; workspaceFile?: PathFileRef; chatLibraryPath?: string; readContent?: () => Promise<Blob>; contentUrl?: string }

export const openPlatformPreviewKey: InjectionKey<(file: PreviewFile) => boolean> = Symbol()

function samePreviewFile(left: PreviewFile, right: PreviewFile): boolean {
  if (left.workspaceFile || right.workspaceFile)
    return left.workspaceFile?.directoryId === right.workspaceFile?.directoryId
      && left.workspaceFile?.relativePath === right.workspaceFile?.relativePath
  if (left.attach_id || right.attach_id) return left.attach_id === right.attach_id
  return left.filePath === right.filePath && left.virtualKey === right.virtualKey
}

export interface PreviewWindow {
  id: number
  file: PreviewFile
  /** 聊天文件链接预取的短时效地址，仅用于首次加载。 */
  streamUrl?: string
  /** 聊天气泡等要求读取最新内容的入口递增此值，通知现有窗口绕过 blob 缓存重载。 */
  reloadToken: number
  /** 未知扩展名：下载后再按内容判定是否进入文本查看器。 */
  textFallback?: boolean
  siblings: PreviewFile[]
  x: number; y: number; w: number; h: number
  zIndex: number
  _idx: number
  sourceText?: string
  saveSource?: (content: string) => Promise<void> | void
}

/** 首次挂载的强刷标记仅消费一次；之后只有计数发生变化才代表新的强刷请求。 */
export function isPreviewReloadRequested(currentToken: number, previousToken?: number): boolean {
  return previousToken === undefined ? currentToken > 0 : currentToken !== previousToken
}

/** 仅当实时文件事件明确指向当前文件时，才刷新已打开的预览。 */
export function isPreviewAffectedByFileEvent(
  filePath: string | null | undefined,
  event: LiveEventPayload | null | undefined,
): boolean {
  if (!filePath || event?.resource !== 'files') return false
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload as { kind?: unknown }
    : null
  if (payload?.kind === 'folder') return false

  const paths = [event.entity_id, ...(event.entity_ids ?? [])]
  return paths.some(value => typeof value === 'string' && value === filePath)
}

/** 检查文本预览器实际会显示的内容；支持 UTF-8 与带 BOM 的 UTF-16。 */
export async function normalizeTextBlob(blob: Blob): Promise<Blob | null> {
  let bytes = new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer())
  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk' = 'utf-8'
  let offset = 0
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2 }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2 }
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3
  if ((encoding === 'utf-16le' || encoding === 'utf-16be') && bytes.length % 2) bytes = bytes.subarray(0, bytes.length - 1)
  const sampleIsComplete = blob.size <= bytes.length
  const decodeSample = (label: string) => {
    const decoder = new TextDecoder(label, { fatal: true })
    const sample = decoder.decode(bytes.subarray(offset), { stream: !sampleIsComplete })
    return sampleIsComplete ? sample + decoder.decode() : sample
  }

  try {
    let text: string
    if (encoding === 'utf-8' && !offset) {
      try {
        text = decodeSample('utf-8')
      } catch {
        encoding = 'gbk'
        text = decodeSample('gbk')
      }
    } else {
      text = decodeSample(encoding)
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) return null
    if (encoding === 'gbk' && !/[\u3400-\u9fff]/u.test(text)) return null
    if (encoding !== 'utf-8' || offset > 0) {
      const fullBytes = new Uint8Array(await blob.arrayBuffer())
      const fullText = new TextDecoder(encoding, { fatal: true }).decode(fullBytes.subarray(offset))
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(fullText)) return null
      return new Blob([fullText], { type: 'text/plain;charset=utf-8' })
    }
    return blob
  } catch {
    return null
  }
}


export const usePreviewStore = defineStore('preview', () => {
  const openPlatformPreview = inject(openPlatformPreviewKey, null)
  // 图片 / 视频 → 浮动窗口列表
  const windows    = ref<PreviewWindow[]>([])
  // PDF 等抽屉预览文件
  const singleFile = ref<PreviewFile | null>(null)

  let _nextId = 1
  // z 统一走 windowz.nextZ()（窗口带 20000+，点谁谁上；见 composables/core/windowz.ts）

  // 同目录文件列表供预览导航和音频播放列表使用，各自筛选支持的类型。
  function open(f: PreviewFile, siblings: PreviewFile[] | null = null, forceRefresh = false, streamUrl?: string) {
    if (isAudioExt(f.ext) && (f.workspaceFile || f.filePath)) {
      void useAudioStore().play(f, siblings ?? [])
      return
    }
    if (openPlatformPreview?.(f)) return

    // Office（前端 HTML 渲染）与图片/视频/文本一样走浮动窗口；抽屉留给 PDF。
    if (isOfficeExt(f.ext)) {
      const existing = windows.value.find(w => samePreviewFile(w.file, f))
      if (existing) {
        existing.file = f
        if (streamUrl) existing.streamUrl = streamUrl
        existing.siblings = siblings || []
        if (forceRefresh || streamUrl) existing.reloadToken++
        bringToFront(existing.id)
        return
      }
      const idx = windows.value.length
      const PW = Math.min(860, Math.round(window.innerWidth * 0.6))
      const PH = Math.min(680, Math.round(window.innerHeight * 0.72))
      windows.value.push({
        id:       _nextId++,
        file:     f,
        streamUrl,
        reloadToken: forceRefresh ? 1 : 0,
        siblings: siblings || [],
        x:      Math.round((window.innerWidth  - PW) / 2) + idx * 30,
        y:      Math.round((window.innerHeight - PH) / 2) + idx * 30,
        w:      PW,
        h:      PH,
        zIndex: nextZ(),
        _idx:   idx,
      })
      return
    }
    if (isFloatingPreviewable(f.ext, f.mimeType) || isTextFallbackCandidate(f.ext, f.mimeType)) {
      const existing = windows.value.find(w => samePreviewFile(w.file, f))
      if (existing) {
        existing.file = f
        if (streamUrl) existing.streamUrl = streamUrl
        existing.textFallback = isTextFallbackCandidate(f.ext, f.mimeType)
        existing.siblings = siblings || []
        if (forceRefresh || streamUrl) existing.reloadToken++
        bringToFront(existing.id)
        return
      }
      const idx = windows.value.length
      const PW = 320, PH = 200
      windows.value.push({
        id:       _nextId++,
        file:     f,
        streamUrl,
        textFallback: isTextFallbackCandidate(f.ext, f.mimeType),
        reloadToken: forceRefresh ? 1 : 0,
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

  function openVirtual(
    f: PreviewFile,
    sourceText: string,
    saveSource: (content: string) => Promise<void> | void,
  ) {
    const key = f.filePath ?? f.virtualKey
    const existing = windows.value.find(w => (w.file.filePath ?? w.file.virtualKey) === key)
    if (existing) {
      existing.sourceText = sourceText
      existing.saveSource = saveSource
      bringToFront(existing.id)
      return
    }
    const idx = windows.value.length
    windows.value.push({
      id: _nextId++, file: f, reloadToken: 0, siblings: [], sourceText, saveSource,
      x: Math.round((window.innerWidth - 520) / 2) + idx * 30,
      y: Math.round((window.innerHeight - 620) / 2) + idx * 30,
      w: 520, h: 620, zIndex: nextZ(), _idx: idx,
    })
  }

  // 图片预览左右切换：在 win.siblings 里过滤出图片、按当前文件定位、按 dir(±1) 移动，
  // 到边界后循环（体验上更顺手，跟大多数看图软件一致）。siblings 不足 2 张图时静默不动。
  function navigate(id: number, dir: number) {
    const w = windows.value.find(w => w.id === id)
    if (!w || !w.siblings?.length) return
    const imgs = w.siblings.filter(f => isImageExt(f.ext) || isSvgMime(f.mimeType))
    const current = w.file.filePath ?? w.file.virtualKey
    const curIdx = imgs.findIndex(f => (f.filePath ?? f.virtualKey) === current)
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
  function close() {
    singleFile.value = null
  }

  function resetAccountState() {
    windows.value = []
    close()
    _nextId = 1
  }

  return { windows, singleFile, file, open, openVirtual, close, closeWindow, bringToFront, navigate, resetAccountState }
})

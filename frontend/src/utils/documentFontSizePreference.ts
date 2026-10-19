const DOCUMENT_FONT_SIZE_KEY = 'gugu-document-font-size'
const MIN_DOCUMENT_FONT_SIZE = 10
const MAX_DOCUMENT_FONT_SIZE = 24
const DEFAULT_DOCUMENT_FONT_SIZE = 13

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function clampDocumentFontSize(value: number): number {
  return Math.max(MIN_DOCUMENT_FONT_SIZE, Math.min(MAX_DOCUMENT_FONT_SIZE, Math.round(value)))
}

export function readDocumentFontSize(storage = browserStorage()): number {
  try {
    const value = Number(storage?.getItem(DOCUMENT_FONT_SIZE_KEY))
    if (!Number.isInteger(value) || value < MIN_DOCUMENT_FONT_SIZE || value > MAX_DOCUMENT_FONT_SIZE) {
      return DEFAULT_DOCUMENT_FONT_SIZE
    }
    return value
  } catch {
    return DEFAULT_DOCUMENT_FONT_SIZE
  }
}

export function saveDocumentFontSize(value: number, storage = browserStorage()): number {
  const fontSize = clampDocumentFontSize(value)
  try {
    storage?.setItem(DOCUMENT_FONT_SIZE_KEY, String(fontSize))
  } catch {
    // 偏好存储不可用时，仍允许本次预览调整字号。
  }
  return fontSize
}

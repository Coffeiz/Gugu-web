const SPREADSHEET_ZOOM_KEY = 'gugu-spreadsheet-zoom'
const MIN_SPREADSHEET_ZOOM = 25
const MAX_SPREADSHEET_ZOOM = 300

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function clampSpreadsheetZoom(value: number): number {
  return Math.max(MIN_SPREADSHEET_ZOOM, Math.min(MAX_SPREADSHEET_ZOOM, Math.round(value)))
}

export function readSpreadsheetZoom(storage = browserStorage()): number {
  try {
    const value = Number(storage?.getItem(SPREADSHEET_ZOOM_KEY))
    if (!Number.isInteger(value) || value < MIN_SPREADSHEET_ZOOM || value > MAX_SPREADSHEET_ZOOM) return 100
    return value
  } catch {
    return 100
  }
}

export function saveSpreadsheetZoom(value: number, storage = browserStorage()): number {
  const zoom = clampSpreadsheetZoom(value)
  try {
    storage?.setItem(SPREADSHEET_ZOOM_KEY, String(zoom))
  } catch {
    // 偏好存储不可用时，仍允许本次预览调整缩放。
  }
  return zoom
}

import { afterEach, describe, expect, it } from 'vitest'
import { clampSpreadsheetZoom, readSpreadsheetZoom, saveSpreadsheetZoom } from '@/utils/spreadsheetZoomPreference'

const ZOOM_KEY = 'gugu-spreadsheet-zoom'

afterEach(() => localStorage.clear())

describe('spreadsheet zoom preference', () => {
  it('defaults to 100% and restores the same zoom for spreadsheet previews', () => {
    expect(readSpreadsheetZoom()).toBe(100)
    expect(saveSpreadsheetZoom(140)).toBe(140)
    expect(localStorage.getItem(ZOOM_KEY)).toBe('140')
    expect(readSpreadsheetZoom()).toBe(140)
  })

  it('persists reset-to-default and clamps zoom to the supported range', () => {
    expect(saveSpreadsheetZoom(310)).toBe(300)
    expect(readSpreadsheetZoom()).toBe(300)
    expect(saveSpreadsheetZoom(100)).toBe(100)
    expect(readSpreadsheetZoom()).toBe(100)
    expect(clampSpreadsheetZoom(20)).toBe(25)
  })

  it('ignores malformed or out-of-range stored values', () => {
    localStorage.setItem(ZOOM_KEY, 'NaN')
    expect(readSpreadsheetZoom()).toBe(100)
    localStorage.setItem(ZOOM_KEY, '301')
    expect(readSpreadsheetZoom()).toBe(100)
  })

  it('continues to work in memory if browser storage is unavailable', () => {
    const unavailableStorage = {
      getItem: () => { throw new Error('storage blocked') },
      setItem: () => { throw new Error('storage blocked') },
    }
    expect(readSpreadsheetZoom(unavailableStorage)).toBe(100)
    expect(saveSpreadsheetZoom(130, unavailableStorage)).toBe(130)
  })
})

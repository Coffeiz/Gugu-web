import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runClientVersionGate } from '@/utils/clientVersionGate'

const retainedPreferences = [
  ['gugu-calendar-view-mode', 'week'],
  ['gugu-spreadsheet-zoom', '140'],
  ['gugu-docx-view-mode', 'fit-width'],
  ['gugu-document-font-size', 'large'],
] as const

describe('client version gate', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.stubGlobal('__APP_VERSION__', 'new-build')
  })

  afterEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.unstubAllGlobals()
  })

  it('keeps persistent viewer and calendar preferences when the frontend build changes', () => {
    localStorage.setItem('app_version', 'old-build')
    for (const [key, value] of retainedPreferences) localStorage.setItem(key, value)
    localStorage.setItem('obsolete-transient-state', 'discard-me')
    localStorage.setItem('user_token', 'legacy-token')
    sessionStorage.setItem('temporary-state', 'discard-me')

    runClientVersionGate()

    for (const [key, value] of retainedPreferences) expect(localStorage.getItem(key)).toBe(value)
    expect(localStorage.getItem('app_version')).toBe('new-build')
    expect(localStorage.getItem('obsolete-transient-state')).toBeNull()
    expect(localStorage.getItem('user_token')).toBeNull()
    expect(sessionStorage.length).toBe(0)
  })
})

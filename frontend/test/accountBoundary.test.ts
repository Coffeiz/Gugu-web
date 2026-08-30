import { beforeEach, describe, expect, it } from 'vitest'
import { beginAccountBoundary, getAccountBoundaryEpoch } from '@/utils/accountBoundary'

describe('账号切换边界', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('登录新账号前清理旧账号的会话、媒体和导航状态', () => {
    const keys = [
      'gugu_audio_file', 'gugu_last_bubble_id', 'gugu_reopen_resume',
      'gugu_session_id', 'gugu_last_session_id', 'files_nav_path', 'mind-last-canvas-id',
    ]
    keys.forEach(key => {
      localStorage.setItem(key, 'old-account')
      sessionStorage.setItem(key, 'old-account')
    })
    const previousEpoch = getAccountBoundaryEpoch()

    beginAccountBoundary()

    expect(getAccountBoundaryEpoch()).toBe(previousEpoch + 1)
    keys.forEach(key => {
      expect(localStorage.getItem(key)).toBeNull()
      expect(sessionStorage.getItem(key)).toBeNull()
    })
  })
})

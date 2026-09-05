import { describe, expect, it } from 'vitest'
import { iconRegistry, resolveIcon } from '@/components/common/icons/iconRegistry'

describe('图标语义注册表', () => {
  it('保留首批跨页面通用语义映射', () => {
    expect(Object.keys(iconRegistry)).toEqual(expect.arrayContaining([
      'action.add',
      'action.close',
      'action.search',
      'action.upload',
      'admin.shield',
      'file.folder',
      'project.month-folder',
      'status.success',
    ]))
  })

  it('固定播放器使用实心图标，未固定状态保留线框图标', () => {
    expect(iconRegistry['canvas.pin']).not.toBe(iconRegistry['canvas.pin-off'])
  })

  it('未注册语义直接报错，避免静默显示错误图标', () => {
    expect(() => resolveIcon('not-registered')).toThrow('未注册图标语义')
  })
})

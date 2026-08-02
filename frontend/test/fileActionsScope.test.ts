import { describe, expect, it } from 'vitest'
import { fileActionScopeError } from '@/composables/files/useFileActions'

describe('fileActionScopeError', () => {
  it('项目场景拒绝跨项目目标', () => {
    expect(fileActionScopeError({ scope: 'project', projectId: 7 }, 8)).toBe('项目文件操作不能跨项目')
    expect(fileActionScopeError({ scope: 'project', projectId: 7 }, 7)).toBeNull()
  })

  it('个人文件场景默认允许跨项目目标', () => {
    expect(fileActionScopeError({ scope: 'personal' }, 8)).toBeNull()
  })

  it('回收站场景默认拒绝普通写操作', () => {
    expect(fileActionScopeError({ scope: 'trash' }, null)).toBe('回收站不允许执行此文件操作')
    expect(fileActionScopeError({ scope: 'trash', allowTrashActions: true }, null)).toBeNull()
  })
})

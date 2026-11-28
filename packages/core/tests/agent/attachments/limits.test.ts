import { describe, expect, it } from 'vitest'
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_LABEL } from '../../../src/agent/attachments/limits.js'

describe('附件统一上限', () => {
  it('单文件上限为 100 MB，且展示文案与数值一致', () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(100 * 1024 * 1024)
    expect(ATTACHMENT_MAX_LABEL).toBe('100 MB')
  })

  it('上限是整数字节且可安全参与 Number 比较', () => {
    expect(Number.isSafeInteger(ATTACHMENT_MAX_BYTES)).toBe(true)
    expect(ATTACHMENT_MAX_BYTES).toBe(104857600)
  })
})

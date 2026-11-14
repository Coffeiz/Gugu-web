// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyTextToClipboard } from '@/components/common/gugu-chat/composables/copyTextToClipboard'

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')

function restoreProperty(target: object, key: string, descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(target, key, descriptor)
  else Reflect.deleteProperty(target, key)
}

afterEach(() => {
  restoreProperty(navigator, 'clipboard', originalClipboard)
  restoreProperty(document, 'execCommand', originalExecCommand)
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('copyTextToClipboard', () => {
  it('Clipboard API 写入成功时返回成功且不执行回退', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    await expect(copyTextToClipboard('要复制的文本')).resolves.toBe(true)

    expect(writeText).toHaveBeenCalledWith('要复制的文本')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('Clipboard API 拒绝后执行命令回退，并尊重回退失败结果', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) },
    })
    const execCommand = vi.fn(() => false)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    await expect(copyTextToClipboard('要复制的文本')).resolves.toBe(false)

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('没有 Clipboard API 时仅在 execCommand 确认成功后返回成功', async () => {
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    await expect(copyTextToClipboard('备用文本')).resolves.toBe(true)

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('命令回退抛错时返回失败并清理临时输入框', async () => {
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => { throw new Error('copy unavailable') }),
    })

    await expect(copyTextToClipboard('备用文本')).resolves.toBe(false)

    expect(document.querySelector('textarea')).toBeNull()
  })
})

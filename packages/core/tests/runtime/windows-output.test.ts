import { expect, it, vi } from 'vitest'
vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => 'OEMCP    REG_SZ    936') }))
import { decodeWindowsOutput } from '../../../sandbox/src/windows/output.js'
it('保留 UTF-8，按 OEM936 解码无控制台命令的中文', () => {
  expect(decodeWindowsOutput(Buffer.from('中文验证'))).toBe('中文验证')
  expect(decodeWindowsOutput(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe('中文')
})

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDesktopPreviewEncryption, desktopPreviewDataDirectory } from '../src/main/preview-directory.js'

it('同一检出目录的并行预览按端口隔离 Core 数据库，并在同一端口重启时复用数据目录', () => {
  const first = desktopPreviewDataDirectory('/synthetic/gugu', '/synthetic/home', 5176)
  const second = desktopPreviewDataDirectory('/synthetic/gugu', '/synthetic/home', 5177)

  expect(first).not.toBe(second)
  expect(desktopPreviewDataDirectory('/synthetic/gugu', '/synthetic/home', 5176)).toBe(first)
})

it('拒绝无效端口，避免不同预览实例意外共用默认目录', () => {
  expect(() => desktopPreviewDataDirectory('/synthetic/gugu', '/synthetic/home', 0)).toThrow(RangeError)
  expect(() => desktopPreviewDataDirectory('/synthetic/gugu', '/synthetic/home', 65536)).toThrow(RangeError)
})

it('同一预览目录重建服务后能读取之前保存的加密凭据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-preview-test-'))
  try {
    const first = createDesktopPreviewEncryption(directory)
    const encrypted = await first.encryptStringAsync('合成模型凭据')
    const restarted = createDesktopPreviewEncryption(directory)
    await expect(restarted.decryptStringAsync(encrypted)).resolves.toMatchObject({ result: '合成模型凭据' })
    if (process.platform !== 'win32') {
      expect((await stat(join(directory, 'preview.key'))).mode & 0o777).toBe(0o600)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

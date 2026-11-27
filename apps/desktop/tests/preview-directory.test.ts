import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDesktopPreviewEncryption, desktopPreviewDataDirectory } from '../src/main/preview-directory.js'

it('预览复用检出目录的原库，存在旧默认端口库时也保留其数据', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gugu-preview-test-'))
  try {
    const checkout = '/synthetic/gugu'
    const directory = desktopPreviewDataDirectory(checkout, home)
    const previousDefault = join(directory, '5176')
    await mkdir(previousDefault, { recursive: true })
    await writeFile(join(previousDefault, 'core.db'), '')
    expect(desktopPreviewDataDirectory(checkout, home)).toBe(previousDefault)
    await writeFile(join(directory, 'core.db'), '')
    expect(desktopPreviewDataDirectory(checkout, home)).toBe(directory)
    expect(desktopPreviewDataDirectory('/synthetic/another', home)).not.toBe(directory)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
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

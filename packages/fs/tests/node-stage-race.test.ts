import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, skipIf, vi } from 'vitest'

const root = await mkdtemp(path.join(tmpdir(), 'gugu-fs-stage-race-'))
const swaps: Array<() => Promise<void>> = []
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async link(source: string, destination: string) {
      await swaps.shift()?.()
      return actual.link(source, destination)
    },
  }
})

const { stageLocalFile } = await import('../src/node.js')
afterEach(async () => { swaps.length = 0; await rm(root, { recursive: true, force: true }) })

it.skipIf(process.platform !== 'linux')('暂存期间 owner 目录被替换为符号链接时，不改动链接目标', async () => {
  const owner = path.join(root, 'owner')
  const detached = path.join(root, 'detached-owner')
  const outside = await mkdtemp(path.join(tmpdir(), 'gugu-fs-stage-outside-'))
  const id = '00000000-0000-4000-8000-000000000001'
  try {
    await mkdir(owner)
    await writeFile(path.join(owner, 'file'), 'owner data')
    await writeFile(path.join(outside, 'file'), 'outside data')
    swaps.push(async () => {
      await rename(owner, detached)
      await symlink(outside, owner)
    })

    await stageLocalFile(root, 'owner/file', id)

    expect(await readFile(path.join(outside, 'file'), 'utf8')).toBe('outside data')
    await expect(readFile(path.join(outside, `file.gugu-purge-${id}`))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

import { randomBytes } from 'node:crypto'
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 在同一目录原子发布新密钥，并发创建时只使用最终发布的密钥。 */
export function desktopKeyFile(path: string, invalidMessage: string) {
  async function read() {
    const key = await readFile(path)
    if (key.length !== 32) throw new Error(invalidMessage)
    return key
  }
  async function readOrCreate(beforeCreate?: () => Promise<void>) {
    try { return await read() } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await beforeCreate?.()
    const folder = await mkdtemp(join(dirname(path), '.gugu-key-'))
    try {
      const staged = join(folder, 'key')
      await writeFile(staged, randomBytes(32), { flag: 'wx', mode: 0o600 })
      try { await link(staged, path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      return await read()
    } finally { await rm(folder, { recursive: true, force: true }) }
  }
  return { read, readOrCreate }
}

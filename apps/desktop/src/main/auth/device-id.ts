import { randomUUID } from 'node:crypto'
import { link, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deviceIdSchema } from '@gugu/auth/contracts'

/** 在现有 Desktop 数据目录中保存安装级标识，供登录和同步复用。 */
export async function getDesktopDeviceId(dataDirectory: string): Promise<string> {
  const path = join(dataDirectory, 'device-id')
  const read = async () => deviceIdSchema.parse((await readFile(path, 'utf8')).trim())
  try {
    return await read()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const id = randomUUID()
  const temporary = path + '.' + id
  await writeFile(temporary, id + '\n', { flag: 'wx', mode: 0o600 })
  try {
    // 原子发布且不覆盖并发调用已写入的 ID。
    await link(temporary, path)
    return id
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return await read()
    throw error
  } finally {
    await unlink(temporary)
  }
}

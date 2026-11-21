import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { UnsafeLocalPathError } from '@gugu/fs/node'

/** 知识只写入桌面私有数据目录，使用同目录临时文件原子发布。 */
export async function publishDesktopKnowledgeFile(root: string, key: string, content: string | Uint8Array) {
  if (!/^[0-9a-f-]{36}\/\.agent\/knowledge\/(?:\.timestamps-iso-v1|entries\/[A-Za-z0-9_-]{1,128}\.md)$/u.test(key))
    throw new UnsafeLocalPathError()
  const segments = key.split('/')
  const name = segments.pop()!
  let directory = await realpath(root)
  for (const segment of segments) {
    directory = join(directory, segment)
    await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new UnsafeLocalPathError()
  }
  const temp = join(directory, `.${randomUUID()}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally { await handle.close() }
    await rename(temp, join(directory, name))
  } finally {
    await unlink(temp).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

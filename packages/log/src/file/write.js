import { appendFileSync, closeSync, constants, openSync, mkdirSync, readdirSync, renameSync, lstatSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const archiveName = /^\d{13}-[a-f0-9-]{36}$/
let lastRotationAt = 0
const historyName = /^\d{13}-[a-f0-9]{64}$/

export function isLogArchive(path, name) {
  const base = basename(path)
  return (name.startsWith(`${base}.rotate-`) && archiveName.test(name.slice(base.length + 8)))
    || (name.startsWith(`${base}.history-`) && historyName.test(name.slice(base.length + 9)))
}

export function createLogWriter(path, { maxBytes, backups }) {
  const directory = dirname(path)
  const prefix = `${basename(path)}.rotate-`
  return (line) => {
    mkdirSync(directory, { recursive: true, mode: 0o750 })
    let size = 0
    try {
      const info = lstatSync(path)
      if (!info.isFile()) throw new Error('日志路径必须是普通文件')
      size = info.size
    }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
      lastRotationAt = Math.max(Date.now(), lastRotationAt + 1)
      const id = `${String(lastRotationAt).padStart(13, '0')}-${randomUUID()}`
      renameSync(path, join(directory, `${prefix}${id}`))
      const old = readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.startsWith(prefix) && isLogArchive(path, entry.name))
        .map(entry => entry.name).sort().reverse().slice(backups)
      for (const name of old) unlinkSync(join(directory, name))
    }
    const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
    try { appendFileSync(fd, line) }
    finally { closeSync(fd) }
  }
}

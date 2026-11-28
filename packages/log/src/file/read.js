import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isLogArchive } from './write.js'

import { logLineMessage } from '../presentation.js'

export { logLineMessage }

export const openLog = (path) => open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
export const fileIdentity = (info) => `${info.dev}:${info.ino}`

async function historyFiles(path) {
  if (basename(path) === 'gugu-diag.log') return []
  const directory = dirname(path)
  const names = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const sortKey = (name) => name.slice(name.indexOf('-', basename(path).length) + 1)
  const archives = names.filter(entry => entry.isFile() && isLogArchive(path, entry.name))
    .map(entry => entry.name)
    .sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
  const files = await Promise.all([path, ...archives.map(name => join(directory, name))].map(async name => {
    const info = await lstat(name).catch(() => undefined)
    return info?.isFile() ? { path: name, file: fileIdentity(info), size: info.size } : null
  }))
  return files.filter(file => file !== null)
}
export const epoch = new Date(0)
const timestamp = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/
const isoTimestamp = /^(?:\{"time":")?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/
export const ansi = /\x1b\[[0-9;]*[mK]/g
const chunkSize = 64 * 1024

export function lineDate(line, carried) {
  const match = timestamp.exec(line)
  if (!match) {
    const iso = isoTimestamp.exec(line)
    if (!iso) return carried
    const date = new Date(iso[1])
    if (!Number.isFinite(date.getTime())) return carried
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(),
      date.getMinutes(), date.getSeconds(), date.getMilliseconds()))
  }
  const [, month, day, hour, minute, second] = match
  const parsed = new Date(Date.UTC(new Date().getUTCFullYear(), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)))
  return parsed.getUTCMonth() === Number(month) - 1 && parsed.getUTCDate() === Number(day) ? parsed : carried
}

export function formatTime(date) {
  if (date.getTime() <= epoch.getTime()) return ''
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

function splitLines(raw) {
  const lines = []
  let start = 0
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === 10) {
      lines.push(raw.subarray(start, index))
      start = index + 1
    }
  }
  lines.push(raw.subarray(start))
  return lines
}

async function findPreviousTimestamp(handle, offset) {
  let cursor = Math.max(0, offset)
  try {
    while (cursor > 0) {
      const start = Math.max(0, cursor - chunkSize)
      const raw = Buffer.alloc(cursor - start)
      await handle.read(raw, 0, raw.length, start)
      for (const line of raw.toString('utf8').split('\n').reverse()) {
        const carried = lineDate(line, epoch)
        if (carried > epoch) return carried
      }
      cursor = start
    }
  } catch { return epoch }
  return epoch
}

async function readLogPage(file, end, count) {
  let handle
  try {
    handle = await openLog(file.path)
    const info = await handle.stat()
    if (fileIdentity(info) !== file.file) return { lines: [], start: 0, carried: epoch }
    const { size } = info
    const upper = Math.min(size, Math.max(0, end ?? size))
    if (upper <= 0) return { lines: [], start: 0, carried: epoch }
    let cursor = upper
    let raw = Buffer.alloc(0)
    let newlineCount = 0
    while (cursor > 0) {
      const start = Math.max(0, cursor - chunkSize)
      const part = Buffer.alloc(cursor - start)
      await handle.read(part, 0, part.length, start)
      raw = Buffer.concat([part, raw])
      cursor = start
      newlineCount += part.reduce((sum, byte) => sum + (byte === 10 ? 1 : 0), 0)
      if (cursor === 0 || newlineCount >= count + Number(raw.at(-1) === 10)) break
    }
    let lines = splitLines(raw)
    const discardedPrefix = cursor > 0 && lines.length ? lines[0].length + 1 : 0
    if (cursor > 0 && lines.length) lines = lines.slice(1)
    if (lines.at(-1)?.length === 0) lines.pop()
    if (!lines.length) return { lines: [], start: cursor, carried: epoch }
    const selected = lines.slice(-count)
    const prefixLines = lines.slice(0, lines.length - selected.length)
    const prefixLength = prefixLines.reduce((sum, line) => sum + line.length + 1, 0)
    const pageStart = cursor + discardedPrefix + prefixLength
    let carried = epoch
    for (const line of prefixLines.reverse()) {
      carried = lineDate(line.toString('utf8'), epoch)
      if (carried > epoch) break
    }
    if (carried === epoch && pageStart > 0) carried = await findPreviousTimestamp(handle, pageStart)
    return {
      lines: selected.map((line) => line.toString('utf8').replace(ansi, '')).filter((line) => line.trim().length > 0),
      start: pageStart,
      carried,
    }
  } catch { return { lines: [], start: 0, carried: epoch } }
  finally { await handle?.close() }
}

/** 单来源分页只接受字节偏移或文件身份，路径始终由宿主提供。 */
export async function readLogHistory(path, { cursor, lines, query }) {
  if (cursor === null) return { lines: [], next: null }
  const needle = query?.trim().toLocaleLowerCase() ?? ''
  const files = await historyFiles(path)
  let index = typeof cursor === 'object' ? files.findIndex(file => file.file === cursor.file) : 0
  if (index < 0) return { lines: [], next: null }
  let end = typeof cursor === 'object' ? cursor.end : cursor
  const selected = []
  while (index < files.length && selected.length < lines) {
    const file = files[index]
    const page = await readLogPage(file, end, lines - selected.length)
    let carried = page.carried
    const matching = page.lines.flatMap(line => {
      carried = lineDate(line, carried)
      const message = logLineMessage(line)
      const matches = !needle || line.toLocaleLowerCase().includes(needle) || message?.toLocaleLowerCase().includes(needle)
      return matches ? [{ time: carried, line, ...(message ? { message } : {}) }] : []
    })
    selected.unshift(...matching)
    if (page.start > 0 && page.start < (end ?? file.size)) {
      end = page.start
    } else {
      index += 1
      end = undefined
    }
  }
  const next = files.slice(index).find(file => file.size > 0)
  return { lines: selected, next: next ? { file: next.file, end: end ?? next.size } : null }
}

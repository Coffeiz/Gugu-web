import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { desktopLogHandlers } from '../src/main/log/read.js'

it('只读取固定日志，返回有界的近期完整记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-log-read-'))
  try {
    const read = desktopLogHandlers(directory)[DESKTOP_CHANNELS.readLogs]!
    await expect(read('regular')).resolves.toEqual({ lines: [], truncated: false })
    await expect(read('../config')).rejects.toMatchObject({ code: 'invalid_request' })
    const logs = join(directory, 'logs')
    await mkdir(logs)
    await writeFile(join(logs, 'gugu.log'), Array.from({ length: 325 }, (_, i) => `记录 ${i}\n`).join('') + '未完成')
    await writeFile(join(logs, 'gugu-diag.log'), '诊断记录\n')
    const result = await read('regular') as { lines: string[]; truncated: boolean }
    expect(result.truncated).toBe(true)
    expect(result.lines).toHaveLength(300)
    expect(result.lines.at(0)).toBe('记录 25')
    expect(result.lines.at(-1)).toBe('记录 324')
    await expect(read('diagnostic')).resolves.toEqual({ lines: ['诊断记录'], truncated: false })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it, vi } from 'vitest'
import { createDesktopMemoryFiles } from '../../src/agent/memory/desktop-files.js'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { buildDesktopGreetingPrompt } from '../../src/runtime/desktop-greeting.js'

it('桌面问候只读取所选记忆，保留 SQLite 优先和旧文件兼容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-desktop-greeting-'))
  try {
    const path = join(root, 'desktop.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const disk = createDesktopMemoryFiles(runtime.db, root, ownerId)
      await disk.initialize()
      const directory = join(root, '.agent', 'memories')
      await writeFile(join(directory, 'profile.json'), '[{"text":"旧画像"}]')
      await writeFile(join(directory, 'summary.json'), '{"text":"文件摘要"}')
      await writeFile(join(directory, 'pattern.json'), '不应读取的记忆')
      await sql`INSERT INTO desktop_agent_memory (user_id,target,body) VALUES
        (${ownerId.replaceAll('-', '')}, 'profile', '[{"text":"数据库画像"}]'),
        ('another-owner', 'profile', '[{"text":"其他用户画像"}]')`.execute(runtime.db)
      const readTarget = vi.spyOn(disk, 'readTarget')

      const signal = new AbortController().signal
      const prompt = await buildDesktopGreetingPrompt(runtime.db, ownerId, 'zh-CN', signal, disk, ['user.profile', 'memory.summary'])
      expect(prompt).toContain('数据库画像')
      expect(prompt).toContain('文件摘要')
      expect(prompt).not.toContain('旧画像')
      expect(prompt).not.toContain('其他用户画像')
      expect(readTarget.mock.calls.map(([target]) => target).sort()).toEqual(['profile', 'summary'])

      readTarget.mockClear()
      const fullPrompt = await buildDesktopGreetingPrompt(runtime.db, ownerId, 'ja-JP', signal, disk)
      expect(fullPrompt).toContain('自然な日本語')
      expect(fullPrompt).toContain('数据库画像')
      expect(fullPrompt).toContain('文件摘要')
      expect(readTarget.mock.calls.map(([target]) => target).sort()).toEqual(['daily', 'profile', 'stance', 'summary'])
    } finally { await runtime.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

import { expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileWorkspaces } from '../src/main/files/workspaces.js'

it('按名称创建独立工作区，拒绝路径逃逸与重名覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-create-'))
  try {
    const workspaces = fileWorkspaces(root, join(root, 'registry.json'))
    const id = await workspaces.create('合成工作区')
    const row = (await workspaces.list()).find(item => item.id === id)!
    expect(row.name).toBe('合成工作区')
    expect((await stat(join(root, 'workspaces', '合成工作区'))).isDirectory()).toBe(true)
    await expect(workspaces.create('../escape')).rejects.toThrow()
    await expect(workspaces.create('合成工作区')).rejects.toThrow()
    expect((await workspaces.list()).filter(item => item.id === id)).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

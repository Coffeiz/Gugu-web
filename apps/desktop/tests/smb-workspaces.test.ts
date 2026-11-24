import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fileWorkspaces } from '../src/main/files/workspaces'
import { smbShareUrl } from '../src/main/files/smb-workspaces'

it('SMB 工作区打开时有限次重连，并拒绝原挂载点上的不同共享', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-smb-workspace-'))
  const registry = join(directory, 'workspaces.json')
  const url = 'smb://synthetic.invalid/share'
  const mountPath = '/Volumes/synthetic-share'
  const id = 'desktop:aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const mounts = vi.fn<() => Promise<{ url: string; path: string }[]>>().mockResolvedValue([])
  const connect = vi.fn(async (_url: string) => {})
  const workspace = fileWorkspaces(join(directory, 'files'), registry, undefined, {
    mounts, connect, delay: vi.fn(async () => {}),
  })
  try {
    await writeFile(registry, JSON.stringify([{ id, name: '合成工作区', root: mountPath, smb: { url, mountPath } }]))
    const binding = await workspace.get(id)
    await expect(workspace.prepareBrowse(binding)).rejects.toMatchObject({ code: 'workspace_unavailable' })
    expect(connect.mock.calls).toEqual([[url], [url], [url]])

    connect.mockClear()
    mounts.mockResolvedValueOnce([]).mockResolvedValue([{ path: mountPath, url }])
    await expect(workspace.prepareBrowse(binding)).resolves.toBeUndefined()
    expect(connect.mock.calls).toEqual([[url]])

    connect.mockClear()
    mounts.mockResolvedValue([{ path: mountPath, url: 'smb://synthetic.invalid/other' }])
    await expect(workspace.prepareBrowse(binding)).rejects.toMatchObject({ code: 'workspace_unavailable' })
    expect(connect).not.toHaveBeenCalled()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('共享地址不保存 SMB 凭据', () => {
  expect(smbShareUrl('smb://synthetic-user:synthetic-password@synthetic.invalid/share'))
    .toBe('smb://synthetic.invalid/share')
})

import { describe, expect, it, vi } from 'vitest'
import { createOnboardingReseeder } from '../../src/onboarding/reseed.js'

describe('引导内容重播种', () => {
  it('只清理当前 owner 的旧引导项目文件，再按其语言重新播种并返回最终状态', async () => {
    let state: Record<string, any> = {
      seed: { seeded: true, project_id: 41, project_name: '从这里开始' },
      guide: { enabled: true, version: 1, current_step: 'complete', completed_steps: ['locale'], dismissed: true, completed_at: '2026-11-16' },
    }
    const calls: unknown[][] = []
    const store = {
      async getState(ownerId: string) { calls.push(['state', ownerId]); return state },
      async updateGuide() { throw new Error('重播种不得改写 guide store') },
    }
    const ports = {
      async removeSeedProject(ownerId: string, projectId: number) {
        calls.push(['remove-project', ownerId, projectId])
        return ['owner-a/project/old.md']
      },
      async removeStorage(ownerId: string, key: string) { calls.push(['remove-storage', ownerId, key]) },
      async resetSeed(ownerId: string) { calls.push(['reset-seed', ownerId]); state = { ...state, seed: { seeded: false, project_id: null, project_name: null } } },
      async locale(ownerId: string) { calls.push(['locale', ownerId]); return 'ja-JP' },
      async seed(ownerId: string, locale: string | null) {
        calls.push(['seed', ownerId, locale])
        state = { seed: { seeded: true, project_id: 42, project_name: 'ここから始める' }, guide: { enabled: true, version: 1, current_step: 'locale', completed_steps: [], dismissed: false, completed_at: null } }
      },
    }
    const reseed = createOnboardingReseeder(store, ports)

    await expect(reseed('owner-a')).resolves.toMatchObject({
      ok: true,
      state: { seed: { seeded: true, project_id: 42 }, should_show: true },
    })
    expect(calls).toEqual([
      ['state', 'owner-a'],
      ['remove-project', 'owner-a', 41],
      ['remove-storage', 'owner-a', 'owner-a/project/old.md'],
      ['reset-seed', 'owner-a'],
      ['locale', 'owner-a'],
      ['seed', 'owner-a', 'ja-JP'],
      ['state', 'owner-a'],
    ])
  })

  it('无旧项目时仍重置 seed gate 并重新播种，物理文件删除失败时不继续清状态或播种', async () => {
    let seeded = false
    const store = { async getState() { return { seed: { seeded, project_id: seeded ? 42 : null }, guide: {} } }, async updateGuide() { return {} } }
    const ports = {
      removeSeedProject: vi.fn(async () => []), removeStorage: vi.fn(async () => {}),
      resetSeed: vi.fn(async () => { seeded = false }), locale: vi.fn(async () => 'en-US'), seed: vi.fn(async () => { seeded = true }),
    }
    await createOnboardingReseeder(store, ports)('owner-a')
    expect(ports.removeSeedProject).not.toHaveBeenCalled()
    expect(ports.resetSeed).toHaveBeenCalledOnce()
    expect(ports.seed).toHaveBeenCalledWith('owner-a', 'en-US')

    ports.removeSeedProject.mockResolvedValue(['owner-a/project/old.md'])
    ports.removeStorage.mockRejectedValueOnce(new Error('storage unavailable'))
    ports.resetSeed.mockClear(); ports.seed.mockClear()
    await expect(createOnboardingReseeder(store, ports)('owner-a')).rejects.toThrow('storage unavailable')
    expect(ports.resetSeed).not.toHaveBeenCalled()
    expect(ports.seed).not.toHaveBeenCalled()
  })
})

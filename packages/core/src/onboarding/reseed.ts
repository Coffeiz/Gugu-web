import { onboardingResponse, type OnboardingStore } from './state.js'

export interface OnboardingReseedPorts {
  /** 事务删除指定 owner 的引导项目和文件行，提交后返回待清理的 owner 存储键。 */
  removeSeedProject(ownerId: string, projectId: number): Promise<readonly string[]>
  /** 删除已经从数据库解除引用的物理文件。失败时必须停止，保留旧 seed gate。 */
  removeStorage(ownerId: string, storageKey: string): Promise<void>
  /** 重置 seed 字段但保留 guide 和其他历史字段。 */
  resetSeed(ownerId: string): Promise<void>
  locale(ownerId: string): Promise<string | null>
  seed(ownerId: string, locale: string | null): Promise<void>
}

/** 重播当前 owner 的引导内容；删除、物理清理和重播顺序兼容 FastAPI dev/reseed。 */
export function createOnboardingReseeder(store: OnboardingStore, ports: OnboardingReseedPorts) {
  return async function reseed(ownerId: string) {
    const current = await store.getState(ownerId)
    const seed = current.seed && typeof current.seed === 'object' && !Array.isArray(current.seed)
      ? current.seed as Record<string, unknown> : {}
    const rawProjectId = seed.project_id
    const projectId = typeof rawProjectId === 'number' && Number.isSafeInteger(rawProjectId) && rawProjectId > 0
      ? rawProjectId : typeof rawProjectId === 'string' && /^[1-9]\d*$/.test(rawProjectId)
        ? Number(rawProjectId) : null
    if (projectId !== null) {
      const storageKeys = await ports.removeSeedProject(ownerId, projectId)
      for (const storageKey of storageKeys) await ports.removeStorage(ownerId, storageKey)
    }
    await ports.resetSeed(ownerId)
    const locale = await ports.locale(ownerId)
    await ports.seed(ownerId, locale)
    return { ok: true, state: onboardingResponse(await store.getState(ownerId)) }
  }
}

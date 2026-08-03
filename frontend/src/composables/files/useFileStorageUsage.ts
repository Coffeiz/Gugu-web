import { reactive } from 'vue'
import { filesApi } from '@/services/api'

export interface FileStorageInfo {
  used: number
  limit: number | null
  loaded: boolean
}

/** 文件库存储用量查询；页面只负责在生命周期和数据变更时触发刷新。 */
export function useFileStorageUsage() {
  const storageInfo = reactive<FileStorageInfo>({ used: 0, limit: null, loaded: false })

  async function fetchStorage() {
    try {
      const data = await filesApi.storage()
      storageInfo.used = data.used_bytes ?? 0
      storageInfo.limit = data.limit_bytes ?? null
      storageInfo.loaded = true
    } catch {
      // 存储用量是辅助信息，失败时保留上一次已知值。
    }
  }

  return { storageInfo, fetchStorage }
}

import { ref } from 'vue'

/** 文件数不再通过全项目聚合热查询；缺少可信摘要时不覆盖项目自身数据。 */
export function useProjectFileCounts(_filesRevision: unknown) {
  const counts = ref<Map<number, number> | null>(null)
  return { counts, refresh: () => {} }
}

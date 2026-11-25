import { watch } from 'vue'
import type { PathFileRef } from '@/services/api'
import type { PathFileAccess } from '@/services/pathFileAccess'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'
import { useFileWatch } from './useFileWatch'

export function useImageFileWatch(
  access: PathFileAccess,
  currentFile: () => PathFileRef | undefined,
  refresh: () => void | Promise<void>,
) {
  const readRevision = access.fileRevision
  const watchUrl = access.watchDirectoryUrl
  if (!readRevision || !watchUrl) return
  let revision: string | undefined
  let generation = 0
  watch([currentFile, accountBoundaryEpoch], () => {
    generation++
    revision = undefined
  }, { flush: 'sync' })

  useFileWatch(() => {
    const file = currentFile()
    if (!file) return
    const directory = file.relativePath.split('/').slice(0, -1).join('/')
    return `${watchUrl({ directoryId: file.directoryId, relativePath: directory })}#${encodeURIComponent(JSON.stringify(file))}`
  }, async signal => {
    const file = currentFile()
    if (!file) return
    const request = generation
    let next: string | undefined
    try { next = await readRevision(file, signal) }
    catch { return } // 共享目录暂时离线时，下次可见检查会重试。
    if (!next || signal.aborted || request !== generation) return
    const changed = revision !== undefined && revision !== next
    revision = next
    if (changed) await refresh()
  })
}

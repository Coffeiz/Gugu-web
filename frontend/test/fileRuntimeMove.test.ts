import { describe, expect, it, vi } from 'vitest'
import { useFileRuntimeMove } from '@/composables/files/useFileRuntimeMove'
import { captureOptimisticIntent } from '@/utils/optimisticIntent'

describe('useFileRuntimeMove', () => {
  function setup(scope = 'files') {
    const moveFolders = vi.fn(async () => undefined)
    const moveFiles = vi.fn(async () => undefined)
    const clearSelection = vi.fn()
    const resolveBreadcrumbTarget = vi.fn((index: number) =>
      index === 2 ? { folderId: 8, droppedOn: 'breadcrumb' as const } : null,
    )
    const adapter = useFileRuntimeMove({
      scope,
      browserSurfaceId: `${scope}:surface:browser`,
      resolveBreadcrumbTarget,
      moveFolders,
      moveFiles,
      clearSelection,
    })
    return { adapter, moveFolders, moveFiles, resolveBreadcrumbTarget, clearSelection }
  }

  it('按对象类型把混合移动分发给文件夹和文件业务函数', async () => {
    const { adapter, moveFolders, moveFiles, clearSelection } = setup()

    await adapter.handleAction(
      ['files:folder:5', 'files:file:7'],
      'files:surface:folder:9',
    )

    expect(moveFolders).toHaveBeenCalledWith([5], 9)
    expect(moveFiles).toHaveBeenCalledWith([7], 9, { droppedOn: 'folder' })
    expect(clearSelection).toHaveBeenCalledOnce()
  })

  it('把面包屑目标交给页面解析，并忽略无效落点', async () => {
    const { adapter, resolveBreadcrumbTarget, moveFolders, moveFiles, clearSelection } = setup()

    await adapter.handleAction(['files:file:7'], 'files:breadcrumb:2')
    expect(resolveBreadcrumbTarget).toHaveBeenCalledWith(2)
    expect(moveFiles).toHaveBeenCalledWith([7], 8, { droppedOn: 'breadcrumb' })

    await adapter.handleAction(['files:file:7'], 'files:breadcrumb:1')
    expect(moveFiles).toHaveBeenCalledOnce()
    expect(moveFolders).not.toHaveBeenCalled()
    expect(clearSelection).toHaveBeenCalledOnce()
  })

  it('忽略浏览区、非法对象和文件夹拖到自身', async () => {
    const { adapter, moveFolders, moveFiles, clearSelection } = setup()

    await adapter.handleAction(['files:file:7'], 'files:surface:browser')
    await adapter.handleAction(['other:file:7', 'files:file:nope'], 'files:surface:folder:9')
    await adapter.handleAction(['files:folder:9'], 'files:surface:folder:9')

    expect(moveFolders).not.toHaveBeenCalled()
    expect(moveFiles).not.toHaveBeenCalled()
    expect(clearSelection).not.toHaveBeenCalled()
  })

  it('文件与文件夹分别获得自己的 optimistic intent，不互相清理 rollback chain', async () => {
    const seen: Array<{ kind: string; keys: readonly string[]; revision: number }> = []
    const adapter = useFileRuntimeMove({
      scope: 'files',
      browserSurfaceId: 'files:surface:browser',
      resolveBreadcrumbTarget: () => null,
      moveFolders: async () => {
        const intent = captureOptimisticIntent()
        if (intent) seen.push({ kind: 'folder', keys: intent.keys, revision: intent.revision })
      },
      moveFiles: async () => {
        const intent = captureOptimisticIntent()
        if (intent) seen.push({ kind: 'file', keys: intent.keys, revision: intent.revision })
      },
      clearSelection: () => {},
    })

    await adapter.handleAction(['files:folder:5', 'files:file:7'], 'files:surface:folder:9')

    expect(seen).toHaveLength(2)
    expect(seen.find(item => item.kind === 'folder')?.keys).toEqual(['files:folder:5'])
    expect(seen.find(item => item.kind === 'file')?.keys).toEqual(['files:file:7'])
    expect(seen[0].revision).not.toBe(seen[1].revision)
  })

  it('同一卡片 regrab 后产生更高 revision，第二次 Action 成为最新意图', async () => {
    const revisions: number[] = []
    const adapter = useFileRuntimeMove({
      scope: 'files',
      browserSurfaceId: 'files:surface:browser',
      resolveBreadcrumbTarget: () => null,
      moveFolders: async () => {},
      moveFiles: async () => {
        const intent = captureOptimisticIntent()
        if (intent) revisions.push(intent.revision)
      },
      clearSelection: () => {},
    })

    await adapter.handleAction(['files:file:7'], 'files:surface:folder:9')
    await adapter.handleAction(['files:file:7'], 'files:surface:folder:10')

    expect(revisions).toHaveLength(2)
    expect(revisions[1]).toBeGreaterThan(revisions[0])
  })
})

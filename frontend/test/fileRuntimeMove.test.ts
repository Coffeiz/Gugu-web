import { describe, expect, it, vi } from 'vitest'
import { useFileRuntimeMove } from '@/composables/files/useFileRuntimeMove'

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
})

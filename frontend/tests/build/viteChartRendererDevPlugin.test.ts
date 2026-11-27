import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createChartRendererDevPlugin } from '../../vite-chart-renderer-dev-plugin.mjs'

describe('Vite Mermaid 源码虚拟模块', () => {
  it('加载共享渲染源码时登记对应文件为 Vite 监听依赖', () => {
    const frontendDir = resolve(fileURLToPath(new URL('../../', import.meta.url)))
    const plugin = createChartRendererDevPlugin(frontendDir)
    const resolvedId = plugin.resolveId('../../../../backend/ts/workers/chart-renderer/theme.mjs')
    const addWatchFile = vi.fn()
    const sourcePath = resolve(frontendDir, '../backend/ts/workers/chart-renderer/theme.mjs')

    expect(resolvedId).toBe('\0gugu-chart-renderer:theme')
    const source = plugin.load.call({ addWatchFile }, resolvedId)

    expect(source).toContain('export')
    expect(addWatchFile).toHaveBeenCalledWith(sourcePath)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function load(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const filesPage = load('../../views/Files/index.vue')
const folderCard = load('../../components/common/file-browser/FolderCard.vue')
const fileToolbar = load('./file-toolbar-theme-refinements.css')
const surfacesAdoption = load('./adoption/surfaces.css')
const browserToolbar = load('../../components/common/file-browser/FileBrowserToolbar.vue')
const projectToolbar = load('../../views/Projects/components/ProjectFileToolbar.vue')
const segmentedControl = load('../../components/common/SegmentedControl.vue')

describe('文件浏览 0.20.4 视觉回归契约', () => {
  it('文件库恢复 52px 工具栏高度，共享组件不重复拥有宿主高度', () => {
    expect(filesPage).toContain('height: 52px; box-sizing: border-box;')
    expect(browserToolbar).not.toContain('height: 52px;')
    expect(projectToolbar).toContain('height: 52px;')
    expect(projectToolbar).toContain('box-sizing: border-box;')
  })

  it('网格/列表恢复 inset slider 几何并保留真实移动 pill', () => {
    expect(fileToolbar).toContain('--file-view-toggle-item-size: 28px;')
    expect(fileToolbar).toContain('--file-view-toggle-inset: 2px;')
    expect(fileToolbar).toContain('--file-view-toggle-gap: 2px;')
    expect(fileToolbar).toContain('--file-view-toggle-track-radius: 8px;')
    expect(fileToolbar).toContain('--file-view-toggle-pill-radius: 6px;')
    expect(fileToolbar).toContain('padding: var(--file-view-toggle-inset);')
    expect(fileToolbar).toContain('gap: var(--file-view-toggle-gap);')
    expect(segmentedControl).toContain('class="seg-pill"')
    expect(segmentedControl).toContain('transform: `translate(${dx}px, ${dy}px)`')
  })

  it('FolderCard 亮色锁定 0.20.4 多选视觉，暗色只重映射局部 token', () => {
    expect(folderCard).toContain('--folder-card-bg: color-mix(in srgb, var(--fd-color, #8888a0) 6%, rgba(255,255,255,.82));')
    expect(folderCard).toContain('--folder-card-border-selected: rgba(123,127,178,.55);')
    expect(folderCard).toContain('--folder-card-selection-overlay: rgba(123,127,178,.14);')
    expect(folderCard).toContain('--folder-card-bg-preselected: rgba(123,127,178,.05);')
    expect(folderCard).toContain(":global(html[data-theme='dark'][data-family]) .folder-card")
    expect(folderCard).toContain('--folder-card-bg-selected: var(--surface-raised);')
    expect(folderCard).toContain('--folder-card-checkbox-bg: var(--surface-raised);')
    expect(folderCard).not.toContain('!important')
    expect(surfacesAdoption).not.toContain('.folder-card')
  })
})

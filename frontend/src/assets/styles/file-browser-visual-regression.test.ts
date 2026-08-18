import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function load(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

function cssBlock(css: string, selectorNeedle: string) {
  const start = css.indexOf(selectorNeedle)
  if (start < 0) throw new Error(`Missing selector: ${selectorNeedle}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

const folderCard = load('../../components/common/file-browser/FolderCard.vue')
const fileCard = load('../../components/common/file-browser/FileCard.vue')
const fileToolbar = load('./file-toolbar-theme-refinements.css')
const componentRefinements = load('./component-theme-refinements.css')
const componentSurfaces = load('./tokens/components/surfaces.css')
const productCss = load('./tokens/product.css')
const surfacesAdoption = load('./adoption/surfaces.css')
const projectAdoption = load('./adoption/project.css')
const browserPanel = load('../../components/common/file-browser/FileBrowserPanel.vue')
const browserToolbar = load('../../components/common/file-browser/FileBrowserToolbar.vue')
const projectToolbar = load('../../views/Projects/components/ProjectFileToolbar.vue')
const filesListView = load('../../views/Files/components/FilesListView.vue')
const filesListRows = load('./filesListRows.css')
const boxSelection = load('../../composables/useBoxSelection.ts')
const segmentedControl = load('../../components/common/SegmentedControl.vue')

describe('文件浏览 0.20.4 视觉回归契约', () => {
  it('文件库直接宿主恢复 52px 工具栏高度，共享组件不重复拥有宿主高度', () => {
    expect(browserPanel).toContain('height: 52px;')
    expect(browserPanel).toContain('padding: 0 16px;')
    expect(browserPanel).toContain('gap: 12px;')
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

  it('FolderCard 只拥有状态结构和动态 accent 混合，主题值统一由 component token 提供', () => {
    expect(folderCard).toContain('--folder-card-bg: color-mix(in srgb,var(--fd-color,#8888a0) 6%,var(--folder-card-bg-base));')
    expect(folderCard).toContain('--folder-card-border: color-mix(in srgb,var(--fd-color,#8888a0) 14%,var(--folder-card-border-base));')
    expect(folderCard).toContain('background: var(--folder-card-bg);')
    expect(folderCard).toContain('border: 1px solid var(--folder-card-border);')
    expect(folderCard).toContain('.folder-card:hover:not(.selected):not(.pre-selected)')
    expect(folderCard).toContain('.folder-card.pre-selected:not(.selected)')
    expect(folderCard).not.toContain(":global(html[data-theme='dark'")
    expect(folderCard).not.toContain('!important')

    // Aero light remains the 0.20.4 baseline.
    expect(componentSurfaces).toContain('--folder-card-bg-base: rgba(255,255,255,.82);')
    expect(componentSurfaces).toContain('--folder-card-border-base: rgba(255,255,255,.92);')
    expect(componentSurfaces).toContain('--folder-card-border-selected: rgba(123,127,178,.55);')
    expect(componentSurfaces).toContain('--folder-card-selection-overlay: rgba(123,127,178,.14);')

    // Mono light regains its neutral solid edge instead of inheriting Aero's near-white border.
    const monoLight = cssBlock(componentSurfaces, "html[data-theme='light'][data-family='v2']")
    expect(monoLight).toContain('--file-card-border: var(--border-strong);')
    expect(monoLight).toContain('--folder-card-bg-base: var(--surface-card-solid);')
    expect(monoLight).toContain('--folder-card-border-base: var(--border-strong);')
    expect(monoLight).toContain('--folder-card-shadow: var(--elevation-card);')

    // Both Aero-dark and Mono-dark resolve through semantic dark tokens; restore the previous dark
    // folder checkbox/selection treatment without a second entity selector.
    const dark = cssBlock(componentSurfaces, "html[data-theme='dark'][data-family]")
    expect(dark).toContain('--folder-card-bg-base: var(--surface-card-solid);')
    expect(dark).toContain('--folder-card-border-base: var(--border-strong);')
    expect(dark).toContain('--folder-card-checkbox-bg-checked: var(--action-primary-bg);')
    expect(dark).toContain('--folder-card-checkbox-border-checked: transparent;')

    expect(surfacesAdoption).not.toContain('.folder-card')
    expect(componentRefinements).not.toContain('.folder-card.selected {')
    expect(componentRefinements).not.toContain('.folder-card.pre-selected {')
  })

  it('文件卡 hover/图片预框选不会覆盖 selected，项目普通文件也得到 0.20.4 full-card preview', () => {
    expect(fileCard).toContain('.fc-card:hover:not(.selected):not(.pre-selected)')
    expect(fileCard).toContain('.fc-card.pre-selected:not(.selected) .fc-thumb-area::after')
    expect(fileCard).toContain('var(--file-card-preselection-thumb-overlay)')
    expect(fileCard).toContain(":global(html[data-theme='light'][data-family] .project-modal-root) .fc-card.pre-selected:not(.selected)")
    expect(componentRefinements).toContain("html[data-theme='dark'][data-family] :is(.files-page, .project-modal-root) .fc-card.pre-selected:not(.selected)")
    expect(componentRefinements).not.toContain('html[data-theme][data-family] .fc-card:hover {')
    expect(componentRefinements).not.toContain('html[data-theme][data-family] .fc-card::after,')
  })

  it('20.4 selected ring 在 hover 时保持，generic hover utility 不再拥有 File/FolderCard shadow/transition', () => {
    expect(fileCard).toContain('.fc-card.selected {')
    expect(fileCard).toContain('box-shadow: var(--file-card-shadow-selected);')
    expect(productCss).toContain('.hover-card-fx:not(.fc-card):not(.folder-card):hover')
    expect(productCss).not.toContain('html[data-theme][data-family] .hover-card-fx:hover { box-shadow:')
    expect(componentRefinements).toContain('.hover-card-fx:not(.fc-card):not(.folder-card),')
    expect(componentRefinements).not.toContain('html[data-theme][data-family] .hover-card-fx,\n')
  })

  it('框选 preview 与已选集合视觉互斥，同时保留完整 mouseup 命中集合', () => {
    expect(boxSelection).toContain('_latestPreview = { fileIds, folderIds }')
    expect(boxSelection).toContain('!selectedFileIds.value.has(id)')
    expect(boxSelection).toContain('!selectedFolderIds.value.has(id)')
    expect(filesListRows).toContain(':hover:not(.selected):not(.pre-selected)')
    expect(filesListRows).toContain('.pre-selected:not(.selected)')
  })

  it('列表行状态只有共享 rows stylesheet 一个 paint owner', () => {
    expect(filesListView).not.toContain('.list-row {')
    expect(filesListView).not.toContain('.sel-checkbox {')
    expect(filesListRows).toContain('.sel-checkbox')
    expect(filesListRows).toContain('box-shadow: none;')
  })

  it('多选 checkbox 无高光阴影，最终主题层不再重复接管 checkbox/folder paint', () => {
    expect(folderCard).toContain('box-shadow: none;')
    expect(filesListRows).toContain('box-shadow: none;')
    expect(componentRefinements).not.toContain('.sel-checkbox')
    expect(componentRefinements).not.toContain('/* ── File toolbar')
  })

  it('路径前进回退恢复 0.20.4 icon-first hover 样式', () => {
    expect(fileToolbar).toContain(':is(.nav-hist-btn, .pm-nav-hist-btn) {')
    expect(fileToolbar).toContain('width: 26px;')
    expect(fileToolbar).toContain('background: transparent;')
    expect(fileToolbar).toContain('opacity: .28;')
    expect(fileToolbar).toContain('.nav-hist-btn > svg')
    expect(fileToolbar).toContain('width: 14px;')
    expect(fileToolbar).toContain('.pm-nav-hist-btn > svg')
    expect(fileToolbar).toContain('width: 13px;')
  })

  it('项目 stage 亮色只重映射局部 option token，上传关闭按钮复用通用 control paint', () => {
    expect(projectAdoption).toContain("html[data-theme='light'][data-family] .project-modal-root .stages-section .node-circle")
    expect(projectAdoption).toContain("html[data-theme='light'][data-family] .project-modal-root .stages-section .todo-check")
    expect(projectAdoption).toContain("html[data-theme='light'][data-family] .project-modal-root .stages-section .todo-add-btn")
    expect(surfacesAdoption).toContain('.bm-card:has(.drop-zone) .modal-header .close-btn')
    expect(surfacesAdoption).toContain('background: var(--control-bg);')
    expect(surfacesAdoption).toContain('background: var(--control-bg-hover);')
  })
})

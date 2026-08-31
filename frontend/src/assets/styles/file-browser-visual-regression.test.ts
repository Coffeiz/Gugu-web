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
const formsAdoption = load('./adoption/forms.css')
const projectAdoption = load('./adoption/project.css')
const runtimeAdoption = load('./adoption/runtime.css')
const browserPanel = load('../../components/common/file-browser/FileBrowserPanel.vue')
const browserToolbar = load('../../components/common/file-browser/FileBrowserToolbar.vue')
const projectToolbar = load('../../views/Projects/components/ProjectFileToolbar.vue')
const filesListView = load('../../views/Files/components/FilesListView.vue')
const filesListRows = load('./filesListRows.css')
const fileSelectionCheckbox = load('./fileSelectionCheckbox.css')
const uploadGhost = load('../../components/common/file-browser/FileUploadGhostCard.vue')
const boxSelection = load('../../composables/useBoxSelection.ts')
const segmentedControl = load('../../components/common/SegmentedControl.vue')
const runtimeSetup = load('../../interaction/runtime/setup.ts')
const mindRuntimeObject = load('../../views/Mind/composables/useMindRuntimeObject.ts')

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

    const monoLight = cssBlock(componentSurfaces, "html[data-theme='light'][data-family='mono']")
    expect(monoLight).toContain('--file-card-border: var(--border-strong);')
    expect(monoLight).toContain('--folder-card-bg-base: var(--surface-card-solid);')
    expect(monoLight).toContain('--folder-card-border-base: var(--border-strong);')
    expect(monoLight).toContain('--folder-card-shadow: var(--elevation-card);')

    const dark = cssBlock(componentSurfaces, "html[data-theme='dark'][data-family]")
    expect(dark).toContain('--folder-card-bg-base: var(--surface-card-solid);')
    expect(dark).toContain('--folder-card-border-base: var(--border-strong);')
    expect(dark).toContain('--folder-card-checkbox-bg-checked: var(--action-primary-bg);')
    expect(dark).toContain('--folder-card-checkbox-border-checked: transparent;')

    expect(surfacesAdoption).not.toContain('.folder-card')
    expect(componentRefinements).not.toContain('.folder-card.selected {')
    expect(componentRefinements).not.toContain('.folder-card.pre-selected {')
  })

  it('文件卡 hover/图片预框选不会覆盖 selected，亮色 full-card preview 由 FileCard 自己统一拥有', () => {
    expect(fileCard).toContain('.fc-card:hover:not(.selected):not(.pre-selected)')
    expect(fileCard).toContain('.fc-card.pre-selected:not(.selected) .fc-thumb-area::after')
    expect(fileCard).toContain('var(--file-card-preselection-thumb-overlay)')
    expect(fileCard).toContain(":global(html[data-theme='light'][data-family]) .fc-card.pre-selected:not(.selected)")
    expect(fileCard).not.toContain(":global(html[data-theme='light'][data-family] .project-modal-root)")
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

  it('网格与列表多选框共享 FolderCard 已验证的主题 token 和同一个勾形', () => {
    expect(fileSelectionCheckbox).toContain('--file-browser-checkbox-bg: var(--folder-card-checkbox-bg);')
    expect(fileSelectionCheckbox).toContain('--file-card-checkbox-bg: var(--file-browser-checkbox-bg);')
    expect(fileSelectionCheckbox).toContain('--file-card-checkbox-fg-checked: var(--file-browser-checkbox-fg-checked);')
    expect(fileSelectionCheckbox).toContain('.sel-checkbox.checked > svg')
    expect(fileSelectionCheckbox).toContain('.sel-checkbox.checked::after')
    expect(fileSelectionCheckbox).toContain("M2 6l3 3 5-5")
    expect(filesListRows).toContain('color: var(--file-browser-checkbox-fg-checked);')
    expect(filesListRows).toContain('background: var(--file-browser-checkbox-bg-checked);')
    expect(filesListRows).not.toContain("html[data-theme='dark'][data-family] .list-row .sel-checkbox")
  })

  it('列表行状态只有共享 rows stylesheet 一个 paint/layout owner', () => {
    expect(filesListView).not.toContain('.list-row {')
    expect(filesListView).not.toContain('.sel-checkbox {')
    expect(filesListView).not.toContain('grid-template-columns:')
    expect(filesListRows).toContain('.sel-checkbox')
    expect(filesListRows).toContain('box-shadow: none;')
    expect(uploadGhost).not.toContain('grid-template-columns:')
    expect(uploadGhost).not.toContain(':deep(.lr-filename)')
  })

  it('列表行布局不会再被 global reset 清零，并保留当前列排布而不是回退 20.4', () => {
    expect(filesListRows).toContain('padding-inline: 4px;')
    expect(filesListRows).toContain('column-gap: 8px;')
    expect(filesListRows).toContain('padding: 0 14px 8px;')
    expect(filesListRows).toContain('padding: 9px 14px;')
    expect(filesListRows).toContain(':is(.file-list .list-row, .file-list-view .list-row')
    expect(filesListRows).not.toContain(':where(.file-list .list-row')
    expect(filesListRows).toContain('[data-runtime-compact="true"] { overflow: hidden; }')
    expect(filesListRows).toContain('[data-runtime-compact="true"] > * { min-width: 0; }')
    expect(filesListRows).toContain('[data-runtime-compact="true"][data-list-columns="5"] > :nth-child(n+4) { overflow: hidden; }')
  })

  it('列表 compact proxy 只会收窄，窄项目文件区不会抓起一帧反向变宽', () => {
    expect((runtimeSetup.match(/width: 'min\(300px, 100%\)'/g) ?? []).length).toBe(2)
    expect(runtimeSetup).not.toContain("width: 'min(300px, calc(100vw - 48px))'")
  })

  it('暗色 File/FolderCard grabbing 修正只作用抓取阶段，landing 重新让组件目标底色参与渐变', () => {
    const selector = "html[data-theme='dark'][data-family] :is(.fc-card, .folder-card)[data-runtime-proxy-content='true']:is([data-runtime-phase='grab-start'], [data-runtime-phase='grabbing'])"
    expect(runtimeAdoption).toContain(selector)
    const block = cssBlock(runtimeAdoption, selector)
    expect(block).toContain('background-color: var(--surface-card-solid) !important;')
    expect(block).toContain('border-color: var(--border-strong) !important;')
    expect(runtimeAdoption).not.toContain("html[data-theme='dark'][data-family] :is(.fc-card, .folder-card)[data-runtime-proxy-content='true'] {\n")
  })

  it('亮色咕咕卡片 grabbing 恢复卡片底色层和缩略图独立层', () => {
    expect(componentSurfaces).toContain('--gugu-card-drag-bg: color-mix(in srgb,var(--surface-floating) 50%,transparent);')
    const selector = "html[data-theme='light'][data-family] :is(.proj-card, .drawer-project-card, .pr-card, .fc-card, .folder-card)[data-runtime-proxy-content='true']:is([data-runtime-phase='grab-start'], [data-runtime-phase='grabbing'])"
    expect(runtimeAdoption).toContain(selector)
    expect(cssBlock(runtimeAdoption, selector)).toContain('background: var(--gugu-card-drag-bg) !important;')
    expect(runtimeAdoption).toContain('.fc-thumb-area')
    expect(runtimeAdoption).toContain('.fc-thumb-full.fc-loaded')
  })

  it('亮色 Mono 画布卡片 grabbing 复用 Mono 描边，landing 不会被锁死', () => {
    const selector = "html[data-theme='light'][data-family='mono'] :is(.mind-project-card, .drawer-project-card, .proj-card, .pr-card, .note-card, .entity-sticker, .fc-card, .folder-card)[data-runtime-proxy-content='true']:is([data-runtime-phase='grab-start'], [data-runtime-phase='grabbing'])"
    expect(runtimeAdoption).toContain(selector)
    const block = cssBlock(runtimeAdoption, selector)
    expect(block).toContain('border-color: var(--border-strong) !important;')
    expect(runtimeAdoption).not.toContain("html[data-theme='light'][data-family='mono'] :is(.mind-project-card, .drawer-project-card, .proj-card, .pr-card, .note-card, .entity-sticker, .fc-card, .folder-card)[data-runtime-proxy-content='true'] {")
  })

  it('Mono 画布项目卡 landing 使用实色项目卡材质并移除抓取玻璃', () => {
    const selector = "html[data-family='mono'] :is(.mind-project-card, .drawer-project-card, .proj-card, .pr-card)[data-runtime-proxy-content='true'][data-runtime-phase='landing']"
    expect(runtimeAdoption).toContain(selector)
    const block = cssBlock(runtimeAdoption, selector)
    expect(block).toContain('background: var(--surface-card-solid) !important;')
    expect(block).toContain('border-color: var(--project-card-border) !important;')
    expect(block).toContain('backdrop-filter: none !important;')
  })

  it('画布跨 Surface landing 保留目标内容交叉淡化，不关闭 target morph', () => {
    const start = runtimeSetup.indexOf('const registerMindObjectType')
    const end = runtimeSetup.indexOf('registerMindObjectType(MIND_CANVAS_OBJECT_TYPE)')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(runtimeSetup.slice(start, end)).not.toContain('disableTargetVisualMorph')
  })

  it('画布 landing 在指针下揭示时只抑制一次 hover，离开后恢复', () => {
    expect(runtimeAdoption).toContain(".mind-project-card[data-runtime-hover-suppressed='true']:hover")
    expect(runtimeAdoption).toContain('transform: none;')
    expect(runtimeAdoption).toContain('box-shadow: var(--project-card-shadow);')
    expect(mindRuntimeObject).toContain('suppressHoverUntilLeave(element)')
    expect(mindRuntimeObject).toContain("element.addEventListener('pointerleave', onLeave, { once: true })")
  })

  it('项目名输入框不再有 project 专属透明底，统一复用共享 input contract', () => {
    expect(formsAdoption).toContain('.header-name-input,')
    expect(projectAdoption).not.toContain('.proj-header .header-name-input')
    expect(projectAdoption).toContain('Project title paint is intentionally not overridden here')
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

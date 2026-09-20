// @vitest-environment node
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
const folderPresentation = load('../../composables/files/useFileLibraryFolderPresentation.ts')
const fileCard = load('../../components/common/file-browser/FileCard.vue')
const fileToolbar = load('./file-toolbar-theme-refinements.css')
const componentRefinements = load('./component-theme-refinements.css')
const componentSurfaces = load('./tokens/components/surfaces.css')
const productCss = load('./tokens/product.css')
const surfacesAdoption = load('./adoption/surfaces.css')
const interactiveSurfaceFixes = load('./tokens/interactive-surface-fixes.css')
const formsAdoption = load('./adoption/forms.css')
const projectAdoption = load('./adoption/project.css')
const closeButton = load('../../components/common/overlays/CloseButton.vue')
const runtimeAdoption = load('./adoption/runtime.css')
const browserPanel = load('../../components/common/file-browser/FileBrowserPanel.vue')
const browserToolbar = load('../../components/common/file-browser/FileBrowserToolbar.vue')
const renameInput = load('../../components/common/file-browser/RenameInput.vue')
const filesGridView = load('../../views/Files/components/FilesGridView.vue')
const projectFilesPanel = load('../../views/Projects/components/ProjectFilesPanel.vue')
const filesCss = load('./components/files.css')
const sharedForms = load('./components/forms.css')
const projectToolbar = load('../../views/Projects/components/ProjectFileToolbar.vue')
const filesListView = load('../../views/Files/components/FilesListView.vue')
const filesListRows = load('./filesListRows.css')
const fileSelectionCheckbox = load('./fileSelectionCheckbox.css')
const uploadGhost = load('../../components/common/file-browser/FileUploadGhostCard.vue')
const boxSelection = load('../../composables/shared/useBoxSelection.ts')
const segmentedControl = load('../../components/common/controls/SegmentedControl.vue')
const runtimeSetup = load('../../interaction/runtime/setup.ts')
const mindRuntimeObject = load('../../composables/mind/useMindRuntimeObject.ts')

describe('文件浏览 0.20.4 视觉回归契约', () => {
  it('网格重命名输入可选中文本，透明悬浮层不会抢占文件名点击区域', () => {
    expect(renameInput).toContain('@pointerdown.stop @mousedown.stop @click.stop')
    expect(filesGridView).toContain('<RenameInput v-if="renamingFileId === f.id"')
    expect(renameInput).toContain('rename-file-name-input')
    expect(renameInput).toContain('rename-file-extension-input')
    expect(renameInput).toContain('rename-segment-field rename-file-name-field')
    expect(renameInput).toContain('rename-segment-field rename-file-extension-field')
    expect(renameInput).toContain('rename-segment-dot')
    expect(filesCss).toContain('user-select: text;')
    expect(filesCss).toContain('.fc-name:has(.rename-input-inline) .rename-sizer')
    expect(filesGridView).toContain('top:8px; right:8px;')
    expect(filesGridView).toContain('pointer-events:none;')
    expect(filesGridView).toContain('pointer-events:auto;')
    expect(filesCss).toContain('.fc-name:has(.rename-input-inline),\n.fd-name:has(.rename-input-inline),\n.fc-name:has(.rename-sizer--segmented),\n.fd-name:has(.rename-sizer--segmented) { overflow: visible; text-overflow: clip; }')
    expect(filesCss).toContain('display: block; width: 100%; max-width: 100%; min-width: 0; z-index: 3;')
    expect(filesCss).not.toContain('width: calc(100% + 13px)')
  })

  it('文件名与后缀各自拥有独立输入框，后缀框保持紧凑宽度', () => {
    const segmentedRoot = cssBlock(filesCss, '.rename-sizer--segmented {')
    const renameSizer = cssBlock(filesCss, '.rename-sizer {')
    const sharedRenameInput = cssBlock(filesCss, '.rename-input-inline {')
    const segmentField = cssBlock(filesCss, '.rename-segment-field {')
    const renameSurface = cssBlock(surfacesAdoption, 'html[data-theme][data-family] .rename-input-inline {')
    const renameHover = cssBlock(surfacesAdoption, '.rename-input-inline:hover {')
    const renameFocus = cssBlock(surfacesAdoption, '.rename-input-inline:focus {')
    expect(segmentedRoot).not.toContain('border:')
    expect(segmentedRoot).not.toContain('background:')
    expect(segmentedRoot).toContain('height: 1lh;')
    expect(renameSizer).not.toContain('height: 1lh;')
    expect(sharedRenameInput).not.toContain('appearance: none;')
    expect(sharedRenameInput).toContain('border: 1px solid var(--rename-input-border);')
    expect(sharedRenameInput).toContain('border-radius: var(--rename-input-radius);')
    expect(sharedRenameInput).toContain('inset: 0;')
    expect(sharedRenameInput).not.toContain('height: 100%;')
    expect(sharedRenameInput).toContain('font: inherit;')
    expect(sharedRenameInput).not.toContain('line-height: normal;')
    expect(filesCss).not.toContain('.rename-sizer--segmented .rename-input-inline')
    expect(sharedForms).toContain('line-height: var(--line-height-body);')
    expect(renameSurface).toContain('border-color: var(--input-border);')
    expect(surfacesAdoption).toContain('.rename-input-inline:hover')
    expect(surfacesAdoption).toContain('border-color: var(--input-border-hover);')
    expect(surfacesAdoption).toContain('.rename-input-inline:focus')
    expect(surfacesAdoption).toContain('border-color: var(--input-border-focus);')
    expect(renameHover).toContain('box-shadow: var(--input-hover-shadow);')
    expect(renameFocus).toContain('box-shadow: var(--input-focus-shadow);')
    expect(load('./tokens/components/surfaces.css')).not.toContain('--rename-input-line-height:')
    expect(segmentField).toContain('height: 100%;')
    expect(filesCss).not.toContain('.rename-segment-field::after')
    expect(filesCss).not.toContain('.rename-sizer:focus-within::after')
    expect(renameInput.match(/class="rename-input-inline rename-file-/g)).toHaveLength(2)
    expect(renameInput).not.toContain('rename-segment-input')
    expect(formsAdoption.match(/\.rename-input-inline/g)).toHaveLength(4)
    expect(surfacesAdoption.match(/\.rename-input-inline/g)).toHaveLength(3)
    expect(filesCss).toContain('.rename-file-extension-field { flex: 0 0 5ch; width: 5ch; }')
    expect(filesCss).toContain('.rename-file-extension-input { text-align: center; }')
  })

  it('文件夹与文件 rename 保留完整下伸字形且绝对定位不撑高卡片', () => {
    const sizerRenameInput = cssBlock(filesCss, '.rename-sizer .rename-input-inline {')
    const sharedRenameInput = cssBlock(filesCss, '.rename-input-inline {')
    expect(sizerRenameInput).toContain('line-height: inherit;')
    expect(sizerRenameInput).toContain('top: -1px; bottom: -1px;')
    expect(sizerRenameInput).not.toContain('line-height: 1.15;')
    expect(sharedRenameInput).toContain('position: absolute;')
    expect(filesCss).toContain('.rename-ghost {')
    expect(cssBlock(filesCss, '.rename-ghost {')).toContain('display: block; visibility: hidden; white-space: pre;')
    expect(sizerRenameInput).not.toMatch(/(?:^|[;{\s])height\s*:/)
  })

  it('共享重命名输入框自动聚焦与失焦提交会给标准焦点过渡留出时间', () => {
    expect(renameInput).toContain('window.requestAnimationFrame(() => nameInputRef.value?.focus())')
    expect(renameInput).toContain('@focusin="onFocusIn" @focusout="onFocusOut"')
    expect(renameInput).toContain("getPropertyValue('--motion-hover-control')")
    expect(renameInput).toContain('window.setTimeout(() => {')
    expect(renameInput).toContain('window.clearTimeout(focusOutTimer)')
    expect(filesCss).toContain('border-color var(--motion-hover-control) var(--motion-ease-standard),')
    expect(filesCss).toContain('box-shadow var(--motion-hover-control) var(--motion-ease-standard);')
  })

  it('项目文件夹网格和列表重命名都复用自动聚焦并全选的输入组件', () => {
    const folderRenameInput = '<RenameInput v-if="renamingFolderId === folder.id" v-model="folderRenameText"'
    expect(projectFilesPanel.split(folderRenameInput)).toHaveLength(3)
    expect(projectFilesPanel).toContain('@commit="commitFolderRename" @cancel="cancelFolderRename" />')
    expect(projectFilesPanel).not.toContain('<input class="rename-input-inline" v-model="folderRenameText"')
  })

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

  it('普通文件夹图标跟随当前主题操作色，语义目录继续保留专属颜色', () => {
    expect(folderPresentation).toContain("return 'var(--action-primary)'")
    expect(folderPresentation).toContain("if (folder.type === 'trash') return '#987070'")
    expect(folderPresentation).toContain("if (folder.type === 'status') return STATUS_COLOR")
  })

  it('文件卡 hover/图片预框选不会覆盖 selected，亮色 full-card preview 由 FileCard 自己统一拥有', () => {
    expect(fileCard).toContain('.fc-card:hover:not(.selected):not(.pre-selected)')
    expect(fileCard).toContain('.fc-card.pre-selected:not(.selected) .fc-thumb-area::after')
    expect(fileCard).toContain('var(--file-card-preselection-thumb-overlay)')
    // 亮色预选不再由主题层复制 selector，FileCard 自己消费亮色 token 并拥有状态 paint。
    expect(fileCard).toContain('.fc-card.pre-selected:not(.selected) {')
    expect(fileCard).not.toContain(":global(html[data-theme='light'][data-family] .project-modal-root)")
    expect(componentRefinements).toContain("html[data-theme='dark'][data-family] :is(.files-page, .project-modal-root) .fc-card.pre-selected:not(.selected)")
    expect(componentRefinements).not.toContain('html[data-theme][data-family] .fc-card:hover {')
    expect(componentRefinements).not.toContain('html[data-theme][data-family] .fc-card::after,')
    expect(fileCard).toContain('linear-gradient(to bottom, black 72%, transparent 100%)')
    expect(componentRefinements).toContain('background: color-mix(in srgb, var(--status-danger) 20%, var(--surface-card-solid));')
  })

  it('亮色文件卡 hover 使用高光覆盖，不被调色板主色压暗', () => {
    expect(componentSurfaces).toContain('--file-card-hover-overlay: color-mix(in srgb,var(--theme-highlight-hover) 16%,transparent);')
    expect(componentSurfaces).toContain('--file-card-hover-overlay: color-mix(in srgb,var(--action-primary) 6%,transparent);')
  })

  it('20.4 selected ring 在 hover 时保持，generic hover utility 不再拥有 File/FolderCard shadow/transition', () => {
    expect(fileCard).toContain('.fc-card.selected {')
    expect(fileCard).toContain('box-shadow: var(--file-card-shadow-selected);')
    expect(filesGridView).not.toContain('class="hover-card-fx"')
    expect(productCss).toContain('.hover-card-fx:not(.fc-card):not(.folder-card):hover')
    expect(productCss).not.toContain('html[data-theme][data-family] .hover-card-fx:hover { box-shadow:')
    expect(componentRefinements).toContain('.hover-card-fx:not(.fc-card):not(.folder-card):not(.note-card),')
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

  it('画布文件卡静止态使用不透明卡片底色，不透出画布渐变', () => {
    const canvasMode = cssBlock(fileCard, '.fc-card.canvas-mode')
    expect(canvasMode).toContain('background: var(--surface-canvas-card);')
    expect(canvasMode).not.toContain('background: var(--file-card-bg);')
    expect(load('./tokens/semantic.css')).toContain('--surface-canvas-card: var(--theme-chat-main-bg);')
  })

  it('画布文件卡 hover 保持不透明底色，同时沿用共享 hover 边框与阴影', () => {
    const canvasHover = cssBlock(fileCard, '.fc-card.canvas-mode:hover:not(.selected):not(.pre-selected)')
    expect(canvasHover).toContain('background: var(--surface-canvas-card);')
    expect(canvasHover).not.toContain('border-color:')
    expect(canvasHover).not.toContain('box-shadow:')
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

  it('共享弹窗关闭按钮使用一致且可见的主题 surface，旧弹窗 paint 规则已移除', () => {
    expect(projectAdoption).toContain("html[data-theme='light'][data-family] .project-modal-root .stages-section .node-circle")
    expect(projectAdoption).toContain("html[data-theme='light'][data-family] .project-modal-root .stages-section .todo-check")
    expect(projectAdoption).toContain("html[data-theme='light'][data-family] .project-modal-root .stages-section .todo-add-btn")
    expect(closeButton).toContain('background: var(--surface-card-solid);')
    expect(closeButton).toContain('border: 1px solid var(--content-divider);')
    expect(closeButton).toContain('background: var(--surface-glass-hover);')
    expect(projectAdoption).not.toContain('.proj-close-btn')
    for (const stylesheet of [surfacesAdoption, projectAdoption, fileToolbar, interactiveSurfaceFixes]) {
      expect(stylesheet).not.toContain('.close-btn')
    }
  })
})

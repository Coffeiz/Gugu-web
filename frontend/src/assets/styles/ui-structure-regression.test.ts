import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function load(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

function cssBlock(source: string, selector: string) {
  const start = source.indexOf(selector)
  if (start < 0) throw new Error(`Missing selector: ${selector}`)
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open)
  if (open < 0 || close < 0) throw new Error(`Malformed block: ${selector}`)
  return source.slice(open + 1, close)
}

const filesView = load('../../views/Files/index.vue')
const projectModal = load('../../views/Projects/components/ProjectModal.vue')
const floatPreview = load('../../components/common/FloatPreviewWindow.vue')
const popovers = load('./adoption/popovers.css')
const themeRefinements = load('./theme-refinements.css')
const appSidebar = load('../../components/common/AppSidebar.vue')
const chatSidebar = load('../../components/common/gugu-chat/GuguChatSidebar.vue')
const chatIm = load('../../components/common/gugu-chat/GuguChatImConnect.vue')
const interactionRefinements = load('./tokens/interaction-refinements.css')
const doneColumn = load('../../views/Projects/components/DoneColumn.vue')
const doneGroup = load('../../views/Projects/components/done/DoneGroup.vue')
const archivedProjects = load('../../views/Projects/components/ArchivedProjectsModal.vue')
const uploadModal = load('../../views/Files/UploadModal.vue')
const canvasSidebar = load('../../views/Mind/components/CanvasSidebar.vue')
const systemLogs = load('../../views/Admin/SystemLogs/index.vue')
const analyticsUsage = load('../../views/Admin/Analytics/Usage.vue')
const trashView = load('../../views/Files/components/FilesTrashView.vue')
const popupMenu = load('../../components/common/PopupMenu.vue')
const profileImPane = load('../../components/common/ProfileModal/ProfileImPane.vue')
const canvasToolbar = load('../../views/Mind/components/CanvasToolbar.vue')
const noteEditor = load('../../views/Mind/components/NoteEditor.vue')
const eventEditModal = load('../../components/events/EventEditModal.vue')
const contextMenu = load('../../components/ContextMenu.vue')
const dateSpanPicker = load('../../components/common/DateSpanPicker.vue')
const projectCard = load('../../views/Projects/components/ProjectCard.vue')
const sortMenu = load('../../components/common/SortMenu.vue')
const datePicker = load('../../components/common/DatePicker.vue')
const adminDatePicker = load('../../components/AdminDatePicker.vue')
const calendarMorePopup = load('../../views/Calendar/components/CalendarMorePopup.vue')
const calendarView = load('../../views/Calendar/index.vue')

describe('导航 / popup / disclosure 结构回归契约', () => {
  it('轻量弹层统一经过 PopupMenu，业务组件不再持有独立 Teleport 动画', () => {
    expect(popupMenu).toContain('<Teleport to="body">')
    expect(popupMenu).toContain('<Transition name="menu-pop"')
    expect(popupMenu).toContain('<div v-if="show" ref="popupRef"')
    expect(popupMenu).not.toContain('<div v-show="show" ref="popupRef"')
    expect(popupMenu).toContain('registerPopover')
    expect(profileImPane).toContain('PopupMenu')
    expect(profileImPane).toContain('popup-class="pm-help-popup-host"')
    expect(canvasToolbar).toContain('popup-class="note-picker-host"')
    expect(noteEditor).toContain('popup-class="ne-picker-host"')
    expect(canvasToolbar).not.toContain('<Transition name="note-picker"')
    expect(noteEditor).not.toContain('<Teleport to="body">\n      <div v-if="picker.open"')
  })

  it('弹层关闭入口共用单一离场生命周期，防止重复动画与内容塌缩', () => {
    expect(popupMenu).toContain("<Transition name=\"menu-pop\" @before-leave=\"raiseLeaveLayer\" @after-leave=\"emit('after-leave')\">")
    expect(popupMenu).toContain("const emit = defineEmits<{ 'after-leave': [] }>()")
    expect(popupMenu).toContain("node.style.zIndex = '100001'")
    expect(popupMenu).toContain('function setPopupZ(z: number)')
    expect(popupMenu).toContain('popupRef.value.style.zIndex = String(z)')

    // 活动浮窗离场期间保留表单，直到公共 PopupMenu 完成 after-leave。
    expect(eventEditModal).toContain('const floatingLeaving = ref(false)')
    expect(eventEditModal).toContain('@after-leave="onFloatingLeave"')
    expect(eventEditModal).toContain('if (event.value && popupStillVisible) floatingLeaving.value = true')
    expect(eventEditModal).toContain("target.closest('.overflow-popup, .overflow-item')")
    expect(eventEditModal).not.toContain("watch(show, (value, previous) => { if (!value && previous) probeFloatingAnimation() })")

    // ContextMenu 不得用延迟 setTimeout 注册旧 outside listener，避免关闭后下一次点击补触发离场。
    expect(contextMenu).toContain('let openCycle = 0')
    expect(contextMenu).toContain('if (!props.show || cycle !== openCycle) return')
    expect(contextMenu).not.toContain('setTimeout(() => document.addEventListener')

    // 日期范围弹层只有 PopupMenu 根节点绘制 surface，不再套一层 drp-popup 视觉容器，
    // 且不得重复注册 windowz popover。
    expect(dateSpanPicker).toContain('popup-class="drp-popup-host drp-popup"')
    expect(dateSpanPicker).not.toContain('<div class="drp-popup"')
    expect(dateSpanPicker).not.toContain('registerPopover')

    // 项目 Todo 与文件排序继续通过公共 PopupMenu/ContextMenu，不引入第二套 Transition。
    expect(projectCard).toContain('popup-class="todo-pop-popup"')
    expect(projectCard).not.toContain('<Transition name="todo-pop"')
    expect(sortMenu).toContain('<ContextMenu :show="sortMenuOpen"')
    expect(sortMenu).toContain('r.left + r.width / 2 - 80')
    expect(sortMenu).not.toContain('<Transition')
    expect(contextMenu).toContain(':global(.ctx-menu) {\n  width: 160px;\n  min-width: 160px;\n  box-sizing: border-box;\n}')

    // 日期弹层及其年份子弹层必须各自只有一个 PopupMenu 根，不能再套重复 surface。
    expect(datePicker).toContain('<PopupMenu :show="open"')
    expect(datePicker).toContain('popup-class="dp-popup-host"')
    expect(datePicker).not.toContain('popup-menu-dark')
    expect(adminDatePicker).toContain('<PopupMenu :show="show"')
    expect(adminDatePicker).toContain('popup-class="adp-popup-host"')
    expect(adminDatePicker).toContain('popup-class="adp-year-popup-host"')
    expect(adminDatePicker).not.toContain('<div class="adp-popup popup-menu-dark"><div class="adp-popup"')

    // 已由 PopupMenu 根节点统一绘制 surface，业务内容只保留布局，不得重新声明第二层背景/边框。
    expect(projectCard).not.toContain('background: var(--popup-surface-bg)')
    expect(eventEditModal).not.toContain('background: var(--popup-surface-bg)')
    expect(eventEditModal).toContain('border-radius: var(--event-popup-radius)')
    expect(calendarMorePopup).not.toContain('background: var(--panel-bg)')
    expect(calendarMorePopup).not.toContain('backdrop-filter: var(--popup-blur)')
    expect(calendarView).toContain('const morePopupAnchor = ref<HTMLElement | null>(null)')
    expect(calendarView).toContain('if (morePopup.value.open && morePopupAnchor.value === anchor)')
    expect(calendarView).toContain("!target.closest('.chip-more-btn, .wv-more')")
    expect(calendarView).toContain('// 编辑活动与“更多”面板允许并存')
    const moreEditHandler = calendarView.match(/function onMoreEditEvent\([\s\S]*?\n\}/)?.[0] ?? ''
    expect(moreEditHandler).not.toContain('closeMorePopup()')
  })

  it('文件库与项目编辑卡目录导航都直接切状态，不创建跨目录 Presence/FLIP 离场', () => {
    expect(filesView).toContain('function withDirectNav(mutate: () => void): void')
    expect(filesView).toContain('withDirectNav(() => rawEnterFolder(folder))')
    expect(filesView).toContain('withDirectNav(() => rawNavigateTo(idx))')
    expect(filesView).toContain('withDirectNav(() => rawGoBack())')
    expect(filesView).toContain('withDirectNav(() => rawGoForward())')
    expect(filesView).not.toContain('createVueRuntimeAdapter')
    expect(filesView).not.toContain('runLayoutMutation')
    expect(filesView).not.toContain('withLayoutNav')
    expect(filesView).toContain('不做交叉淡化或 Presence 离场')

    expect(projectModal).toContain('function withPmDirectNav(mutate: () => void): void')
    expect(projectModal).toContain('withPmDirectNav(() => pmEnterFolder(folder))')
    expect(projectModal).toContain('withPmDirectNav(() => pmNavigateTo(idx))')
    expect(projectModal).toContain('withPmDirectNav(() => pmGoBack())')
    expect(projectModal).toContain('withPmDirectNav(() => pmGoForward())')
    expect(projectModal).not.toContain('createVueRuntimeAdapter')
    expect(projectModal).not.toContain('domAdapter.runLayoutMutation')
    expect(projectModal).not.toContain('async function withPmLayoutNav')
  })

  it('浮动预览拖动四边共用 125% 虚拟视口边界', () => {
    expect(floatPreview).toContain('const DRAG_OVERSCAN_RATIO = .25')
    expect(floatPreview).toContain('const minX = -overscanX')
    expect(floatPreview).toContain('const minY = -overscanY')
    expect(floatPreview).toContain('window.innerWidth + overscanX - w.value')
    expect(floatPreview).toContain('window.innerHeight + overscanY - h.value')
    expect(floatPreview).toContain('x.value = clamp(nextX, minX, maxX)')
    expect(floatPreview).toContain('y.value = clamp(nextY, minY, maxY)')
    expect(floatPreview).not.toContain('x.value = Math.max(0, dragOrig.x')
    expect(floatPreview).not.toContain('y.value = Math.max(0, dragOrig.y')
  })

  it('settings-popup 保持原组件视觉，Mono/暗色只映射 token 且 danger hover 只有一层', () => {
    const settings = cssBlock(appSidebar, '.settings-popup {')
    expect(settings).toContain('background:var(--settings-popup-bg,rgba(255,255,255,.44))')
    expect(settings).toContain('border:1px solid var(--settings-popup-border,rgba(255,255,255,.72))')
    expect(settings).toContain('box-shadow:var(--settings-popup-shadow,')
    expect(settings).toContain('backdrop-filter:var(--popup-surface-blur)')
    expect(appSidebar).toContain('<Teleport to="body">')
    expect(appSidebar).toContain(':style="settingsStyle"')

    expect(appSidebar).toContain('class="settings-menu-item"')
    expect(appSidebar).toContain('class="settings-menu-item danger"')
    expect(appSidebar).toContain('class="settings-menu-sep"')
    expect(appSidebar).not.toContain('class="popup-menu-item')
    expect(appSidebar).not.toContain('class="popup-menu-sep')
    expect(appSidebar).toContain('background:var(--settings-popup-hover-bg,rgba(255,255,255,.55))')
    expect(appSidebar).toContain('background:var(--settings-popup-danger-hover-bg,rgba(200,90,90,.1))')
    expect(appSidebar).toContain('.settings-menu-item:hover:not(:disabled) { background:transparent; }')

    // Generic popup adoption must never match settings surface/items or its original popup animation.
    expect(popovers).not.toContain('.settings-popup')
    expect(popovers).not.toContain('.popup-enter-active')
    expect(popovers).not.toMatch(/:is\(\.popup-menu-item/)

    const dark = cssBlock(themeRefinements, "html[data-theme='dark'][data-family]")
    expect(dark).toContain('--settings-popup-border: var(--border-default);')
    expect(dark).toContain('--settings-popup-hover-bg: var(--color-accent-faint);')
    const monoLight = cssBlock(themeRefinements, "html[data-theme='light'][data-family='mono']")
    expect(monoLight).toContain('--settings-popup-bg: var(--surface-card-solid);')
    expect(monoLight).toContain('--settings-popup-border: var(--border-strong);')
    expect(monoLight).toContain('--settings-popup-hover-bg: var(--surface-soft-hover);')
    const monoDark = cssBlock(themeRefinements, "html[data-theme='dark'][data-family='mono']")
    expect(monoDark).toContain('--settings-popup-bg: var(--surface-card-solid);')
    expect(monoDark).toContain('--settings-popup-border: var(--border-strong);')

    // Theme layer may remap variables only; it must not become a second final-paint owner.
    expect(themeRefinements).not.toMatch(/html\[data-theme[^\n]*\]\s+\.settings-popup\s*\{/)
  })

  it('GuguChat IM 与普通 session 共用 2px 节奏且没有树形左缩进', () => {
    const sessionList = cssBlock(chatSidebar, '.exp-session-list {')
    expect(sessionList).toContain('gap: 2px;')

    expect(cssBlock(chatIm, '.im-plat-group {')).toContain('gap:2px;')
    expect(cssBlock(chatIm, '.im-plat {')).toContain('gap:2px;')
    expect(cssBlock(chatIm, '.im-plat-body {')).toContain('gap:2px;')
    expect(chatIm).not.toContain('margin-left')

    // hover/motion 只由全局 interaction contract 负责；活动项通过局部 token 保持 selected surface。
    expect(chatSidebar).not.toContain(':deep(.exp-session-item:hover) {')
    expect(interactionRefinements).toContain('html[data-theme][data-family] .exp-session-item:hover {')
    const active = cssBlock(chatSidebar, ':deep(.exp-session-item.active) {')
    expect(active).toContain('--gugu-chat-session-hover: var(--gugu-chat-session-active);')
    expect(active).toContain('--sidebar-item-hover: var(--gugu-chat-session-active);')
  })

  it('项目已完成年组引导线与箭头中心严格对齐，并给月组保留安全间距', () => {
    const root = cssBlock(doneColumn, '.done-col {')
    expect(root).toContain('--done-year-chevron-center:10px')
    expect(root).toContain('--done-year-content-indent:20px')

    const folder = cssBlock(doneColumn, '.done-col .year-folder {')
    expect(folder).toContain('position:relative')
    expect(folder).toContain('padding:0 0 0 var(--done-year-content-indent)')
    expect(folder).not.toContain('border-left')

    const guide = cssBlock(doneColumn, '.done-col .year-folder::before {')
    expect(guide).toContain("content:''")
    expect(guide).toContain('left:var(--done-year-chevron-center)')
    expect(guide).toContain('transform:translateX(-50%)')
    expect(guide).toContain('width:1px')
    expect(guide).toContain('background:var(--done-group-border)')
  })

  it('内容 disclosure 统一为收起向右、展开向下', () => {
    // 已完成年组与月组统一使用 FlipChevron 组件。
    expect(doneGroup).toContain('FlipChevron :open="group.open"')
    expect(doneGroup).toContain('FlipChevron :open="isUndatedOpen"')
    expect(doneGroup).toContain('FlipChevron :open="group.open" :size="8"')
    // FlipChevron 自带旋转动画，DoneColumn 不再有 .year-chev/.month-chev CSS。

    expect(archivedProjects).toContain('transform: rotate(-90deg);')
    expect(archivedProjects).toContain('.year-chev.open { transform: rotate(0deg); }')
    expect(archivedProjects).toContain('.month-chev.open { transform: rotate(0deg); }')

    expect(uploadModal).toContain('.toggle-chev, .year-chev, .month-chev')
    expect(uploadModal).toContain('transform:rotate(-90deg)')
    expect(uploadModal).toContain('.toggle-chev.open, .year-chev.open, .month-chev.open { transform: rotate(0deg); }')

    expect(chatIm).toContain('.im-plat-chev {')
    expect(chatIm).toContain('transform:rotate(-90deg)')
    expect(chatIm).toContain('.im-plat-chev.open { transform:rotate(0deg); }')

    expect(canvasSidebar).toContain('.project-group-chevron {')
    expect(canvasSidebar).toContain('transform: rotate(-90deg)')
    expect(canvasSidebar).toContain('.project-group-chevron.open { transform: rotate(0deg); }')

    expect(systemLogs).toContain('transform: rotate(-90deg)')
    expect(systemLogs).toContain('.expand-icon.open { transform: rotate(0deg);')

    expect(analyticsUsage).toContain('.expand-btn svg { transform: rotate(-90deg);')
    expect(analyticsUsage).toContain('.expand-btn svg.open { transform: rotate(0deg); }')

    expect(trashView).toContain('<FlipChevron :open="expandedTrashFolders.has(folder.id)" :size="8" />')
    expect(trashView).toContain('.trash-folder-contents[data-layout-open="false"]')
    expect(trashView).toContain('.trash-folder-contents::before')
  })
})

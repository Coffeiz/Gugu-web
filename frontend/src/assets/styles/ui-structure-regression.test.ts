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
const popovers = load('./adoption/popovers.css')
const themeRefinements = load('./theme-refinements.css')
const appSidebar = load('../../components/common/AppSidebar.vue')
const chatSidebar = load('../../components/common/gugu-chat/GuguChatSidebar.vue')
const chatIm = load('../../components/common/gugu-chat/GuguChatImConnect.vue')
const interactionRefinements = load('./tokens/interaction-refinements.css')
const doneColumn = load('../../views/Projects/components/DoneColumn.vue')
const archivedProjects = load('../../views/Projects/components/ArchivedProjectsModal.vue')
const uploadModal = load('../../views/Files/UploadModal.vue')
const canvasSidebar = load('../../views/Mind/components/CanvasSidebar.vue')
const systemLogs = load('../../views/Admin/SystemLogs/index.vue')
const analyticsUsage = load('../../views/Admin/Analytics/Usage.vue')
const trashView = load('../../views/Files/components/FilesTrashView.vue')

describe('导航 / popup / disclosure 结构回归契约', () => {
  it('文件目录导航只做直接状态切换，不再创建跨目录 Presence/FLIP 离场', () => {
    expect(filesView).toContain('function withDirectNav(mutate: () => void): void')
    expect(filesView).toContain('withDirectNav(() => rawEnterFolder(folder))')
    expect(filesView).toContain('withDirectNav(() => rawNavigateTo(idx))')
    expect(filesView).toContain('withDirectNav(() => rawGoBack())')
    expect(filesView).toContain('withDirectNav(() => rawGoForward())')
    expect(filesView).not.toContain('createVueRuntimeAdapter')
    expect(filesView).not.toContain('runLayoutMutation')
    expect(filesView).not.toContain('withLayoutNav')
    expect(filesView).toContain('不做交叉淡化或 Presence 离场')
  })

  it('settings-popup 只有 popover adoption 负责最终 paint，Mono 只重映射局部 token', () => {
    const monoSettings = cssBlock(popovers, "html[data-family='v2'] .settings-popup")
    expect(monoSettings).toContain('--popup-surface-bg: var(--surface-card-solid);')
    expect(monoSettings).toContain('--popup-surface-highlight: transparent;')
    expect(monoSettings).toContain('--popup-surface-blur: none;')
    expect(monoSettings).not.toMatch(/(?:^|;)\s*(?:background|border(?:-color)?|box-shadow|backdrop-filter)\s*:/)

    const settingsGeometry = cssBlock(appSidebar, '.settings-popup {')
    expect(settingsGeometry).toContain('position: absolute')
    expect(settingsGeometry).not.toMatch(/(?:background|border(?:-color)?|box-shadow|backdrop-filter)\s*:/)
    expect(themeRefinements).not.toMatch(/html\[data-theme='dark'\]\[data-family\]\s+\.settings-popup\s*\{/)
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

  it('项目已完成年组使用独立引导线，不再把 border-left 绑在 year-folder 上', () => {
    const folder = cssBlock(doneColumn, '.done-col .year-folder {')
    expect(folder).toContain('position:relative')
    expect(folder).not.toContain('border-left')

    const guide = cssBlock(doneColumn, '.done-col .year-folder::before {')
    expect(guide).toContain("content:''")
    expect(guide).toContain('left:10.5px')
    expect(guide).toContain('width:1px')
    expect(guide).toContain('background:var(--done-group-border)')
  })

  it('内容 disclosure 统一为收起向右、展开向下', () => {
    expect(doneColumn).toContain('transform:rotate(-90deg)')
    expect(doneColumn).toContain('.done-col .year-chev.open,.done-col .month-chev.open { transform:rotate(0deg); }')

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

    expect(trashView).toContain('.trash-expand-btn svg { transform: rotate(-90deg);')
    expect(trashView).toContain('.trash-expand-btn svg.rotated { transform: rotate(0deg); }')
  })
})

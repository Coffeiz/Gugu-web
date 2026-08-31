import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function load(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

function cssBlock(css: string, selectorNeedle: string) {
  const selectorStart = css.indexOf(selectorNeedle)
  if (selectorStart < 0) throw new Error(`Missing selector: ${selectorNeedle}`)
  const open = css.indexOf('{', selectorStart)
  const close = css.indexOf('}', open)
  if (open < 0 || close < 0) throw new Error(`Malformed CSS block: ${selectorNeedle}`)
  return css.slice(open + 1, close)
}

function occurrences(source: string, needle: string) {
  return source.split(needle).length - 1
}

function cssSelectors(css: string) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...source.matchAll(/([^{}]+)\{/g)]
    .map(match => match[1].trim())
    .filter(Boolean)
}

const mindCss = load('./adoption/mind.css')
const surfacesCss = load('./adoption/surfaces.css')
const datePickerCss = load('./adoption/date-picker.css')
const publicPagesCss = load('./adoption/public-pages.css')
const adoptionIndexCss = load('./adoption/index.css')
const fileToolbarCss = load('./file-toolbar-theme-refinements.css')
const themeAdoptionCss = load('./theme-adoption.css')
const productCss = load('./tokens/product.css')
const runtimeCss = load('./adoption/runtime.css')
const componentCss = load('./tokens/components.css')
const componentSurfacesCss = load('./tokens/components/surfaces.css')
const fileCardVue = load('../../components/common/file-browser/FileCard.vue')
const fileSelectionToolbarVue = load('../../components/common/FileSelectionToolbar.vue')
const filesViewVue = load('../../views/Files/index.vue')
const projectFilesPanelVue = load('../../views/Projects/components/ProjectFilesPanel.vue')
const projectCardVue = load('../../views/Projects/components/ProjectCard.vue')
const eventFormPanelVue = load('../../components/events/EventFormPanel.vue')
const imageViewerVue = load('../../components/common/viewers/ImageViewer.vue')
const primitivesCss = load('./tokens/primitives.css')
const fontsCss = load('./fonts.css')
const paletteFiles = [['aero', 'mist'], ['mono', 'cafe'], ['rose', 'rose'], ['sky', 'sky'], ['sage', 'sage']].map(([file, name]) => ({
  name,
  css: load(`./tokens/palettes/${file}.css`) + load('./tokens/palettes/color-base.css'),
}))
const paletteColorBaseCss = load('./tokens/palettes/color-base.css')
const materialCompositionCss = load('./tokens/themes/material-composition.css')
const themeCss = [
  load('./tokens/themes/glass-light.css'),
  load('./tokens/themes/glass-dark.css'),
  load('./tokens/themes/mono-light.css'),
  load('./tokens/themes/mono-dark.css'),
].join('\n')

const paletteTokens = [
  '--theme-action-primary',
  '--theme-action-hover',
  '--theme-action-pressed',
  '--theme-selection',
  '--theme-focus',
  '--theme-sidebar-active-fg',
  '--theme-success',
  '--theme-warning',
  '--theme-danger',
  '--theme-info',
  '--theme-brand-gradient',
  '--theme-fab-gradient',
  '--theme-brand-logo-color',
  '--theme-brand-logo-filter',
  '--theme-divider',
  '--theme-scrollbar-thumb',
  '--theme-scrollbar-thumb-hover',
]
const notificationBubbleVue = load('../../components/common/NotificationBubble.vue')
const designOverridesCss = load('./design-overrides.css')
const lightPaletteCss = [
  load('./tokens/palettes/aero.css'),
  load('./tokens/palettes/mono.css'),
  load('./tokens/palettes/rose.css'),
  load('./tokens/palettes/sky.css'),
  load('./tokens/palettes/sage.css'),
]
const guguChatVue = load('../../components/common/GuguChat.vue')
const usagePanelVue = load('../../views/Admin/Agent/observability/components/UsagePanel.vue')
const promptPanelVue = load('../../views/Admin/Agent/prompting/components/PromptPanel.vue')
const stateLabelsPanelVue = load('../../views/Admin/Agent/prompting/components/StateLabelsPanel.vue')

describe('主题 CSS 回归契约', () => {
  it('字体资源层与字体族 token 保持单一契约', () => {
    expect((fontsCss.match(/@font-face\s*\{/g) ?? [])).toHaveLength(1)
    expect(fontsCss).toContain("font-family: 'Gugu Noto Sans SC';")
    expect(fontsCss).toContain('Noto_Sans_SC/NotoSansSC-VariableFont_wght.ttf')
    expect(fontsCss).toContain('font-weight: 100 900;')
    expect(primitivesCss).toContain('--font-family-body: "Gugu Noto Sans SC", var(--font-system-sans);')
    expect(primitivesCss).toContain('--font-family-ui: var(--font-family-body);')
    expect(primitivesCss).toContain('--font-family-heading: var(--font-family-body);')
    expect(primitivesCss).toContain('--font-family-mono: var(--font-system-mono);')
    expect(primitivesCss).toContain('--font-sans: var(--font-family-ui);')
    expect(primitivesCss).toContain('--font-mono: var(--font-family-mono);')
  })

  it('每套配色提供完整的明暗语义色，family 不再重复持有配色变量', () => {
    for (const { name, css } of paletteFiles) {
      expect(css, `${name} palette`).toContain(`data-palette='${name}'`)
      expect(css, `${name} palette`).toContain("data-theme='light'")
      expect(css, `${name} palette`).toContain("data-theme='dark'")
      for (const token of paletteTokens) {
        expect(css, `${name} palette missing ${token}`).toContain(`${token}:`)
      }
    }
    for (const token of paletteTokens) {
      expect(themeCss, `family owns ${token}`).not.toContain(`${token}:`)
    }
  })

  it('面板颜色与视觉材质分层，palette 改色不吞掉 family 效果', () => {
    for (const token of [
      '--palette-page-start', '--palette-page-mid', '--palette-page-end', '--palette-surface',
      '--palette-surface-strong', '--palette-surface-raised', '--palette-text-primary',
      '--palette-text-secondary', '--palette-text-tertiary', '--palette-border',
      '--palette-border-strong', '--palette-highlight', '--palette-scrim',
    ]) {
      expect(paletteColorBaseCss, `palette color base missing ${token}`).toContain(`${token}:`)
    }
    expect(materialCompositionCss).toContain("[data-family='glass'][data-theme='light']")
    expect(materialCompositionCss).toContain('var(--palette-surface)')
    expect(materialCompositionCss).toContain('var(--palette-page-start)')
    expect(materialCompositionCss).toContain(":root[data-family='mono'][data-theme='light']")
    expect(materialCompositionCss).toContain(":root[data-family='mono'][data-theme='dark']")
    expect(materialCompositionCss).toContain(":not([data-palette='cafe'])")
    expect(materialCompositionCss).not.toMatch(/--theme-(shadow|blur|radius)\s*:/)
    expect(load('./tokens/themes/mono-light.css')).toContain("--theme-border-strong: rgba(42,35,49,.15)")
    expect(load('./tokens/themes/mono-dark.css')).toContain("--theme-border-strong: rgba(255,255,255,.145)")
  })

  it('通知气泡暗色不继承亮色纯白高光，亮色实体样式保持唯一', () => {
    const darkEdge = cssBlock(notificationBubbleVue, ":global(html[data-theme='dark'][data-family] .nb-item)")
    expect(darkEdge).toContain('--nb-border: var(--border-default)')
    expect(darkEdge).toContain('--nb-highlight-top: var(--highlight-soft)')
    expect(darkEdge).toContain('--nb-highlight-side: var(--highlight-muted)')
    expect(notificationBubbleVue).toContain('--nb-highlight-top: rgba(255,255,255,0.9)')
    expect(notificationBubbleVue).not.toMatch(/:global\(html\[data-theme='dark'\]\[data-family\][^)]*\)[^{]*\{[^}]*rgba\(255,255,255/i)
  })

  it('项目卡不再拥有重复的伪元素内描边', () => {
    const projectCardVue = load('../../views/Projects/components/ProjectCard.vue')
    expect(projectCardVue).not.toContain('.proj-card::after')
    expect(projectCardVue).not.toContain('.proj-card::before')
    expect(themeAdoptionCss).not.toContain('.proj-card::after')
    expect(themeAdoptionCss).not.toContain('.proj-card::before')
    expect(productCss).not.toContain('.proj-card::after')
    expect(productCss).not.toContain('.proj-card::before')
    expect(runtimeCss).not.toContain('.proj-card::after')
    expect(runtimeCss).not.toContain('.proj-card::before')
  })

  it('项目卡最终 paint 只由组件负责，主题层不重复接管根卡片', () => {
    const projectCardVue = load('../../views/Projects/components/ProjectCard.vue')
    expect(projectCardVue).toContain('border: 1px solid var(--project-card-border)')
    expect(projectCardVue).toContain('box-shadow: var(--project-card-shadow)')
    expect(themeAdoptionCss).not.toMatch(/html\[data-theme\]\[data-family\] \.proj-card\s*\{/)
    expect(productCss).not.toMatch(/html\[data-theme\]\[data-family\] \.proj-card\s*\{/)
  })

  it('todo popup 由通用容器负责 surface，业务组件负责内容主题', () => {
    expect(load('../../components/common/PopupMenu.vue')).toContain('background: var(--popup-surface-bg)')
    expect(load('../../components/common/PopupMenu.vue')).toContain('border: 1px solid var(--popup-surface-border)')
    expect(themeAdoptionCss).not.toContain('.todo-pop-popup')
    expect(projectCardVue).toContain('html[data-theme][data-family] .todo-pop-popup')
  })

  it('亮色调色板将导航选中面统一为实体亮面', () => {
    for (const paletteCss of lightPaletteCss) {
      const lightBlock = paletteCss.match(/:root\[data-palette='[^']+'\]\[data-theme='light'\]\s*\{([\s\S]*?)(?:\n| )\}/)?.[1] ?? ''
      expect(lightBlock).toContain('--theme-sidebar-active-bg: var(--theme-card-solid)')
    }
  })

  it('导航选中项直接复用调色板 surface，通知 active paint 不重复', () => {
    expect(load('../../components/common/AppSidebar.vue')).not.toContain('.notif-btn.notif-active {')
    expect(load('../../components/common/NavItem.vue')).not.toContain('.nav-item.active {')
    expect(componentCss).toContain('--sidebar-item-active: var(--theme-sidebar-active-bg, var(--surface-raised))')
    expect(componentSurfacesCss).not.toContain('--sidebar-item-active-light-bg')
    expect(componentSurfacesCss).not.toContain('--sidebar-item-active: var(--sidebar-item-active-light-bg)')
  })

  it('Mono 导航不再被旧 chrome 边框覆盖，Admin 与前台复用同一组选中 token', () => {
    expect(surfacesCss).not.toMatch(/html\[data-family='mono'\] \.sidebar\s*\{/)

    const adminLayoutVue = load('../../layouts/AdminLayout.vue')
    expect(adminLayoutVue).toContain('background: var(--sidebar-bg);')
    expect(adminLayoutVue).toContain('border-right: 1px solid var(--sidebar-border);')
    expect(adminLayoutVue).not.toContain('.nav-item.active {')
    expect(productCss).toContain(':is(.sidebar, .admin-sidebar) .nav-item.active')
    expect(productCss).toContain('background: var(--sidebar-item-active);')
    expect(productCss).toContain('border-color: var(--sidebar-item-active-border);')
    expect(productCss).toContain('box-shadow: var(--sidebar-item-active-shadow);')
  })

  it('组件主题颜色只通过语义 token 注入，Admin 面板不保留重复 scoped 样式块', () => {
    expect(guguChatVue).toContain('background: var(--gugu-chat-user-bg)')
    expect(guguChatVue).toContain('background: var(--gugu-chat-voice-bg)')
    expect(guguChatVue).not.toMatch(/background:\s*(?:linear-gradient|rgba?\(|#[0-9a-f]{3,8})/i)

    for (const source of [usagePanelVue, promptPanelVue, stateLabelsPanelVue]) {
      expect((source.match(/<style scoped>/g) ?? [])).toHaveLength(1)
    }
    expect(componentCss).not.toMatch(/--gugu-chat-(?:assistant-bg|user-highlight|user-shadow):/)
    expect(componentSurfacesCss).toContain('--gugu-chat-assistant-bg:')
  })

  it('暗色咕咕悬浮球以深色表面为主，避免亮色强调色过曝', () => {
    const darkRefinements = load('./tokens/interaction-refinements.css')
    expect(darkRefinements).toContain('--gugu-fab-bg: color-mix(in srgb,var(--surface-raised) 64%,var(--action-primary) 36%)')
  })

  it('暗色 surface hover 只由主题 refinement 负责', () => {
    const interactionCss = load('./tokens/interaction-refinements.css')
    const themeRefinementCss = load('./theme-refinements.css')
    for (const token of [
      '--surface-hover-tint', '--card-hover-overlay', '--calendar-cell-hover-bg',
      '--calendar-weekend-hover-bg', '--calendar-chip-hover-overlay',
      '--calendar-capsule-hover-overlay', '--gugu-chat-session-hover',
    ]) {
      expect(interactionCss, `interaction duplicate ${token}`).not.toContain(`${token}:`)
    }
    expect(themeRefinementCss).toContain('--surface-hover-tint: transparent')
  })

  it('DateSpan 区间内部不叠加普通 hover 背景', () => {
    expect(datePickerCss).toContain(
      '.drp-day:hover:not(.sel-start):not(.sel-end):not(.in-range)',
    )
    const rangeBlock = cssBlock(datePickerCss, 'html[data-theme][data-family] .drp-day.in-range')
    expect(rangeBlock).toContain('background: var(--calendar-range-cell-bg)')
  })

  it('ImageViewer 暗色只重映射 toolbar 局部 token，不复制实体 paint', () => {
    const darkBlock = cssBlock(imageViewerVue, "html[data-theme='dark'][data-family] .iv-wrap")
    expect(darkBlock).toContain('--iv-toolbar-bg:')
    expect(darkBlock).toContain('--iv-toolbar-border: var(--border-strong)')
    expect(darkBlock).toContain('--iv-toolbar-filter: var(--popup-surface-blur)')
    expect(imageViewerVue).not.toContain("html[data-theme='dark'][data-family] .iv-toolbar")
    expect(eventFormPanelVue).toContain('html[data-theme][data-family] .event-form-body')
  })

  it('文件工具栏只有一套尺寸和前景契约', () => {
    expect(occurrences(fileToolbarCss, '--file-toolbar-control-height:')).toBe(1)
    expect(occurrences(fileToolbarCss, '--file-toolbar-icon-size:')).toBe(1)
    expect(occurrences(fileToolbarCss, '--file-toolbar-fg:')).toBe(1)
    expect(fileToolbarCss).toContain('height: var(--file-toolbar-control-height)')
    expect(fileToolbarCss).toContain('width: var(--file-toolbar-icon-size)')
    expect(fileToolbarCss).not.toMatch(/border(?:-color)?\s*:[^;]*(?:#fff\b|white\b|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i)
  })

  it('文件多选工具栏只由共享组件负责 paint，并锚定项目卡非滚动容器', () => {
    const toolbarBlock = cssBlock(fileSelectionToolbarVue, '\n.file-selection-toolbar {')
    expect(toolbarBlock).toContain('background: var(--popup-surface-bg)')
    expect(toolbarBlock).toContain('border: 1px solid var(--popup-surface-border)')
    expect(toolbarBlock).toContain('backdrop-filter: var(--popup-surface-blur)')
    expect(toolbarBlock).toContain('color: var(--content-primary)')
    expect(toolbarBlock).toContain('z-index: var(--layer-popup)')
    expect(fileSelectionToolbarVue).toContain('background: var(--control-bg)')
    expect(fileSelectionToolbarVue).toContain('background: var(--danger-button-bg)')
    expect(fileSelectionToolbarVue).toContain('background: var(--popup-divider)')
    expect(fileSelectionToolbarVue).not.toMatch(/(?:#(?:[0-9a-f]{3,8})\b|rgba?\()/i)
    expect(fileSelectionToolbarVue).not.toContain('!important')
    expect(fileSelectionToolbarVue).not.toContain('file-action-bar')

    // 页面/项目面板不再保留历史批量栏 paint，避免共享组件之外出现第二个 owner。
    expect(filesViewVue).not.toMatch(/\.selection-bar\b/)
    expect(filesViewVue).not.toMatch(/\.sel-(?:count|download-btn|delete-btn|cancel-btn|action-btn|divider)\b/)
    expect(projectFilesPanelVue).not.toMatch(/\.pm-selection-bar\b/)
    expect(projectFilesPanelVue).not.toMatch(/\.pm-sel-/)

    // 项目批量栏必须在滚动 file-content 闭合后挂载；absolute bottom 才以动态 modal-right 为基准。
    expect(projectFilesPanelVue).toContain('</div>\n\n          <!-- 批量栏挂在 modal-right')
    const modalRightBlock = cssBlock(projectFilesPanelVue, '.modal-right')
    expect(modalRightBlock).toContain('position: relative')
  })

  it('文件卡亮色保持 0.20.4 多选层级，暗色只重映射 token 且没有 adoption paint 竞争', () => {
    // 0.20.4 light baseline：普通文件整卡 .14；图片在整卡层之上再加 .28 缩略图层。
    expect(componentSurfacesCss).toContain('--file-card-bg: rgba(255,255,255,.72);')
    expect(componentSurfacesCss).toContain('--file-card-bg-hover: rgba(255,255,255,.86);')
    expect(componentSurfacesCss).toContain('--file-card-bg-selected: rgba(255,255,255,.92);')
    expect(componentSurfacesCss).toContain('--file-card-border-selected: rgba(123,127,178,.55);')
    expect(componentSurfacesCss).toContain('--file-card-selection-overlay: rgba(123,127,178,.14);')
    expect(componentSurfacesCss).toContain('--file-card-selection-thumb-overlay: rgba(123,127,178,.28);')
    expect(componentSurfacesCss).toContain('--file-card-preselection-thumb-overlay: rgba(123,127,178,.16);')

    // FileCard 是唯一实体 paint owner；普通文件和图片文件继续消费不同层级的选中 token。
    expect(fileCardVue).toContain('background: var(--file-card-bg);')
    expect(fileCardVue).toContain('background: var(--file-card-bg-selected);')
    expect(fileCardVue).toContain('background: var(--file-card-selection-overlay);')
    expect(fileCardVue).toContain('background: var(--file-card-selection-thumb-overlay);')
    expect(fileCardVue).not.toMatch(/background:\s*rgba\(123,127,178/i)
    expect(fileCardVue).not.toContain('!important')

    // 暗色保持同一状态结构，只替换 surface / edge / overlay 语义，不复制一份 selector。
    const darkTokens = cssBlock(componentSurfacesCss, "html[data-theme='dark'][data-family]")
    expect(darkTokens).toContain('--file-card-bg: var(--surface-card-solid);')
    expect(darkTokens).toContain('--file-card-bg-selected: var(--surface-raised);')
    expect(darkTokens).toContain('--file-card-border-selected: var(--action-outline);')
    expect(darkTokens).toContain('--file-card-selection-overlay: var(--selection-bg);')
    expect(darkTokens).toContain('--file-card-selection-thumb-overlay: color-mix(in srgb,var(--action-primary) 28%,transparent);')

    // Legacy bridge / Mono adoption 不得重新获得 fc-card paint 或 border ownership。
    expect(themeAdoptionCss).not.toMatch(/html\[data-theme[^\n]*\.fc-card/)
    expect(surfacesCss).not.toMatch(/html\[data-family='mono'\][^{]*\.fc-card/)
  })

  it('Mono 内容卡关闭 blur、画布浮动 chrome 通过同一 glass-card token 恢复 blur', () => {
    expect(componentCss).toContain('--glass-card-blur: var(--glass-blur)')

    const monoFamily = cssBlock(productCss, "html[data-family='mono'] { --glass-card-blur: none;")
    expect(monoFamily.trim()).toBe('--glass-card-blur: none;')

    const monoGlassCard = cssBlock(productCss, "html[data-family='mono'] .glass-card:not(.topbar)")
    expect(monoGlassCard).toContain('backdrop-filter: var(--glass-card-blur)')
    expect(monoGlassCard).not.toContain('backdrop-filter: none')

    const chromeBlock = cssBlock(
      mindCss,
      "html[data-family='mono'] :is(.canvas-drawer, .canvas-toolbar, .note-picker)",
    )
    expect(chromeBlock).toContain('--glass-card-background: var(--chrome-glass-bg)')
    expect(chromeBlock).toContain('--glass-card-background-hover: var(--chrome-glass-bg)')
    expect(chromeBlock).toContain('--glass-card-blur: var(--chrome-glass-blur)')
    expect(chromeBlock).toContain('background: var(--glass-card-background)')
    expect(chromeBlock).toContain('border-color: var(--glass-card-border)')
    expect(chromeBlock).toContain('box-shadow: var(--glass-card-shadow)')
    expect(chromeBlock).not.toContain('backdrop-filter:')
    expect(chromeBlock).not.toMatch(/(?:background|border(?:-color)?)\s*:[^;]*(?:#fff\b|white\b|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i)
  })

  it('Mono 音乐播放器和暗色播放按钮复用主题 token，不回退到旧亮色渐变', () => {
    const monoPlayer = cssBlock(surfacesCss, "html[data-family='mono'] .mini-player")
    expect(monoPlayer).toContain('background: var(--chrome-glass-bg)')
    expect(monoPlayer).toContain('border-color: var(--chrome-glass-border)')
    expect(monoPlayer).toContain('backdrop-filter: var(--chrome-glass-blur)')

    const playButton = cssBlock(surfacesCss, "html[data-family='mono'] .mini-player .mp-btn--play,")
    expect(surfacesCss).toContain("html[data-theme='dark'][data-family] .mini-player .mp-btn--play")
    expect(playButton).toContain('background: var(--action-primary-bg)')
    expect(playButton).toContain('color: var(--content-on-accent)')
    expect(playButton).not.toMatch(/linear-gradient|rgba?\(/i)
  })

  it('登录、注册、隐私页面只通过主题层接管 paint，亮色 scoped 样式不被覆盖', () => {
    expect(adoptionIndexCss).toContain("@import './public-pages.css';")
    expect(publicPagesCss).toContain("html[data-theme='dark'][data-family] :is(.auth-page, .privacy-page)")
    expect(publicPagesCss).toContain("html[data-theme='dark'][data-family] .auth-page .field input")
    expect(publicPagesCss).toContain("html[data-theme='dark'][data-family] .privacy-page .privacy-header")

    const selectors = cssSelectors(publicPagesCss)
    expect(selectors.length).toBeGreaterThan(0)
    expect(selectors.every(selector =>
      selector.startsWith("html[data-theme='dark'][data-family]") || selector.startsWith('.admin-login')
    )).toBe(true)
    expect(publicPagesCss).not.toMatch(/(?:background|border(?:-color)?)\s*:[^;]*(?:#fff\b|white\b|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i)
  })

  it('页面 Mono 配色与便签 Amber 色卡保持独立', () => {
    const monoCss = load('./tokens/palettes/mono.css')
    expect(monoCss).toContain('--theme-action-primary: #715653')
    expect(monoCss).toContain('--theme-action-primary: #be9d98')
    expect(monoCss).not.toContain('#ffc05f')
    expect(load('../../views/Design/components/DesignSystemPage.vue')).toContain("label: 'Amber', token: '--note-paper-amber'")
  })

  it('真实项目页样板按主题族选择材质层', () => {
    const designPageVue = load('../../views/Design/components/DesignSystemPage.vue')
    expect(designPageVue).toContain('<GlassBg />')
    expect(designPageVue).toContain('class="sample-topbar topbar glass-card"')
    expect(designPageVue).toContain(":global(html[data-family='mono']) .sample-sidebar{background:var(--chrome-glass-bg);border-right-color:var(--chrome-glass-border);box-shadow:var(--chrome-glass-shadow);backdrop-filter:var(--chrome-glass-blur);-webkit-backdrop-filter:var(--chrome-glass-blur)}")
    expect(designPageVue).toContain('background:var(--design-card-bg);border:1px solid var(--design-card-border)')
    expect(designPageVue).toContain('.sample-main > .sample-topbar { --gb-tint: var(--glass-bg);')
    expect(designPageVue).toContain('.sample-main > .sample-topbar:hover { --gb-tint: var(--glass-bg-hover); }')
    expect(designPageVue).toContain('.project-column.glass-card { --glass-card-background: var(--column-bg); --glass-card-background-hover: var(--column-bg); }')
    expect(designPageVue).not.toContain('border: 1px solid transparent;border-radius:var(--radius-md)')
    expect(designPageVue).not.toContain('border:1px solid var(--border-hairline);border-radius:var(--radius-md);background:var(--column-bg)')
    expect(designOverridesCss).not.toContain('.design-page .sample-topbar')
    expect(designOverridesCss).not.toContain("html[data-family='mono'] .design-page .product-frame")
    expect(designOverridesCss).not.toContain("html[data-family='mono'] .design-page .sample-main > .sample-topbar")
  })

  it('日历工具栏和终端顶部不重复绘制玻璃边界', () => {
    const componentCss = load('./component-theme-refinements.css')
    expect(componentCss).toContain('--gb-highlight-strong: transparent')
    expect(componentCss).toContain('--gb-highlight-side: transparent')

    const productCss = load('./tokens/product.css')
    const terminalBlock = cssBlock(productCss, 'html[data-theme][data-family] .terminal-main-head.glass-card')
    expect(terminalBlock).toContain('--glass-card-shadow: none')
    expect(terminalBlock).toContain('--glass-card-shadow-hover: none')
    expect(terminalBlock).toContain('box-shadow: none')

    const terminalsVue = load('../../views/Terminals/index.vue')
    expect(terminalsVue).toContain('box-shadow:var(--design-section-shadow);')
    expect(terminalsVue).not.toContain('box-shadow:var(--design-section-shadow), inset 0 1px 0 var(--design-section-highlight)')
  })

  it('咕咕聊天窗口不重复绘制外壳和输入区高光', () => {
    const productCss = load('./tokens/product.css')
    const chatBlock = cssBlock(productCss, 'html[data-theme][data-family] .chat-window::after')
    expect(chatBlock).toContain('box-shadow: none')

    const composerBlock = cssBlock(productCss, 'html[data-theme][data-family] .chat-window .chat-input-row')
    expect(composerBlock).toContain('box-shadow: none')

    const adoptionCss = load('./theme-adoption.css')
    const darkChatBlock = cssBlock(adoptionCss, "html[data-theme='dark'][data-family] .chat-window::after")
    expect(darkChatBlock).toContain('box-shadow: none')
  })

  it('咕咕聊天窗口离场时保留玻璃材质，避免 blur 先于淡出消失', () => {
    const leaveBlock = guguChatVue.match(/\.chat-open-leave-active\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(leaveBlock).toContain('backdrop-filter: var(--glass-blur)')
    expect(leaveBlock).toContain('-webkit-backdrop-filter: var(--glass-blur)')
    expect(leaveBlock).toContain('transition: opacity')
  })
})

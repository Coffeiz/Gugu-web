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
const overlayCss = load('./overlay-theme-bridge.css')
const fileToolbarCss = load('./file-toolbar-theme-refinements.css')
const themeAdoptionCss = load('./theme-adoption.css')
const productCss = load('./tokens/product.css')
const componentCss = load('./tokens/components.css')
const componentSurfacesCss = load('./tokens/components/surfaces.css')
const fileCardVue = load('../../components/common/file-browser/FileCard.vue')
const fileSelectionToolbarVue = load('../../components/common/FileSelectionToolbar.vue')
const filesViewVue = load('../../views/Files/index.vue')
const projectFilesPanelVue = load('../../views/Projects/components/ProjectFilesPanel.vue')
const primitivesCss = load('./tokens/primitives.css')
const fontsCss = load('./fonts.css')
const paletteFiles = ['lavender', 'ocean', 'rose', 'mono'].map(name => ({
  name,
  css: load(`./tokens/palettes/${name}.css`),
}))
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
const lightPaletteCss = [
  load('./tokens/palettes/lavender.css'),
  load('./tokens/palettes/ocean.css'),
  load('./tokens/palettes/rose.css'),
  load('./tokens/palettes/mono.css'),
]

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

  it('通知气泡暗色不继承亮色纯白高光，亮色实体样式保持唯一', () => {
    const darkEdge = cssBlock(notificationBubbleVue, ":global(html[data-theme='dark'][data-family]) .nb-item")
    const darkHighlight = cssBlock(notificationBubbleVue, ":global(html[data-theme='dark'][data-family]) .nb-item::after")
    expect(darkEdge).toContain('border-color: var(--border-default)')
    expect(darkHighlight).toContain('var(--highlight-soft)')
    expect(darkHighlight).toContain('var(--highlight-muted)')
    expect(notificationBubbleVue).toContain('border: 1px solid rgba(255,255,255,0.65)')
    expect(notificationBubbleVue).not.toMatch(/:global\(html\[data-theme='dark'\]\[data-family\][^)]*\)[^{]*\{[^}]*rgba\(255,255,255/i)
  })

  it('亮色调色板将导航选中面统一为实体亮面', () => {
    for (const paletteCss of lightPaletteCss) {
      const lightBlock = paletteCss.match(/:root\[data-palette='[^']+'\]\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
      expect(lightBlock).toContain('--theme-sidebar-active-bg: var(--theme-card-solid)')
    }
  })

  it('亮色导航选中项使用实体亮面，通知 active paint 不重复', () => {
    expect(load('../../components/common/AppSidebar.vue')).not.toContain('.notif-btn.notif-active {')
  })

  it('DateSpan 区间内部不叠加普通 hover 背景', () => {
    expect(datePickerCss).toContain(
      '.drp-day:hover:not(.sel-start):not(.sel-end):not(.in-range)',
    )
    const rangeBlock = cssBlock(datePickerCss, 'html[data-theme][data-family] .drp-day.in-range')
    expect(rangeBlock).toContain('background: var(--calendar-range-cell-bg)')
  })

  it('ImageViewer 暗色只重映射 toolbar 局部 token，不复制实体 paint', () => {
    const darkBlock = cssBlock(overlayCss, "html[data-theme='dark'][data-family] .iv-wrap")
    expect(darkBlock).toContain('--iv-toolbar-bg:')
    expect(darkBlock).toContain('--iv-toolbar-border: var(--border-strong)')
    expect(darkBlock).toContain('--iv-toolbar-filter: var(--popup-surface-blur)')
    expect(overlayCss).not.toContain("html[data-theme='dark'][data-family] .iv-toolbar")
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
    expect(surfacesCss).not.toMatch(/html\[data-family='v2'\][^{]*\.fc-card/)
  })

  it('Mono 内容卡关闭 blur、画布浮动 chrome 通过同一 glass-card token 恢复 blur', () => {
    expect(componentCss).toContain('--glass-card-blur: var(--glass-blur)')

    const monoFamily = cssBlock(productCss, "html[data-family='v2'] { --glass-card-blur: none;")
    expect(monoFamily.trim()).toBe('--glass-card-blur: none;')

    const monoGlassCard = cssBlock(productCss, "html[data-family='v2'] .glass-card:not(.topbar)")
    expect(monoGlassCard).toContain('backdrop-filter: var(--glass-card-blur)')
    expect(monoGlassCard).not.toContain('backdrop-filter: none')

    const chromeBlock = cssBlock(
      mindCss,
      "html[data-family='v2'] :is(.canvas-drawer, .canvas-toolbar, .note-picker)",
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
    const monoPlayer = cssBlock(surfacesCss, "html[data-family='v2'] .mini-player")
    expect(monoPlayer).toContain('background: var(--chrome-glass-bg)')
    expect(monoPlayer).toContain('border-color: var(--chrome-glass-border)')
    expect(monoPlayer).toContain('backdrop-filter: var(--chrome-glass-blur)')

    const playButton = cssBlock(surfacesCss, "html[data-family='v2'] .mini-player .mp-btn--play,")
    expect(surfacesCss).toContain("html[data-theme='dark'][data-family] .mini-player .mp-btn--play")
    expect(playButton).toContain('background: var(--action-primary-bg)')
    expect(playButton).toContain('color: var(--content-on-accent)')
    expect(playButton).not.toMatch(/linear-gradient|rgba?\(/i)
  })

  it('登录、注册、隐私页面只通过暗色 bridge 接管 paint，亮色 scoped 样式不被覆盖', () => {
    expect(adoptionIndexCss).toContain("@import './public-pages.css';")
    expect(publicPagesCss).toContain("html[data-theme='dark'][data-family] :is(.auth-page, .privacy-page)")
    expect(publicPagesCss).toContain("html[data-theme='dark'][data-family] .auth-page .field input")
    expect(publicPagesCss).toContain("html[data-theme='dark'][data-family] .privacy-page .privacy-header")

    const selectors = cssSelectors(publicPagesCss)
    expect(selectors.length).toBeGreaterThan(0)
    expect(selectors.every(selector => selector.startsWith("html[data-theme='dark'][data-family]"))).toBe(true)
    expect(publicPagesCss).not.toMatch(/(?:background|border(?:-color)?)\s*:[^;]*(?:#fff\b|white\b|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i)
  })
})

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

const mindCss = load('./adoption/mind.css')
const surfacesCss = load('./adoption/surfaces.css')
const datePickerCss = load('./adoption/date-picker.css')
const overlayCss = load('./overlay-theme-bridge.css')
const fileToolbarCss = load('./file-toolbar-theme-refinements.css')

describe('主题 CSS 回归契约', () => {
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

  it('Mono 画布抽屉和工具栏直接拥有最终毛玻璃 surface，避免只改变量后被通用 glass-card 回退', () => {
    const chromeBlock = cssBlock(
      mindCss,
      "html[data-family='v2'] :is(.canvas-drawer, .canvas-toolbar, .note-picker)",
    )
    expect(chromeBlock).toContain('--glass-card-background: var(--chrome-glass-bg)')
    expect(chromeBlock).toContain('--glass-card-background-hover: var(--chrome-glass-bg)')
    expect(chromeBlock).toContain('background: var(--glass-card-background)')
    expect(chromeBlock).toContain('border-color: var(--glass-card-border)')
    expect(chromeBlock).toContain('box-shadow: var(--glass-card-shadow)')
    expect(chromeBlock).toContain('backdrop-filter: var(--chrome-glass-blur)')
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
})

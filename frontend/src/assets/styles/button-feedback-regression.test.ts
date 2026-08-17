import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function load(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

function occurrences(source: string, needle: string) {
  return source.split(needle).length - 1
}

function withoutCssComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

const tokenCss = load('./tokens/components/buttons.css')
const bridgeCss = load('./adoption/button-feedback.css')
const globalCss = load('./global.css')
const adoptionIndexCss = load('./adoption/index.css')
const componentIndexCss = load('./tokens/components/index.css')
const feedbackComposable = load('../../composables/useButtonFeedback.ts')
const mainTs = load('../../main.ts')
const preferencesPane = load('../../components/common/ProfileModal/ProfilePreferencesPane.vue')

describe('按钮乐观反馈全局契约', () => {
  it('按钮 token 默认提供乐观按压值，并且每个默认 token 只有一个 owner', () => {
    expect(occurrences(componentIndexCss, "@import './buttons.css';")).toBe(1)
    expect(occurrences(tokenCss, '--button-feedback-transform: translateY(1px) scale(.985)')).toBe(1)
    expect(occurrences(tokenCss, '--button-feedback-opacity: .93')).toBe(1)
    expect(occurrences(tokenCss, '--button-press-transform: var(--button-feedback-transform, translateY(1px) scale(.985))')).toBe(1)
    expect(occurrences(tokenCss, '--button-press-opacity: var(--button-feedback-opacity, .93)')).toBe(1)
    expect(tokenCss).toContain('--button-feedback-transform: none')
  })

  it('所有普通原生 button 获得低特异性 fallback，press-fx 不重复吃两套 active paint', () => {
    expect(occurrences(adoptionIndexCss, "@import './button-feedback.css';")).toBe(1)
    expect(bridgeCss).toContain(":where(html:not([data-button-feedback='off']) button:not(.press-fx):not(:disabled):active)")
    expect(bridgeCss).toContain('transform: var(--button-press-transform, translateY(1px) scale(.985))')
    expect(bridgeCss).not.toContain('!important')

    // 只统计真正 CSS 规则，注释里解释 selector ownership 的文字不能被误算成第二个 owner。
    const globalRules = withoutCssComments(globalCss)
    const bridgeRules = withoutCssComments(bridgeCss)
    expect(occurrences(globalRules, '.press-fx:active {')).toBe(1)
    expect(occurrences(bridgeRules, '.press-fx:active')).toBe(1)
    expect(bridgeRules).toContain("html[data-button-feedback='off'] .press-fx:active")
    expect(bridgeRules).not.toContain("html[data-button-feedback='optimistic'] .press-fx:active")
  })

  it('全局偏好默认 optimistic，并在应用挂载前初始化且有设置入口', () => {
    expect(feedbackComposable).toContain("export type ButtonFeedbackPreference = 'optimistic' | 'off'")
    expect(feedbackComposable).toContain("return localStorage.getItem(STORAGE_KEY) === 'off' ? 'off' : 'optimistic'")
    expect(feedbackComposable).toContain('document.documentElement.dataset.buttonFeedback = preference.value')
    expect(mainTs).toContain('initializeButtonFeedback()')
    expect(mainTs.indexOf('initializeButtonFeedback()')).toBeLessThan(mainTs.indexOf('const app = createApp(App)'))
    expect(preferencesPane).toContain('按钮乐观反馈')
    expect(preferencesPane).toContain("{ value: 'optimistic', label: '乐观' }")
    expect(preferencesPane).toContain("{ value: 'off', label: '关闭' }")
  })
})

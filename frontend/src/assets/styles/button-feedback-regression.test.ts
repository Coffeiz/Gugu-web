import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function load(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const tokenCss = load('./tokens/components/buttons.css')
const bridgeCss = load('./adoption/button-feedback.css')
const adoptionIndexCss = load('./adoption/index.css')
const componentIndexCss = load('./tokens/components/index.css')
const feedbackComposable = load('../../composables/useButtonFeedback.ts')
const mainTs = load('../../main.ts')
const preferencesPane = load('../../components/common/ProfileModal/ProfilePreferencesPane.vue')

describe('按钮乐观反馈全局契约', () => {
  it('按钮 token 默认提供乐观按压值，并保留组件级覆盖入口', () => {
    expect(componentIndexCss).toContain("@import './buttons.css';")
    expect(tokenCss).toContain('--button-feedback-transform: translateY(1px) scale(.985)')
    expect(tokenCss).toContain('--button-feedback-opacity: .93')
    expect(tokenCss).toContain('--button-press-transform: var(--button-feedback-transform, translateY(1px) scale(.985))')
    expect(tokenCss).toContain('--button-press-opacity: var(--button-feedback-opacity, .93)')
    expect(tokenCss).toContain('--button-feedback-transform: none')
  })

  it('所有原生 button 获得低特异性 active fallback，关闭时不生效', () => {
    expect(adoptionIndexCss).toContain("@import './button-feedback.css';")
    expect(bridgeCss).toContain(":where(html:not([data-button-feedback='off']) button:not(:disabled):active)")
    expect(bridgeCss).toContain('transform: var(--button-press-transform, translateY(1px) scale(.985))')
    expect(bridgeCss).not.toContain('!important')
    expect(bridgeCss).toContain("html[data-button-feedback='off'] .press-fx:active")
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

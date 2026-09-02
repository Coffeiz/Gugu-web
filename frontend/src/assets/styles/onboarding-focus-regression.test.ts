import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function load(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const onboarding = load('../../components/onboarding/OnboardingModal.vue')
const onboardingImSetup = load('../../components/onboarding/OnboardingImSetup.vue')
const profileByokPane = load('../../components/common/profile/ProfileByokPane.vue')
const themePreview = load('../../components/onboarding/OnboardingThemePreview.vue')
const themeSwitcher = load('../../views/Design/components/ThemeSwitcher.vue')
const fileCard = load('../../components/common/file-browser/FileCard.vue')
const folderCard = load('../../components/common/file-browser/FolderCard.vue')
const forms = load('./adoption/forms.css')

describe('onboarding 与重命名 focus 视觉回归', () => {
  it('语言选中态使用公共卡片底色，并保留 focus glow', () => {
    const start = onboarding.indexOf('.locale-option.selected {')
    const end = onboarding.indexOf('}', start)
    const block = onboarding.slice(start, end)
    expect(block).toContain('background: var(--workspace-card-bg);')
    expect(block).toContain('box-shadow: var(--control-focus-shadow), var(--workspace-card-shadow);')
    expect(block).not.toContain('background: var(--action-soft);')
    expect(onboarding).toContain('<RiCheckFill />')
    expect(onboarding).not.toContain('status.check-circle')
    expect(onboarding).not.toContain('>✓<')
    expect(onboarding).toContain('line-height: 0;')
    expect(onboarding).toContain('width: var(--icon-size-xs);')
  })

  it('onboarding visual 通过媒体 mask 淡出到统一面板背景', () => {
    expect(onboarding).toContain('z-index: 4;')
    expect(onboarding).toContain('mask-image: linear-gradient(to bottom, #000 0%, #000 54%, transparent 100%);')
    expect(onboarding).toContain('class="theme-preview-host"')
    expect(onboarding).toContain('background="var(--panel-bg)"')
    expect(onboarding).toContain('margin-top: -28px;')
    expect(onboarding).toContain('.onboarding-content')
    expect(onboarding).toContain('.onboarding-actions')
    expect(onboarding).not.toContain('background: var(--surface-base);')
    expect(onboarding).not.toContain('.visual-fade')
    expect(onboarding).not.toContain('visual-close')
    expect(onboarding).not.toContain('CloseButton')
  })

  it('内容区和操作区使用随主题变化的明亮面板玻璃 token', () => {
    expect(onboarding).toContain('background: transparent;')
    expect(onboarding).not.toContain('--onboarding-panel-bottom:')
    expect(onboarding).toContain('border-top: 1px solid var(--panel-divider);')
  })

  it('panel-bg 保留主题 base 作为渐变底色，避免面板退化为纯半透明', () => {
    expect(load('./tokens/components/surfaces.css')).toContain('), var(--surface-base);')
  })

  it('语言卡片与功能卡片复用相同的尺寸节奏，hover 只改变描边', () => {
    const hoverStart = onboarding.indexOf('.locale-option:hover {')
    const hoverEnd = onboarding.indexOf('}', hoverStart)
    const hoverBlock = onboarding.slice(hoverStart, hoverEnd)
    expect(onboarding).toContain('gap: var(--space-md);')
    expect(onboarding).toContain('padding: var(--space-md);')
    expect(onboarding).toContain('border-radius: var(--card-radius);')
    expect(hoverBlock).toContain('border-color: var(--workspace-card-border-hover);')
    expect(hoverBlock).not.toContain('background:')
    expect(hoverBlock).not.toContain('box-shadow:')
  })

  it('功能卡片使用亮色公共底色，语义色只负责图标和描边且不浮动', () => {
    const featureStart = onboarding.indexOf('.feature-option {')
    const featureEnd = onboarding.indexOf('}', featureStart)
    const featureBlock = onboarding.slice(featureStart, featureEnd)
    const hoverStart = onboarding.indexOf('.feature-option:hover {')
    const hoverEnd = onboarding.indexOf('}', hoverStart)
    const hoverBlock = onboarding.slice(hoverStart, hoverEnd)
    expect(featureBlock).toContain('background: var(--workspace-card-bg);')
    expect(featureBlock).not.toContain('--feature-accent')
    expect(onboarding).toContain('background: var(--status-info-bg); color: var(--status-info);')
    expect(onboarding).toContain('background: var(--status-warning-bg); color: var(--status-warning);')
    expect(onboarding).toContain('background: var(--status-success-bg); color: var(--status-success);')
    expect(hoverBlock).not.toContain('transform:')
    expect(hoverBlock).not.toContain('box-shadow:')
  })

  it('主题设置面板使用更明确的公共卡片底色', () => {
    expect(onboarding).toContain('background: var(--workspace-card-bg);')
    expect(onboarding).toContain('border: 1px solid var(--workspace-card-border);')
    expect(onboarding).toContain('box-shadow: var(--workspace-card-shadow);')
  })

  it('完成页摘要卡片复用 onboarding 公共卡片契约', () => {
    const start = onboarding.indexOf('.complete-option-row {')
    const end = onboarding.indexOf('}', start)
    const block = onboarding.slice(start, end)
    expect(block).toContain('border: 1px solid var(--workspace-card-border);')
    expect(block).toContain('background: var(--workspace-card-bg);')
    expect(block).toContain('box-shadow: var(--workspace-card-shadow);')
  })

  it('onboarding 模型页只展示添加入口与工作区卡片', () => {
    expect(onboarding).toContain('class="content-options onboarding-model-pane"')
    expect(onboarding).toContain('onboarding')
    expect(profileByokPane).toContain("'profile-byok-pane--onboarding': onboarding")
    expect(profileByokPane).toContain('v-if="!onboarding"')
    expect(profileByokPane).toContain('background: var(--choice-chip-bg);')
    expect(profileByokPane).toContain('background: var(--choice-chip-bg-hover);')
    expect(profileByokPane).toContain('gap: var(--space-md); padding: 13px 14px;')
    expect(profileByokPane).toContain('border-radius: var(--radius-md);')
    expect(onboarding).toContain('overflow-y: auto;')
    expect(onboarding).toContain('padding-right: var(--space-sm);')
    expect(profileByokPane).toContain('class="onboarding-model-dialog-backdrop"')
    expect(profileByokPane).toContain('class="{ \'onboarding-model-editor\': onboarding }"')
    expect(profileByokPane).toContain("'onboarding-provider-popup'")
    expect(profileByokPane).toContain('z-index: 30002 !important;')
    expect(profileByokPane).toContain("<Transition :name=\"onboarding ? 'onboarding-model' : 'byok-editor-none'\">")
    expect(profileByokPane).toContain('.onboarding-model-enter-active')
    expect(profileByokPane).toContain('transition: opacity var(--modal-enter-duration) var(--modal-enter-easing);')
    expect(profileByokPane).not.toContain('transform var(--modal-enter-duration)')
  })

  it('onboarding IM 使用独立平台卡片，不复用个人设置面板', () => {
    expect(onboarding).toContain('OnboardingImSetup')
    expect(onboarding).toContain('onboarding')
    expect(onboarding).not.toContain('ProfileImPane')
    expect(onboardingImSetup).toContain('bots.value = result.items || []')
    expect(onboardingImSetup).toContain('defineOptions({ inheritAttrs: false })')
    expect(onboardingImSetup).toContain('class="onboarding-im-setup" v-bind="$attrs"')
    expect(onboardingImSetup).toContain('<BaseModal')
    expect(onboardingImSetup).toContain('ref="connectCanvas"')
      expect(onboardingImSetup).toContain('background="var(--surface-card-solid)"')
      expect(onboardingImSetup).toContain('teleport-to="body"')
      expect(onboardingImSetup).toContain(':show="modalVisible"')
    expect(onboardingImSetup).toContain('.onboarding-im-modal')
    expect(onboardingImSetup).toContain('border-top: 1px solid var(--panel-divider);')
      expect(onboardingImSetup).toContain('background: var(--choice-chip-bg);')
      expect(onboardingImSetup).toContain('var(--choice-chip-border-hover)')
      expect(onboardingImSetup).toContain('var(--choice-chip-fg-hover)')
      expect(onboardingImSetup).toContain('<RiQqFill v-else-if=')
      expect(onboardingImSetup).toContain('<RiWechatFill v-else />')
      expect(onboardingImSetup).toContain('<RiChat1Fill v-if=')
  })

  it('主题预览 topbar 使用独立公共卡片样式', () => {
    const start = themePreview.indexOf('.preview-topbar {')
    const end = themePreview.indexOf('}', start)
    const block = themePreview.slice(start, end)
    expect(block).toContain('border: 1px solid var(--glass-card-border);')
    expect(block).toContain('border-radius: var(--card-radius);')
    expect(block).toContain('background: var(--glass-card-background);')
    expect(block).toContain('box-shadow: var(--glass-card-shadow);')
    expect(block).not.toContain('border-bottom:')
  })

  it('主题切换按钮统一使用 choice 与 segmented token', () => {
    expect(themeSwitcher).toContain('border:1px solid var(--choice-chip-border)')
    expect(themeSwitcher).toContain('background:var(--segmented-track-bg)')
    expect(themeSwitcher).toContain('background:var(--segmented-pill-bg)')
    expect(themeSwitcher).not.toContain('family-choice.active')
    expect(themeSwitcher).not.toContain('background:var(--surface-raised)')
  })

  it('导航按钮不把持久化状态展示成保存中', () => {
    expect(onboarding).not.toContain("saving ? t('onboardingUi.saving')")
    expect(onboarding).toContain(":class=\"{ 'is-busy': saving }\"")
    expect(onboarding).not.toContain(':disabled="saving"')
    expect(onboarding).not.toContain(':disabled="saving ||')
  })

  it('文件和文件夹只在重命名态放开名称行裁切', () => {
    expect(fileCard).toContain('.fc-name:has(.rename-sizer) { overflow: visible; text-overflow: clip; }')
    expect(folderCard).toContain('.fd-name:has(.rename-sizer) { overflow: visible; text-overflow: clip; }')
  })

  it('rename input 恢复共享 input-focus-shadow，不再有专属降级覆盖', () => {
    expect(forms).toContain('box-shadow: var(--input-hover-shadow), var(--input-focus-shadow);')
    expect(forms).not.toContain('.rename-input-inline:focus:not(:disabled) { box-shadow: var(--input-hover-shadow); }')
  })
})

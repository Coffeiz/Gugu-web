import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function load(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const onboarding = load('../../components/onboarding/OnboardingModal.vue')
const fileCard = load('../../components/common/file-browser/FileCard.vue')
const folderCard = load('../../components/common/file-browser/FolderCard.vue')
const forms = load('./adoption/forms.css')

describe('onboarding 与重命名 focus 视觉回归', () => {
  it('语言选中态只使用控件底色和 focus glow，不再覆盖 action-soft 蒙版', () => {
    const start = onboarding.indexOf('.locale-option.selected {')
    const end = onboarding.indexOf('}', start)
    const block = onboarding.slice(start, end)
    expect(block).toContain('background: var(--control-bg);')
    expect(block).toContain('box-shadow: var(--control-focus-shadow);')
    expect(block).not.toContain('background: var(--action-soft);')
  })

  it('onboarding visual 与 footer 收口到同一 surface，并由独立 fade 完成底部交叉', () => {
    expect(onboarding).toContain('class="visual-fade"')
    expect(onboarding).toContain('height: 132px;')
    expect(onboarding).toContain('var(--surface-base) 100%')
    expect(onboarding).toContain('margin-top: -28px;')
    expect(onboarding).toContain('.onboarding-content')
    expect(onboarding).toContain('.onboarding-actions')
    expect((onboarding.match(/background: var\(--surface-base\);/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('导航按钮不把持久化状态展示成保存中', () => {
    expect(onboarding).not.toContain("saving ? t('onboardingUi.saving')")
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

// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function load(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const closeButton = load('../../components/common/overlays/CloseButton.vue')
const fileInfoPopup = load('../../components/common/file-browser/FileInfoPopup.vue')
const supportModal = load('../../components/common/feedback/SupportModal.vue')
const feedbackModal = load('../../components/common/feedback/FeedbackModal.vue')
const profileModal = load('../../components/common/profile/ProfileModal.vue')
const projectModal = load('../../views/Projects/components/NewProjectModal.vue')
const uploadModal = load('../../views/Files/UploadModal.vue')
const skillForm = load('../../views/Skills/components/SkillForm.vue')
const mcpServerForm = load('../../views/Skills/components/McpServerFormModal.vue')
const projectCard = load('../../views/Projects/components/ProjectCard.vue')
const browserToolbar = load('../../components/common/file-browser/FileBrowserToolbar.vue')
const componentTokens = load('./tokens/components.css')
const primitiveTokens = load('./tokens/primitives.css')

describe('卡片关闭按钮布局回归契约', () => {
  it('卡片标题关闭按钮共享右上角圆角半径延长线定位', () => {
    expect(componentTokens).toContain('--card-close-inset: var(--space-md);')
    expect(componentTokens).toContain('--card-close-safe-area: calc(var(--card-close-inset) + var(--control-height-sm) + var(--space-md));')
    expect(componentTokens).toContain('--card-close-compact-safe-area: calc(var(--card-close-inset) + var(--control-height-xs) + var(--space-md));')
    expect(primitiveTokens).toContain('--control-height-xs: 22px;')
    expect(closeButton).toContain('cardCorner?: boolean')
    expect(closeButton).toContain('compact?: boolean')
    expect(closeButton).toContain("'app-close-button--card-corner': cardCorner")
    expect(closeButton).toContain("'app-close-button--compact': compact")
    expect(closeButton).toContain('.app-close-button--card-corner {')
    expect(closeButton).toContain('.app-close-button--compact {')
    expect(closeButton.indexOf('.app-close-button--compact {')).toBeGreaterThan(closeButton.indexOf('.app-close-button {'))
    expect(closeButton).toContain('top: var(--card-close-inset);')
    expect(closeButton).toContain('right: var(--card-close-inset);')
    expect(closeButton).toContain(':global(.card-close-anchor) { position: relative; }')

    const cardHeaders = [
      fileInfoPopup,
      supportModal,
      feedbackModal,
      profileModal,
      projectModal,
      uploadModal,
      skillForm,
      mcpServerForm,
      projectCard,
    ]
    for (const component of cardHeaders) {
      expect(component).toContain('card-corner')
      expect(component).toContain('card-close-anchor')
    }
    expect(projectCard).toContain('<CloseButton card-corner compact')
    expect(projectCard).toContain('padding-right: calc(var(--card-close-compact-safe-area) - var(--todo-pop-padding))')
    expect(projectCard).not.toContain('class="popup-close-btn"')
    expect(uploadModal).not.toMatch(/<CloseButton[^>]*\bcompact\b/)

    expect(browserToolbar).toContain('<CloseButton v-if="showClose" @click="emit(\'close\')" />')
    expect(browserToolbar).not.toContain('cardCorner')
  })
})

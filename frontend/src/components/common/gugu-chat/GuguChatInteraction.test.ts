import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('GuguChatInteraction', () => {
  it('长确认选项具备收缩换行约束，不再按整段文案撑出卡片', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/common/gugu-chat/GuguChatInteraction.vue'), 'utf8')
    const style = source.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] || ''
    const buttonRule = style.match(/\.interaction-actions\s+:deep\(\.interaction-option\)\s*\{([^}]+)\}/)?.[1] || ''
    const contentRule = style.match(/\.interaction-actions\s+:deep\(\.interaction-option \.app-action-button-content\)\s*\{([^}]+)\}/)?.[1] || ''

    expect(source).toContain('class="interaction-option" fit')
    expect(buttonRule).toContain('min-width: 0')
    expect(buttonRule).toContain('max-width: 100%')
    expect(buttonRule).toContain('white-space: normal')
    expect(buttonRule).toContain('word-break: normal')
    expect(buttonRule).toContain('overflow-wrap: anywhere')
    expect(contentRule).toContain('display: block')
    expect(contentRule).toContain('overflow-wrap: anywhere')
  })

  it('空选项的存量提问不渲染空按钮区，避免悬空分隔线', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/common/gugu-chat/GuguChatInteraction.vue'), 'utf8')
    expect(source).toContain('<div v-if="displayOptions.length" class="interaction-actions">')
  })
})

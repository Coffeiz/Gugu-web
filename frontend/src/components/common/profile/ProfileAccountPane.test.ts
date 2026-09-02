import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'ProfileAccountPane.vue'), 'utf8')

describe('账号安全入口', () => {
  it('仅在服务端能力开启时渲染邮箱变更区域', () => {
    expect(source).toContain('v-if="prefsStore.emailChangeEnabled"')
    expect(source).toContain("if (!prefsStore.loaded) prefsStore.fetch()")
  })

  it('使用统一认证 API 完成申请、重发和取消', () => {
    expect(source).toContain('authApi.requestEmailChange')
    expect(source).toContain('authApi.resendEmailChange')
    expect(source).toContain('authApi.cancelEmailChange')
    expect(source).toContain('newEmail.value = emailCurrentPwd.value = \'\'')
  })
})

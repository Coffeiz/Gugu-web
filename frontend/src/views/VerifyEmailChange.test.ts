import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'VerifyEmailChange.vue'), 'utf8')

describe('邮箱变更验证页', () => {
  it('是公开路由并且只用短期 token 调用验证接口', () => {
    const router = readFileSync(join(here, '../router/index.ts'), 'utf8')
    expect(router).toContain("path: '/verify-email-change'")
    expect(router).toContain('name: \'VerifyEmailChange\'')
    expect(source).toContain('authApi.verifyEmailChange(token)')
    expect(source).toContain("route.query.token")
    expect(source).not.toContain('localStorage')
  })
})

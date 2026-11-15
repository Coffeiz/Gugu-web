import { describe, expect, it } from 'vitest'
import { createProfileUpdater } from '../../src/auth/profile-update.js'

const ownerId = '00000000-0000-4000-8000-000000000031'

describe('个人资料更新用例', () => {
  it('规范化资料字段并报告时区变化，只更新认证用户', async () => {
    const calls: unknown[] = []
    const updateProfile = createProfileUpdater({
      async transaction(work) {
        return work({
          async loadForUpdate(id) {
            calls.push(['lock', id])
            return { timezone: 'UTC', hashedPassword: 'current-hash', securityVersion: 4 }
          },
          async update(id, patch) { calls.push(['update', id, patch]); return { securityVersion: 4 } },
        })
      },
      async verifyPassword() { return false },
      async hashPassword() { throw new Error('不应更改密码') },
    })

    await expect(updateProfile(ownerId, {
      displayName: '  小北  ', timezone: ' Asia/Tokyo ', emailSubscribed: true,
    })).resolves.toEqual({ timezoneChanged: true, passwordChanged: false, securityVersion: 4 })
    expect(calls).toEqual([
      ['lock', ownerId],
      ['update', ownerId, { displayName: '小北', timezone: 'Asia/Tokyo', emailSubscribed: true }],
    ])
  })

  it('空昵称和空时区归一为空值，默认时区没有伪造变化', async () => {
    let saved: unknown
    const updateProfile = createProfileUpdater({
      async transaction(work) {
        return work({
          async loadForUpdate() { return { timezone: null, hashedPassword: 'hash', securityVersion: null } },
          async update(_id, patch) { saved = patch; return { securityVersion: null } },
        })
      },
      async verifyPassword() { return false },
      async hashPassword() { throw new Error('不应更改密码') },
    })

    await expect(updateProfile(ownerId, { displayName: '  ', timezone: '' }))
      .resolves.toEqual({ timezoneChanged: false, passwordChanged: false, securityVersion: null })
    expect(saved).toEqual({ displayName: null, timezone: null })
  })

  it('拒绝无效时区并在事务及写入前返回错误', async () => {
    let transactionStarted = false
    const updateProfile = createProfileUpdater({
      async transaction() { transactionStarted = true; throw new Error('不应开始事务') },
      async verifyPassword() { return false },
      async hashPassword() { throw new Error('不应哈希') },
    })

    await expect(updateProfile(ownerId, { timezone: 'Not/A_Real_Zone' }))
      .rejects.toMatchObject({ code: 'invalid_timezone' })
    expect(transactionStarted).toBe(false)
  })

  it('改密必须先验证当前密码，成功后只增加当前用户的 security version', async () => {
    let saved: unknown
    const updateProfile = createProfileUpdater({
      async transaction(work) {
        return work({
          async loadForUpdate() { return { timezone: 'UTC', hashedPassword: 'current-hash', securityVersion: 4 } },
          async update(_id, patch) { saved = patch; return { securityVersion: 5 } },
        })
      },
      async verifyPassword(raw, hash) { return raw === 'old-password' && hash === 'current-hash' },
      async hashPassword() { return 'new-hash' },
    })

    await expect(updateProfile(ownerId, { currentPassword: 'old-password', newPassword: 'new-password' }))
      .resolves.toEqual({ timezoneChanged: false, passwordChanged: true, securityVersion: 5 })
    expect(saved).toEqual({ hashedPassword: 'new-hash', incrementSecurityVersion: true })
  })

  it('缺少或错误的当前密码不会写入资料或递增版本', async () => {
    let writes = 0
    const updateProfile = createProfileUpdater({
      async transaction(work) {
        return work({
          async loadForUpdate() { return { timezone: 'UTC', hashedPassword: 'current-hash', securityVersion: 4 } },
          async update() { writes++; return { securityVersion: 5 } },
        })
      },
      async verifyPassword() { return false },
      async hashPassword() { return 'unused' },
    })

    await expect(updateProfile(ownerId, { newPassword: 'new-password' }))
      .rejects.toMatchObject({ code: 'current_password_required' })
    await expect(updateProfile(ownerId, { currentPassword: 'wrong', newPassword: 'new-password' }))
      .rejects.toMatchObject({ code: 'current_password_invalid' })
    expect(writes).toBe(0)
  })
})

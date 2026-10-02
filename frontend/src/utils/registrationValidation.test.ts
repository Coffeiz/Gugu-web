import { describe, expect, it } from 'vitest'
import { getRegistrationValidationError } from './registrationValidation'

const validFields = {
  username: 'test-user',
  email: 'test@example.com',
  password: 'password123',
  confirmPassword: 'password123',
}

describe('getRegistrationValidationError', () => {
  it('拒绝确认密码缺失或与密码不一致，避免错误密码进入注册请求', () => {
    expect(getRegistrationValidationError({ ...validFields, confirmPassword: '' })).toBe('fillAll')
    expect(getRegistrationValidationError({ ...validFields, confirmPassword: 'different123' })).toBe('passwordMismatch')
  })

  it('有效资料且两次密码一致时允许继续注册', () => {
    expect(getRegistrationValidationError(validFields)).toBeNull()
  })
})

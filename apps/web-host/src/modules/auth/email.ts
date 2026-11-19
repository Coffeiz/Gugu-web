const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export class InvalidEmailError extends Error {
  constructor() {
    super('请输入有效的邮箱地址')
    this.name = 'InvalidEmailError'
  }
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (email.length > 300 || !emailPattern.test(email)) throw new InvalidEmailError()
  return email
}

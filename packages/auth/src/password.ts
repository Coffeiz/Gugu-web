export class PasswordChangeError extends Error {
  constructor(readonly code: 'current_password_required' | 'current_password_invalid') {
    super(code === 'current_password_required' ? '请输入当前密码' : '当前密码错误')
    this.name = 'PasswordChangeError'
  }
}

/** 使用宿主事务中读到的哈希准备凭据更新，由宿主原子写入。 */
export async function preparePasswordChange(
  input: { currentPassword?: string; newPassword: string },
  currentHash: string,
  ports: {
    verifyPassword(rawPassword: string, hashedPassword: string): Promise<boolean>
    hashPassword(rawPassword: string): Promise<string>
  },
): Promise<{ hashedPassword: string; incrementSecurityVersion: true }> {
  if (!input.currentPassword) throw new PasswordChangeError('current_password_required')
  if (!await ports.verifyPassword(input.currentPassword, currentHash))
    throw new PasswordChangeError('current_password_invalid')
  return { hashedPassword: await ports.hashPassword(input.newPassword), incrementSecurityVersion: true }
}

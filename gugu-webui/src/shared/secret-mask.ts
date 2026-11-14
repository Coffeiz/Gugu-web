/** 隐藏密钥内容，同时保留可识别的首尾字符。 */
export function maskSecret(secret: string): string {
  if (!secret) return ''
  return secret.length <= 8
    ? '•'.repeat(secret.length)
    : `${secret.slice(0, 3)}${'•'.repeat(secret.length - 7)}${secret.slice(-4)}`
}

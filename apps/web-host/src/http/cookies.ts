/** 解析 Cookie 头；同名 Cookie 保留首次出现的值。 */
export function parseCookieHeader(header: string | undefined): Map<string, string> {
  const values = new Map<string, string>()
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (name && !values.has(name)) values.set(name, value)
  }
  return values
}

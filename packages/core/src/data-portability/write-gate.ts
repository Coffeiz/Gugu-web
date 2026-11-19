const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Python FastAPI 在替换窗口内仅阻断用户写请求，数据迁移控制面保持可用。 */
export function requiresDataReplacementWriteGate(method: string, pathname: string): boolean {
  return !safeMethods.has(method.toUpperCase()) && !pathname.startsWith('/api/v1/data-portability/')
}

/** PG 用例只验证数据库/journal 协调，目录能力使用显式内存端口；不冒充 Local 原语。 */
export function directoryPort(initialPath: string, contents: string) {
  const paths = new Map([[initialPath, contents]])
  const renameDirectory = async (_owner: string, from: string, to: string, beforeMove?: (from: string, to: string) => Promise<void>) => {
    if (!paths.has(from)) return
    await beforeMove?.(from, to)
    // 检查和修改之间无 await，模拟具备原子不覆盖能力的受限端口。
    if (paths.has(to)) throw new Error('夹具目录目标已存在')
    paths.set(to, paths.get(from)!)
    paths.delete(from)
  }
  return {
    renameDirectory,
    contents: (path: string) => paths.get(path),
    journal: { async exists(_owner: string, path: string) { return paths.has(path) }, move: renameDirectory },
  }
}

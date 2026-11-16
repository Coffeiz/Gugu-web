import { link, lstat, unlink } from 'node:fs/promises'
import { ProjectTrashStoragePathError } from '@gugu/core/project-trash'

/** 安全移动失败必须穿过旧 Python 兼容 catch，使业务事务回滚。 */
export class ProjectPathMoveError extends ProjectTrashStoragePathError {
  readonly statusCode: number
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ProjectPathMoveError'
    this.statusCode = code === 'EEXIST' ? 409 : 503
  }
}

/**
 * link 原子占用不存在的目标，成功后才移除源；绝不回退到可覆盖的 rename。
 * Node 没有目录 rename-noreplace 能力，目录/特殊节点明确拒绝。
 * 两步之间失败或崩溃可能留下两处硬链接，保留数据供 journal 核对，不擅自清理。
 */
export async function moveProjectFileNoReplace(
  source: string, target: string, verifyPaths: () => Promise<void>,
): Promise<void> {
  await verifyPaths()
  const sourceInfo = await lstat(source)
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
    throw new ProjectPathMoveError('ENOTSUP', '当前平台无法安全移动目录或特殊节点，已保留源路径')
  try {
    await link(source, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'EIO'
    // 未建立目标时，缺失源仍沿用 Python 的普通缺文件语义。
    if (code === 'ENOENT' || code === 'ENOTDIR') throw error
    throw new ProjectPathMoveError(code, code === 'EEXIST'
      ? '移动目标已存在，已保留源和目标'
      : '无法原子占用移动目标，已保留源路径')
  }
  try {
    await verifyPaths()
    const [current, linked] = await Promise.all([lstat(source), lstat(target)])
    if (!current.isFile() || !linked.isFile()
      || current.dev !== sourceInfo.dev || current.ino !== sourceInfo.ino
      || linked.dev !== sourceInfo.dev || linked.ino !== sourceInfo.ino)
      throw new ProjectPathMoveError('ESTALE', '移动路径已变化，保留现有文件供恢复核对')
    await unlink(source)
  } catch (error) {
    if (error instanceof ProjectPathMoveError) throw error
    throw new ProjectPathMoveError((error as NodeJS.ErrnoException).code ?? 'EIO', '移动尚未完成，保留现有文件供恢复核对')
  }
}

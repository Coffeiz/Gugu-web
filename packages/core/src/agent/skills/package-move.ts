import { lstat, mkdir, realpath, rename, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CoreError, dataContext } from '../../contracts/index.js'
import { ensureSkillDirectory } from './safe-directory.js'
import { skillBundleDirectory } from './bundle.js'
import { skillPackageDigest } from './package-digest.js'
import type { SkillPackageUndoStorage } from './undo-adapter.js'

/** 技能包在所属用户的活动目录与操作专属撤销目录之间移动，并返回反向补偿。 */
export function createLocalSkillPackageMover(dataRoot: string): Pick<SkillPackageUndoStorage, 'move'> {
  return {
    async move({ ownerId, slug, storageSource = 'user', operationId, digest, mode }) {
      const owner = dataContext(ownerId).ownerId
      if (!/^op-[a-f0-9]{32}$/u.test(operationId)) throw new CoreError('conflict', '技能撤销记录无效')
      const root = await realpath(dataRoot)
      const live = skillBundleDirectory(root, owner, storageSource, slug)
      const held = join(root, owner, '.agent', '.skill-undo', operationId, storageSource, slug)
      const source = mode === 'undo' ? live : held
      const target = mode === 'undo' ? held : live
      await ensureSkillDirectory(root, dirname(target))
      async function transfer(from: string, to: string) {
        let info
        try { info = await lstat(from) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CoreError('conflict', '技能文件已变化，无法撤销或重做')
          throw error
        }
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(from) !== from
          || await skillPackageDigest(from) !== digest) throw new CoreError('conflict', '技能文件已变化，无法撤销或重做')
        try { await mkdir(to, { mode: 0o700 }) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CoreError('conflict', '目标技能目录已存在')
          throw error
        }
        try { await rename(from, to) }
        catch (error) { await rmdir(to).catch(() => {}); throw error }
      }
      await transfer(source, target)
      return () => transfer(target, source)
    },
  }
}

import { CoreError, dataContext } from '@gugu/core'
import { createLocalSkillPackageMover, readSkillBundle, type SkillPackageUndoStorage } from '@gugu/core/skills'
import { createLocalFileUndoStorage } from '../files/storage/undo.js'

/** 将安装包移入用户专属撤销目录；不覆盖已有文件或已修改技能。 */
export function createLocalSkillUndoStorage(dataRoot: string): SkillPackageUndoStorage {
  return {
    ...createLocalSkillPackageMover(dataRoot),
    async replace({ ownerId, slug, storageSource = 'user', expectedDigest, content }) {
      const owner = dataContext(ownerId).ownerId
      const current = await readSkillBundle(dataRoot, owner, storageSource, slug)
      if (current.contentDigest !== expectedDigest) throw new CoreError('conflict', '技能文件已变化，无法撤销或重做')
      return createLocalFileUndoStorage(dataRoot).replace(`${owner}/.agent/skills/${storageSource}/${slug}/SKILL.md`, Buffer.from(content))
    },
  }
}

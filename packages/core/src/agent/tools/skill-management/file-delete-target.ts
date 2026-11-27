import { createHash } from 'node:crypto'
import { CoreError, dataContext } from '../../../contracts/index.js'
import { readUserSkillBundle } from '../../skills/bundle-store.js'
import { skillPackageDigest } from '../../skills/package-digest.js'
import { stableJson } from '../../context/history/canonical-history.js'

const hash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

/** 确认绑定整个技能包，避免确认后附属文件变化仍被删除。 */
export async function readFileSkillDeleteTarget(dataRoot: string, ownerId: string, slug: string) {
  const owner = dataContext(ownerId).ownerId
  const skill = await readUserSkillBundle(dataRoot, owner, slug)
  const packageDigest = await skillPackageDigest(skill.path)
  const name = Array.from(skill.name.replace(/[\p{Cc}\p{Cf}]/gu, ' ')).slice(0, 120).join('')
  return {
    name, slug, packageDigest,
    targetsDigest: hash({ owner, slug }),
    versionsDigest: hash({ packageDigest }),
    targetRefs: { skill: [slug] },
    displaySummary: `将删除技能「${name}」（${slug}）及其附属文件，可通过撤销恢复。`,
  }
}

/** 宿主显示确认前重新核验目标及完整目录内容。 */
export async function describeFileSkillDeleteTarget(dataRoot: string, ownerId: string, input: unknown,
  expected: { targetsDigest: string; versionsDigest: string }) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('id' in input) || typeof input.id !== 'string')
    throw new CoreError('invalid_request', '技能删除确认目标无效')
  const target = await readFileSkillDeleteTarget(dataRoot, ownerId, input.id)
  if (target.targetsDigest !== expected.targetsDigest || target.versionsDigest !== expected.versionsDigest)
    throw new CoreError('conflict', '技能删除确认目标已变化')
  return target.displaySummary
}

import { isAbsolute, relative, sep } from 'node:path'

/** 判断候选路径是否位于根目录本身或其子目录中。 */
export function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === ''
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
}

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

/** 从随应用发布的 onboarding/assets 中读取排序后的首个 MP3；目录缺失时与 Python 一样跳过。 */
export function createOnboardingSurpriseMp3Reader(assetDirectory: string) {
  return async (): Promise<{ name: string; data: Uint8Array } | null> => {
    let names: string[]
    try { names = await readdir(assetDirectory) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const selected = names.filter((name) => name.toLowerCase().endsWith('.mp3')).sort()[0]
    if (!selected) return null
    return {
      name: path.basename(selected, path.extname(selected)),
      data: await readFile(path.join(assetDirectory, selected)),
    }
  }
}

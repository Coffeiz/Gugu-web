import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const bundledAssets = fileURLToPath(new URL('../../../assets/onboarding', import.meta.url))

/** 读取随 Web Host 发布的首个 MP3。未打包音频时跳过此项播种。 */
export function createOnboardingSurpriseMp3Reader(assetDirectory = bundledAssets) {
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

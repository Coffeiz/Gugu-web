// 由主图标生成 macOS 使用的 icon.icns，避免手工拼接的 icns 出现尺寸或类型错位。
// 依赖 macOS 自带的 sips 与 iconutil；其他平台沿用仓库内已生成的图标文件。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const master = join(desktop, 'assets/icon.png')
const target = join(desktop, 'assets/icon.icns')

// Apple 的 iconset 规格：@2x 表示两倍像素尺寸，iconutil 按这些文件名写入对应类型。
const representations = [
  { file: 'icon_16x16.png', size: 16 },
  { file: 'icon_16x16@2x.png', size: 32 },
  { file: 'icon_32x32.png', size: 32 },
  { file: 'icon_32x32@2x.png', size: 64 },
  { file: 'icon_128x128.png', size: 128 },
  { file: 'icon_128x128@2x.png', size: 256 },
  { file: 'icon_256x256.png', size: 256 },
  { file: 'icon_256x256@2x.png', size: 512 },
  { file: 'icon_512x512.png', size: 512 },
  { file: 'icon_512x512@2x.png', size: 1024 },
]

/**
 * 生成 macOS 图标文件。
 * 主图标自带圆角留白，不需要额外加边距；1024 尺寸由 512 主图放大得到，
 * 换成本机原生 1024 主图可以避免放大带来的模糊。
 */
export function buildDesktopIcons({ platform = process.platform } = {}) {
  if (platform !== 'darwin') return { generated: false, reason: 'iconutil 只在 macOS 可用' }
  if (!existsSync(master)) throw new Error('缺少应用主图标 assets/icon.png')
  const staging = mkdtempSync(join(tmpdir(), 'gugu-desktop-icons-'))
  const iconset = join(staging, 'icon.iconset')
  try {
    mkdirSync(iconset)
    for (const item of representations)
      execFileSync('sips', ['-z', String(item.size), String(item.size), master, '--out', join(iconset, item.file)], { stdio: 'ignore' })
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', target], { stdio: 'ignore' })
    return { generated: true, target, sizes: representations.map(item => item.size) }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildDesktopIcons()
  console.log(result.generated ? `已生成 macOS 图标：${result.target}` : `跳过图标生成：${result.reason}`)
}

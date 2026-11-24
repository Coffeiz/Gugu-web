// 由主图标生成 macOS 使用的 icon.icns，避免手工拼接的 icns 出现尺寸或类型错位。
// 依赖 macOS 自带的 sips 与 iconutil；其他平台沿用仓库内已生成的图标文件。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktop = fileURLToPath(new URL('../', import.meta.url))
const master = join(desktop, 'assets/icon-macos.svg')
const target = join(desktop, 'assets/icon.icns')
const preview = join(desktop, 'assets/icon-macos.png')

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
 * macOS 打包图标使用铺满画布的背景，由系统处理圆角。
 * 带透明圆角和留白的图稿会在新版 macOS 上被缩小并套入灰色底板。
 */
export function buildDesktopIcons({ platform = process.platform } = {}) {
  if (platform !== 'darwin') return { generated: false, reason: 'iconutil 只在 macOS 可用' }
  if (!existsSync(master)) throw new Error('缺少 macOS 主图标 assets/icon-macos.svg')
  const staging = mkdtempSync(join(tmpdir(), 'gugu-desktop-icons-'))
  const png = join(staging, 'master.png')
  const iconset = join(staging, 'icon.iconset')
  try {
    mkdirSync(iconset)
    execFileSync('sips', ['-s', 'format', 'png', '-z', '1024', '1024', master, '--out', png], { stdio: 'ignore' })
    for (const item of representations)
      execFileSync('sips', ['-z', String(item.size), String(item.size), png, '--out', join(iconset, item.file)], { stdio: 'ignore' })
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', target], { stdio: 'ignore' })
    // 开发模式用 PNG 直接设置 Dock 图标，预先绘制带留白的圆角底板。
    const dockSvg = join(staging, 'dock.svg')
    const artwork = readFileSync(master, 'utf8').replace(
      '<path fill="#ffffff" d="M0 0H168V168H0Z"/>',
      '<rect x="11" y="11" width="146" height="146" rx="36" fill="#ffffff"/>',
    )
    writeFileSync(dockSvg, artwork)
    execFileSync('sips', ['-s', 'format', 'png', '-z', '1024', '1024', dockSvg, '--out', preview], { stdio: 'ignore' })
    return { generated: true, target, sizes: representations.map(item => item.size) }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildDesktopIcons()
  console.log(result.generated ? `已生成 macOS 图标：${result.target}` : `跳过图标生成：${result.reason}`)
}

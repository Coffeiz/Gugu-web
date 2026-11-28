// 裁剪桌面制品中的开发期文件与异平台二进制，只保留当前平台运行所需内容。
// 必须在清单生成前执行，裁剪结果才会被 manifest.json 的文件摘要覆盖。
import { existsSync, readdirSync, rmSync, rmdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 明确的开发期目录，删除后不影响运行时。
const DEV_DIRECTORIES = new Set([
  '__mocks__',
  '__tests__',
  'benchmarks',
  'benchmark',
  'coverage',
  'docs',
  'examples',
])
const TYPE_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts']

function walk(directory, visit, visitDirectory = () => true) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (visitDirectory(path, entry.name)) walk(path, visit, visitDirectory)
    }
    else if (entry.isFile()) visit(path)
  }
}

function remove(path, stats) {
  rmSync(path, { recursive: true, force: true })
  stats.removed += 1
  stats.bytes += 0
}

export function packageSupportsTarget(pkg, platform, arch) {
  return (!Array.isArray(pkg.os) || pkg.os.includes(platform)) &&
    (!Array.isArray(pkg.cpu) || pkg.cpu.includes(arch))
}

function pruneCanvasDependencies(nodeModules, platform, arch, stats) {
  const canvas = join(nodeModules, '@napi-rs', 'canvas')
  if (!existsSync(canvas)) return

  const canvasPackage = JSON.parse(readFileSync(join(canvas, 'package.json'), 'utf8'))
  for (const name of Object.keys(canvasPackage.optionalDependencies ?? {})) {
    const dependency = join(nodeModules, name)
    const manifest = join(dependency, 'package.json')
    if (!existsSync(manifest)) continue
    const nativePackage = JSON.parse(readFileSync(manifest, 'utf8'))
    if (!packageSupportsTarget(nativePackage, platform, arch)) remove(dependency, stats)
  }

  // pdfjs-dist 与 Core 共用同一版本 Canvas。让它解析根依赖，避免复制一套原生绑定。
  const pdfjsModules = join(nodeModules, 'pdfjs-dist', 'node_modules')
  const nestedScope = join(pdfjsModules, '@napi-rs')
  const nestedCanvas = join(nestedScope, 'canvas')
  if (!existsSync(nestedCanvas)) return
  const nestedPackage = JSON.parse(readFileSync(join(nestedCanvas, 'package.json'), 'utf8'))
  if (nestedPackage.version !== canvasPackage.version) return

  remove(nestedCanvas, stats)
  for (const name of Object.keys(nestedPackage.optionalDependencies ?? {})) {
    const dependency = join(pdfjsModules, name)
    if (existsSync(dependency)) remove(dependency, stats)
  }
  try {
    rmdirSync(nestedScope)
  } catch {
    // 若未来该作用域出现其他包，保留它们。
  }
}

// 计算目录占用，用于给出裁剪前后的体积对比。
function directorySize(directory) {
  let total = 0
  const visit = (path) => {
    try {
      const info = statSync(path)
      if (info.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry))
      else if (info.isFile()) total += info.size
    } catch {
      /* 文件可能在遍历期间消失，忽略 */
    }
  }
  visit(directory)
  return total
}

export function pruneSidecarHost(host, platform = process.platform, arch = process.arch) {
  const nodeModules = join(host, 'node_modules')
  const stats = { removed: 0, bytes: 0 }
  const before = directorySize(host)

  // 1. 删除 sourcemap 与依赖包的类型声明，运行期不需要。
  if (existsSync(nodeModules)) {
    walk(nodeModules, (path) => {
      if (path.endsWith('.map')) remove(path, stats)
      else if (TYPE_SUFFIXES.some((suffix) => path.endsWith(suffix))) remove(path, stats)
    })
  }

  // 2. 删除依赖包自带的开发期目录。
  if (existsSync(nodeModules)) {
    walk(nodeModules, () => {}, (path, name) => {
      // 目录内自带 package.json 说明它是独立子包，保留。
      if (!DEV_DIRECTORIES.has(name) || existsSync(join(path, 'package.json'))) return true
      remove(path, stats)
      return false
    })
  }

  // Canvas 的 optionalDependencies 同时包含多个系统和架构的原生包。
  if (existsSync(nodeModules)) pruneCanvasDependencies(nodeModules, platform, arch, stats)

  // 3. 只保留当前平台的预编译二进制。
  const keepPrebuild = `${platform}-${arch}`
  const ptyPrebuilds = join(nodeModules, 'node-pty', 'prebuilds')
  if (existsSync(ptyPrebuilds)) {
    for (const entry of readdirSync(ptyPrebuilds, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== keepPrebuild) remove(join(ptyPrebuilds, entry.name), stats)
    }
    if (platform === 'win32') {
      const windowsPrebuild = join(ptyPrebuilds, keepPrebuild)
      if (existsSync(windowsPrebuild)) {
        walk(windowsPrebuild, (path) => {
          if (path.endsWith('.pdb')) remove(path, stats)
        })
      }
    }
  }
  const sqlite = join(nodeModules, 'better-sqlite3')
  if (existsSync(sqlite)) {
    const prebuilds = join(sqlite, 'prebuilds')
    if (existsSync(prebuilds)) {
      for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
        if (entry.isFile() && entry.name !== `${platform}-${arch}.node`) remove(join(prebuilds, entry.name), stats)
      }
    }
    // C++ 源码只在从源码编译时使用。
    if (existsSync(join(sqlite, 'deps'))) remove(join(sqlite, 'deps'), stats)
  }

  // 4. 微软沙箱 SDK 按架构和平台分发二进制，只保留当前平台的一套。
  const mxcBin = join(nodeModules, '@microsoft/mxc-sdk', 'bin')
  if (existsSync(mxcBin)) {
    const sdkArch = arch === 'arm64' ? 'arm64' : 'x64'
    const platformBinaries = {
      darwin: ['libmxc_ffi.dylib', 'mxc-exec-mac'],
      linux: ['libmxc_ffi.so', 'lxc-exec'],
      win32: ['mxc_ffi.dll', 'wxc-exec.exe'],
    }
    for (const entry of readdirSync(mxcBin, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name !== sdkArch) {
        remove(join(mxcBin, entry.name), stats)
        continue
      }
      const current = join(mxcBin, entry.name)
      for (const file of readdirSync(current, { withFileTypes: true })) {
        if (!file.isFile()) continue
        if (!platformBinaries[platform]?.includes(file.name)) remove(join(current, file.name), stats)
      }
    }
  }

  // 5. pdfjs 只使用 legacy 构建，移除并存的现代构建副本。
  const pdfjsBuild = join(nodeModules, 'pdfjs-dist', 'build')
  if (existsSync(pdfjsBuild)) remove(pdfjsBuild, stats)

  // 服务端通过 mermaid.core.mjs 加载，保留其模块和分块，仅删除浏览器独立包。
  for (const name of ['mermaid.js', 'mermaid.min.js']) {
    const browserBundle = join(nodeModules, 'mermaid', 'dist', name)
    if (existsSync(browserBundle)) remove(browserBundle, stats)
  }
  // Sidecar 的代码高亮只使用 JS 模块。浏览器主题和 Sass 源码由前端单独构建。
  for (const name of ['styles', 'scss']) {
    const browserThemes = join(nodeModules, 'highlight.js', name)
    if (existsSync(browserThemes)) remove(browserThemes, stats)
  }

  const after = directorySize(host)
  return { removed: stats.removed, before, after, saved: before - after }
}

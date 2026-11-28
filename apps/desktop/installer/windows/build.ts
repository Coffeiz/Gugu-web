import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

type PackageRequire = NodeRequire

export async function configureWindowsInstaller(input: {
  stage: string
  feed?: string
  options: string[]
  seaConfig: Record<string, any>
  packageRequire: PackageRequire
  prepackaged?: string
}) {
  const { stage, feed, options, seaConfig, packageRequire, prepackaged } = input
  seaConfig.asarUnpack = seaConfig.asarUnpack.filter((path: string) => path !== 'dist/cli/gugu.cjs')
  let builtWindowsInstaller = false
  if (!options.includes('--dir')) {
    const arch = options.includes('--arm64') ? 'arm64' : 'x64'
    if (options.includes('--x64') && options.includes('--arm64')) throw new Error('Windows 安装器每次只构建一种架构')
    const { build, createTargets, Platform } = packageRequire('electron-builder')
    const templates = resolve(packageRequire.resolve('app-builder-lib'), '../../templates/nsis')
    const section = readFileSync(join(templates, 'installSection.nsh'), 'utf8')
    const marker = '!insertmacro installApplicationFiles'
    const uninstall = '!insertmacro uninstallOldVersion SHELL_CONTEXT\n!insertmacro handleUninstallResult SHELL_CONTEXT'
    const normalizedSection = section.replaceAll('\r\n', '\n')
    if (section.split(marker).length !== 2) throw new Error('NSIS 安装文件入口已变化')
    if (normalizedSection.split(uninstall).length !== 2) throw new Error('NSIS 升级入口已变化')
    writeFileSync(join(stage, 'installSection.nsh'), `\uFEFF!cd "${templates}"\n` +
      normalizedSection.replace(uninstall, '!insertmacro GuguUpgradeExistingInstall')
        .replace(marker, `SetDetailsPrint textonly\nSetOverwrite on\n${marker}`))
    const include = join(stage, 'gugu-progress.nsh')
    writeFileSync(include, `\uFEFF!define GUGU_INSTALL_SECTION_DIR "${stage}"\n!include "${resolve(seaConfig.nsis.include)}"\n`)
    seaConfig.nsis.include = include
    let packedDirectory = prepackaged
    seaConfig.directories.app = stage
    if (feed) {
      seaConfig.publish = { provider: 'generic', url: feed.replace(/\/+$/, '') + `/stable/win32-${arch}/` }
      seaConfig.directories.output = `release/win32-${arch}`
      seaConfig.forceCodeSigning = true
      seaConfig.win.signExecutable = true
      seaConfig.win.publisherName = process.env.GUGU_DESKTOP_WIN_PUBLISHER
    }
    await build({
      prepackaged,
      targets: createTargets([Platform.WINDOWS], 'nsis', arch),
      config: {
        // electron-builder 会自动加载仓库配置，这里只传安装器专用覆盖项。
        asarUnpack: seaConfig.asarUnpack,
        directories: seaConfig.directories,
        nsis: { include },
        ...(feed ? { publish: seaConfig.publish, forceCodeSigning: true, win: {
          signExecutable: true, publisherName: seaConfig.win.publisherName,
        } } : {}),
        afterPack: ({ appOutDir }: { appOutDir: string }) => {
          const packedManifest = join(appOutDir, 'resources/core-sidecar/manifest.json')
          const builtManifest = resolve('resources/core-sidecar-sea/manifest.json')
          if (!readFileSync(packedManifest).equals(readFileSync(builtManifest)))
            throw new Error('Windows 安装包的 Core 与本次构建不一致')
          packedDirectory = appOutDir
        },
      },
      publish: 'never',
      effectiveOptionComputed: ([defines]: [Record<string, string | null>]) => {
        if (!Object.hasOwn(defines, 'ZIP_COMPRESSION'))
          throw new Error('Windows 安装器的中间归档必须使用 ZIP')
        if (!packedDirectory) throw new Error('Windows 安装器缺少已打包的应用目录')
        // 从安装器直接写入目标目录，跳过临时 ZIP 的写入和解压。
        defines.APP_BUILD_DIR = packedDirectory
        // ZIP 不嵌入安装器，保留空间估算参数，移除未使用的归档路径。
        delete defines[arch === 'arm64' ? 'APP_ARM64' : 'APP_64']
        return false
      },
    })
    builtWindowsInstaller = true
  }
  const config = join(stage, 'sea-builder.json')
  writeFileSync(config, JSON.stringify(seaConfig))
  return { config, builtWindowsInstaller }
}

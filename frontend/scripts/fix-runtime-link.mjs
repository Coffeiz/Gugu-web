/**
 * 修复 npm 对 `file:` 依赖生成的 symlink 在个别环境下的断链问题。
 *
 * 背景：`gugu-interaction-runtime` 是 workspace 下与 Gugu-web 平级的兄弟仓库，
 * package.json 以 `file:../../gugu-interaction-runtime` 引用。npm（7+，实测
 * 11.x 亦然）生成 file: 依赖符号链接时对相对路径的基准与 OS 解析 symlink 的
 * 基准并不总是一致，可能导致 `node_modules/gugu-interaction-runtime` 断链，
 * 使 TS/Vite 无法解析该包。本脚本在 `npm install` / `npm ci` 后（postinstall）
 * 把链接统一修正为相对 node_modules 的正确路径。链接有效时幂等跳过。
 */
import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url)) // frontend/scripts
const link = join(root, '..', 'node_modules', 'gugu-interaction-runtime')
// 目标为 workspace 下与 Gugu-web 平级的兄弟仓库：
// frontend/scripts/.. = frontend，/.. = Gugu-web，/.. = workspace
const target = join(root, '..', '..', '..', 'gugu-interaction-runtime')

// 链接有效（能读到目标包的 package.json）则跳过
if (existsSync(join(link, 'package.json'))) {
  console.log('[fix-runtime-link] gugu-interaction-runtime 链接有效，跳过')
  process.exit(0)
}

// 已存在（断链 symlink 或 npm ci 复制的目录）则移除后重建
if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink() } catch { return false } })()) {
  const kind = (() => { try { return readlinkSync(link) } catch { return null } })()
  console.log(`[fix-runtime-link] 移除异常条目（${kind ? `symlink -> ${kind}` : '目录'}）: ${link}`)
  rmSync(link, { recursive: true, force: true })
}

const rel = relative(dirname(link), target)
symlinkSync(rel, link, 'dir')
console.log(`[fix-runtime-link] 已重建: ${link} -> ${rel} (${target})`)

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parse } from 'vue/compiler-sfc'

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
const electronRoot = resolve(sourceRoot, '../../desktop')
const contractRoot = resolve(sourceRoot, '../../../packages/desktop-contracts/src')
const aliases = new Map([['@', 'shared'], ['@desktop', 'desktop'], ['@web', 'web']])
const layers = new Set(aliases.values())
const violations = []

function layerOf(path) {
  const layer = relative(sourceRoot, path).split(sep)[0]
  return layers.has(layer) ? layer : undefined
}

function isWithin(root, path) {
  const first = relative(root, path).split(sep)[0]
  return first !== '..'
}

function checkImport(file, specifier) {
  const uiLayer = layerOf(file)
  if (uiLayer && uiLayer !== 'desktop' && specifier === '@gugu/desktop-contracts') {
    violations.push(`${relative(sourceRoot, file)} → ${specifier}`)
    return
  }
  const [prefix, ...segments] = specifier.split('/')
  let target
  if (aliases.has(prefix)) target = resolve(sourceRoot, aliases.get(prefix), segments.join('/'))
  else if (specifier.startsWith('.')) target = resolve(dirname(file), specifier)
  else if (specifier.startsWith('/src/')) target = resolve(sourceRoot, specifier.slice('/src/'.length))
  else return

  if ((uiLayer && isWithin(electronRoot, target))
    || (isWithin(electronRoot, file) && layerOf(target))
    || (isWithin(contractRoot, file) && (layerOf(target) || isWithin(electronRoot, target)))) {
    violations.push(`${relative(sourceRoot, file)} → ${specifier}`)
    return
  }

  const destination = layerOf(target)
  if (destination && destination !== 'shared' && destination !== layerOf(file)) {
    violations.push(`${relative(sourceRoot, file)} → ${specifier}`)
  }
}

function checkScript(file, content) {
  for (const dependency of ts.preProcessFile(content, true, true).importedFiles) {
    checkImport(file, dependency.fileName)
  }
}

function checkStyle(file, content) {
  for (const match of content.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g)) {
    checkImport(file, match[1])
  }
}

for (const root of [sourceRoot, resolve(electronRoot, 'src'), resolve(electronRoot, 'scripts'), contractRoot]) {
  for (const entry of readdirSync(root, { recursive: true })) {
    const file = resolve(root, entry)
    if ((root === sourceRoot && !layerOf(file)) || !/\.(vue|[cm]?[jt]sx?|css)$/.test(file)) continue
    const content = readFileSync(file, 'utf8')
    if (file.endsWith('.vue')) {
      const { descriptor } = parse(content, { filename: entry })
      const blocks = [descriptor.script, descriptor.scriptSetup, descriptor.template, ...descriptor.styles]
      for (const block of blocks) {
        if (block?.src) checkImport(file, block.src)
      }
      for (const script of [descriptor.script, descriptor.scriptSetup]) {
        if (script) checkScript(file, script.content)
      }
      for (const style of descriptor.styles) checkStyle(file, style.content)
    } else if (file.endsWith('.css')) {
      checkStyle(file, content)
    } else {
      checkScript(file, content)
    }
  }
}

if (violations.length) {
  console.error('前端分层依赖违规，请通过 shared、workspace 契约包或平台注入共享能力。')
  console.error(violations.join('\n'))
  process.exitCode = 1
} else {
  console.log('前端分层依赖检查通过。')
}

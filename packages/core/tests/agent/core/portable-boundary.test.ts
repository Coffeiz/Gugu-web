import { readFileSync, readdirSync } from 'node:fs'
import { dirname,relative,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect,it } from 'vitest'

it('Agent、Provider和共用Executor可移植入口的运行依赖闭包不装载平台、驱动或SDK', () => {
  const source = fileURLToPath(new URL('../../../src', import.meta.url))
  const sandbox = resolve(source, '../../sandbox/src')
  const visited = new Set<string>()
  const inspect = (file: string) => {
    if (visited.has(file)) return
    visited.add(file)
    const dependencies: string[] = []
    const parsed = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const walk = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
        dependencies.push((node.moduleSpecifier as ts.StringLiteral).text)
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier)
        dependencies.push((node.moduleSpecifier as ts.StringLiteral).text)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        throw new Error('可移植入口不能隐式动态装载后端')
      ts.forEachChild(node, walk)
    }
    walk(parsed)
    for (const dependency of dependencies) {
      if (dependency.startsWith('@gugu/sandbox/')) {
        const entry = dependency.slice('@gugu/sandbox/'.length)
        expect(['contracts', 'executor', 'policy']).toContain(entry)
        inspect(resolve(sandbox, `${entry}.ts`))
        continue
      }
      expect(dependency, relative(source, file)).toMatch(/^\./)
      const target = resolve(dirname(file), dependency.replace(/\.js$/, '.ts'))
      const within = file.startsWith(sandbox + '/') ? sandbox : source
      expect(relative(within, target).startsWith('..')).toBe(false)
      if (within === sandbox)
        expect(relative(sandbox, target).replaceAll('\\', '/')).not.toMatch(/^(linux|mxc)\//)
      expect(relative(source, target).replaceAll('\\', '/')).not.toMatch(/^(data|runtime)\//)
      expect(relative(source, target).replaceAll('\\', '/')).not.toMatch(/^agent\/executor\/(platform|mxc)\.ts$/)
      if (relative(source, file).replaceAll('\\', '/').startsWith('agent/context/history/'))
        expect(relative(source, target).replaceAll('\\', '/')).not.toMatch(/^agent\/(core\.ts$|run\/|interactions\/)/)
      inspect(target)
    }
  }
  const entries = [
    'agent/index.ts',
    'agent/runtime.ts',
    'agent/chat-service.ts',
    'agent/run/dispatch-worker.ts',
    'agent/run/dispatch-supervisor.ts',
    'agent/run/reconstruct.ts',
    'agent/run/event-stream.ts',
    'agent/providers/index.ts',
    'agent/executor/executor.ts',
    'agent/skills/runtime.ts',
  ]
  for (const entry of entries) inspect(resolve(source, entry))
  for (const entry of entries.slice(1, 7))
    expect(visited.has(resolve(source, entry)), `${entry} must remain inside the Core Agent runtime`).toBe(true)
  expect(visited.size).toBeGreaterThan(2)
})

it('IM Gateway 依赖 Core，Core 不反向依赖 Gateway', () => {
  const core = fileURLToPath(new URL('../../../', import.meta.url))
  const gateway = resolve(core, '../gateway')
  const coreManifest = JSON.parse(readFileSync(resolve(core, 'package.json'), 'utf8'))
  const gatewayManifest = JSON.parse(readFileSync(resolve(gateway, 'package.json'), 'utf8'))
  expect(gatewayManifest.dependencies['@gugu/core']).toBeDefined()
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    expect(coreManifest[field]?.['@gugu/gateway']).toBeUndefined()
  }

  const source = resolve(core, 'src')
  for (const path of readdirSync(source, { recursive: true, encoding: 'utf8' })) {
    if (!/\.[cm]?ts$/.test(path)) continue
    const file = resolve(source, path)
    const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
    for (const { fileName } of importedFiles) {
      expect(fileName, path).not.toMatch(/^@gugu\/gateway(?:\/|$)/)
      if (fileName.startsWith('.')) {
        const fromGateway = relative(gateway, resolve(dirname(file), fileName))
        expect(fromGateway.startsWith('..'), path).toBe(true)
      }
    }
  }
})

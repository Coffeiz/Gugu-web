import { readFileSync } from 'node:fs'
import { dirname,relative,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect,it } from 'vitest'

it('Harness、Provider和共用Executor可移植入口的运行依赖闭包不装载平台、驱动或SDK', () => {
  const source = fileURLToPath(new URL('../../../../src/', import.meta.url))
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
      expect(dependency, relative(source, file)).toMatch(/^\./)
      const target = resolve(dirname(file), dependency.replace(/\.js$/, '.ts'))
      expect(relative(source, target).startsWith('..')).toBe(false)
      expect(relative(source, target).replaceAll('\\', '/')).not.toMatch(/^(data|runtime)\//)
      expect(relative(source, target).replaceAll('\\', '/')).not.toMatch(/^agent\/executor\/(platform|mxc)\.ts$/)
      if (relative(source, file).replaceAll('\\', '/').startsWith('agent/harness/history/'))
        expect(relative(source, target).replaceAll('\\', '/')).not.toMatch(/^agent\/harness\/(streaming|interactions)\//)
      inspect(target)
    }
  }
  inspect(resolve(source, 'agent/harness/index.ts'))
  inspect(resolve(source, 'agent/providers/index.ts'))
  inspect(resolve(source, 'agent/executor/executor.ts'))
  expect(visited.size).toBeGreaterThan(2)
})

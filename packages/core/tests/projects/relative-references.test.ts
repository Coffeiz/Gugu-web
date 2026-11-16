import { expect, test } from 'vitest'
import { resolveRelativeReferences, type RelativeReferenceLookup } from '../../src/files/relative-references.js'

test('引用按路径限制在授权根内，保持输入顺序、编码、父级和文件优先规则', async () => {
  const files = new Set(['项目/计划.md', '项目/子目录/正文.md', '项目/子目录/同名', '项目/%zz', '项目/�'])
  const folders = new Set(['项目', '项目/子目录', '项目/子目录/同名'])
  const lookup: RelativeReferenceLookup<string, string> = {
    async fileAt(directory, name) { const path = [...directory, name].join('/'); return files.has(path) ? path : null },
    async folderAt(directory, name) { const path = [...directory, name].join('/'); return folders.has(path) ? path : null },
  }
  const paths = ['../%E8%AE%A1%E5%88%92.md?download=1#标题', './正文.md', '同名', '../子目录', '../../../越界',
    'https://example.invalid/a', '//example.invalid/a', '/绝对路径', '..\\越界', '正文%00.md', '../%zz', '../%FF', '../缺失/../计划.md']
  const resolved = await resolveRelativeReferences(['项目', '子目录'], paths, lookup)
  expect(resolved.map(row => row.path)).toEqual(paths)
  expect(resolved.map(({ file, folder }) => [file, folder])).toEqual([
    ['项目/计划.md', null], ['项目/子目录/正文.md', null], ['项目/子目录/同名', null], [null, '项目/子目录'],
    [null, null], [null, null], [null, null], [null, null], [null, null], [null, null],
    ['项目/%zz', null], ['项目/�', null], [null, null],
  ])
})

test('无效或越界引用不调用数据端口，查询失败必须传播而不是当不存在', async () => {
  let reads = 0
  const failure = new Error('合成查询失败')
  const lookup = { async fileAt() { reads++; throw failure }, async folderAt() { reads++; throw failure } }
  const invalid = ['../../越界', 'file:///越界', '%2F越界', 'C:%5C绝对路径', '', '#标题', '..']
  expect(await resolveRelativeReferences([], invalid, lookup)).toEqual(invalid.map(path => ({ path, file: null, folder: null })))
  expect(reads).toBe(0)
  await expect(resolveRelativeReferences([], ['可查询.md'], lookup)).rejects.toBe(failure)
})

import { mkdtemp, writeFile, readFile, symlink, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
const { openLocalFile } = await import(new URL('../../../../fs/src/node.ts', import.meta.url).href)
import type { ReadFilePorts } from '../../../src/agent/tools/files.js'
import { createReadFileTool } from '../../../src/agent/tools/files.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'

const identity = { ownerId: '小北', sessionId: '1', runId: 'run' }
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(content: string | Uint8Array = '甲\r\n乙\n丙', options: { relativePath?: string; extensionless?: boolean; openFile?: ReadFilePorts['openFile'] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-read-'))
  temporary.push(root)
  await writeFile(path.join(root, 'note'), content)
  const registry = createToolRegistry({ authorize: async () => true, tools: [createReadFileTool({
    openFile: options.openFile ?? openLocalFile,
    async resolveOwnedFile(scope, id) {
      return scope.ownerId === identity.ownerId && id === 1 ? { id, name: '便签', root, relativePath: options.relativePath ?? 'note', text: true, extensionless: options.extensionless ?? true } : null
    },
  })] })
  const dispatch = (input: unknown, ownerId = identity.ownerId, signal = new AbortController().signal) => registry.tools.dispatch({ id: 'call', name: 'read_file', input }, {
    identity: { ...identity, ownerId }, roundId: 'round', signal, resolution: null, execute: async () => { throw new Error('不应执行命令') },
  })
  return { root, dispatch }
}

describe('文件工具通过注册器读取真实临时文件', () => {
  it('保留原始换行、绝对行号和源字节数', async () => {
    const { dispatch } = await fixture()
    expect(await dispatch({ file_id: 1, target_lines: '2,3' })).toMatchObject({ kind: 'completed', successful: true, mutated: false,
      value: { file_id: 1, name: '便签', content: '乙\n丙', numbered_content: '2: 乙\n3: 丙', line_range: { start: 2, end: 3 }, _source_size_bytes: 12 } })
  })
  it('测试resolver将owner越权与不存在文件都隐藏数据', async () => {
    const { dispatch } = await fixture()
    expect(await dispatch({ file_id: 1 }, '其他用户')).toEqual(await dispatch({ file_id: 99 }))
  })
  it.each([{ file_id: 1, ownerId: '其他用户' }, { path: '/etc/passwd' }, { file_id: -1 }, { file_id: 1, items: [] }])('拒绝扩大来源或身份的参数 %j', async input => {
    expect(await (await fixture()).dispatch(input)).toMatchObject({ successful: false, executed: false })
  })
  it('无后缀二进制与非法UTF8不可作为文本读取', async () => {
    for (const content of [new Uint8Array([0, 1]), new Uint8Array([255])]) {
      expect(await (await fixture(content)).dispatch({ file_id: 1 })).toMatchObject({ successful: false, value: { error: '内容不是 UTF-8 文本' } })
    }
  })
  it('拒绝符号链接且错误不泄露物理路径', async () => {
    const { root, dispatch } = await fixture()
    await rm(path.join(root, 'note'))
    await symlink(path.join(root, 'missing-private'), path.join(root, 'note'))
    const result = await dispatch({ file_id: 1 })
    expect(result).toMatchObject({ successful: false })
    expect(JSON.stringify(result)).not.toContain(root)
  })
  it('空文件、范围越界和取消保持原契约', async () => {
    const { dispatch } = await fixture('')
    expect(await dispatch({ file_id: 1 })).toMatchObject({ successful: true, value: { content: '', numbered_content: '', line_range: { start: 0, end: 0 } } })
    expect(await dispatch({ file_id: 1, target_lines: '1' })).toMatchObject({ successful: false })
    const controller = new AbortController(); controller.abort()
    await expect(dispatch({ file_id: 1 }, identity.ownerId, controller.signal)).rejects.toThrow()
  })
})


describe('文件读取安全边界', () => {
  it.each(['../outside', '/absolute', 'nested/../../outside', 'nested\\outside', 'note\0private'])('真实FS拒绝越界路径 %j', async relativePath => {
    const { dispatch } = await fixture('', { relativePath })
    expect(await dispatch({ file_id: 1 })).toMatchObject({ successful: false })
  })
  it.each([false, true])('拒绝指向根内或根外真实文件的符号链接 outside=%s', async outside => {
    const { root, dispatch } = await fixture()
    const target = outside ? (await fixture('保密')).root : root
    await writeFile(path.join(target, 'private'), '保密')
    await rm(path.join(root, 'note'))
    await symlink(path.join(target, 'private'), path.join(root, 'note'))
    const result = await dispatch({ file_id: 1 })
    expect(result).toMatchObject({ successful: false })
    expect(JSON.stringify(result)).not.toContain('保密')
  })
  it('stat超32MiB不读取，且关闭已打开的真实句柄', async () => {
    let read = false
    let closed = false
    const { root, dispatch } = await fixture('', { openFile: async (root, relative) => {
      const opened = await openLocalFile(root, relative)
      return { ...opened, handle: { read: async () => { read = true; return { bytesRead: 0 } }, close: async () => { await opened.handle.close(); closed = true } } }
    } })
    await truncate(path.join(root, 'note'), 32 * 1024 * 1024 + 1)
    expect(await dispatch({ file_id: 1 })).toMatchObject({ successful: false, value: { error: '文件过大，超出可读上限' } })
    expect(read).toBe(false)
    expect(closed).toBe(true)
  })
  it('恰好32MiB可读，正文仍遵守普通文本字符上限', async () => {
    const { root, dispatch } = await fixture('', { extensionless: false })
    await truncate(path.join(root, 'note'), 32 * 1024 * 1024)
    expect(await dispatch({ file_id: 1 })).toMatchObject({ successful: true, value: { _source_size_bytes: 32 * 1024 * 1024, content: '\0'.repeat(200000) } })
  })
  it('stat后真实文件增长不能绕过字节限制', async () => {
    const { dispatch } = await fixture('', { openFile: async (root, relative) => {
      const opened = await openLocalFile(root, relative)
      await truncate(path.join(root, relative), 32 * 1024 * 1024 + 1)
      return opened
    } })
    expect(await dispatch({ file_id: 1 })).toMatchObject({ successful: false, value: { error: '文件过大，超出可读上限' } })
  })
  it('读取期间取消必须先关闭真实句柄再返回', async () => {
    const controller = new AbortController()
    let closed = false
    const { dispatch } = await fixture('内容', { openFile: async (root, relative) => {
      const opened = await openLocalFile(root, relative)
      return { ...opened, handle: {
        read: async (...args: Parameters<NonNullable<Awaited<ReturnType<ReadFilePorts['openFile']>>>['handle']['read']>) => {
          const result = await opened.handle.read(...args)
          controller.abort()
          return result
        },
        close: async () => { await opened.handle.close(); closed = true },
      } }
    } })
    await expect(dispatch({ file_id: 1 }, identity.ownerId, controller.signal)).rejects.toThrow()
    expect(closed).toBe(true)
  })
  it('普通文本沿用Python替换解码、保留BOM及200000 Unicode字符上限', async () => {
    const bytes = new Uint8Array([239, 187, 191, 255])
    expect(await (await fixture(bytes, { extensionless: false })).dispatch({ file_id: 1 })).toMatchObject({ value: { content: '\ufeff\ufffd' } })
    const text = '😀'.repeat(200001)
    expect(await (await fixture(text, { extensionless: false })).dispatch({ file_id: 1 })).toMatchObject({ value: { content: '😀'.repeat(200000), _source_size_bytes: 800004 } })
  })
})


describe('文本行选择对齐Python Unicode行号与空白规则', () => {
  it.each([
    { target: '\u001cALL\u001f', content: '甲\r\n乙\n丙', numbered: '1: 甲\n2: 乙\n3: 丙', start: 1, end: 3 },
    { target: '２', content: '乙\n', numbered: '2: 乙', start: 2, end: 2 },
    { target: '٢-٣', content: '乙\n丙', numbered: '2: 乙\n3: 丙', start: 2, end: 3 },
    { target: '２,٣', content: '乙\n丙', numbered: '2: 乙\n3: 丙', start: 2, end: 3 },
    { target: '𝟚-३', content: '乙\n丙', numbered: '2: 乙\n3: 丙', start: 2, end: 3 },
    { target: '\u0085２\u001c-\u2003٣\u001f', content: '乙\n丙', numbered: '2: 乙\n3: 丙', start: 2, end: 3 },
  ])('实际文件读取选择原始物理行：$target', async expected => {
    const original = '甲\r\n乙\n丙'
    const f = await fixture(original)
    expect(await f.dispatch({ file_id: 1, target_lines: expected.target })).toMatchObject({ successful: true, mutated: false,
      value: { content: expected.content, numbered_content: expected.numbered, line_range: { start: expected.start, end: expected.end } } })
    expect(await readFile(path.join(f.root, 'note'), 'utf8')).toBe(original)
  })
  it.each(['\ufeffall', '\ufeff1', 'all\ufeff', '1\ufeff', '²', 'Ⅱ', '②', '2\u200b', '-1', '2--3', '2,,3', '2-,3',
    String.fromCodePoint(0x11de2), `${String.fromCodePoint(0x11de2)}-3`])('非法行选择安全拒绝且不改变原文件：%j', async target => {
    const original = '甲\r\n乙\n丙'
    const f = await fixture(original)
    expect(await f.dispatch({ file_id: 1, target_lines: target })).toMatchObject({ successful: false, mutated: false })
    expect(await readFile(path.join(f.root, 'note'), 'utf8')).toBe(original)
  })
  it.each(['\v', '\f', '\u001c', '\u001d', '\u001e', '\u0085', '\u2028', '\u2029'])('普通文本splitlines识别分隔符但numbered仅去CR/LF：%j', async separator => {
    const original = `甲${separator}乙`
    const f = await fixture(original, { extensionless: false })
    expect(await f.dispatch({ file_id: 1, target_lines: '１' })).toMatchObject({ successful: true,
      value: { content: `甲${separator}`, numbered_content: `1: 甲${separator}`, line_range: { start: 1, end: 1 } } })
    expect(await f.dispatch({ file_id: 1, target_lines: '２' })).toMatchObject({ successful: true,
      value: { content: '乙', numbered_content: '2: 乙', line_range: { start: 2, end: 2 } } })
    expect(await readFile(path.join(f.root, 'note'), 'utf8')).toBe(original)
  })
})

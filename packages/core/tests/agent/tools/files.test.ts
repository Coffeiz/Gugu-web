import { mkdtemp, writeFile, readFile, symlink, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
const { openLocalFile } = await import(new URL('../../../../fs/src/node.ts', import.meta.url).href)
import type { FileArchivePort, FileDeletePort, FileEditPort, ReadFilePorts } from '../../../src/agent/tools/files.js'
import { createDeleteFileTool, createListRecentAttachmentsTool, createPresentFileTool, createOwnedTextReader, createSaveAttachmentTool } from '../../../src/agent/tools/files.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'

const identity = { ownerId: '小北', sessionId: '1', runId: 'run' }
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(content: string | Uint8Array = '甲\r\n乙\n丙', options: { relativePath?: string; writePath?: string; extensionless?: boolean; extension?: string; openFile?: ReadFilePorts['openFile']; resolveFilePath?: ReadFilePorts['resolveFilePath'] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-read-'))
  temporary.push(root)
  await writeFile(path.join(root, options.writePath ?? 'note'), content)
  const read = createOwnedTextReader({
    openFile: options.openFile ?? openLocalFile,
    async resolveOwnedFile(scope, id) {
      return scope.ownerId === identity.ownerId && id === 1 ? { id, name: options.extension ? `便签.${options.extension}` : '便签', root,
        relativePath: options.relativePath ?? 'note', text: !options.extension, extension: options.extension,
        extensionless: options.extensionless ?? !options.extension } : null
    },
    ...(options.resolveFilePath ? { resolveFilePath: options.resolveFilePath } : {}),
  })
  const dispatch = (input: unknown, ownerId = identity.ownerId, signal = new AbortController().signal) => read(input, {
    identity: { ...identity, ownerId }, signal,
  })
  return { root, dispatch }
}

describe('受控正文读取使用真实临时文件', () => {
  it('正文读取 只通过 Host 解析逻辑路径，不接受宿主路径或混合定位参数', async () => {
    const { dispatch } = await fixture('路径内容', { resolveFilePath: async (current, file) =>
      current.ownerId === identity.ownerId && file === '/personal/便签.txt'
        ? { id: 1, name: '便签.txt', root: temporary[0]!, relativePath: 'note', text: true, extensionless: false }
        : null,
    })
    expect(await dispatch({ file: '/personal/便签.txt' })).toMatchObject({ successful: true, value: { file_id: 1, name: '便签.txt', content: '路径内容' } })
    expect(await dispatch({ file: '/private/etc/passwd' })).toMatchObject({ successful: false })
    expect(await dispatch({ file: '/personal/../secret' })).toMatchObject({ successful: false })
    expect(await dispatch({ file: '/personal/便签.txt', file_id: 1 })).toMatchObject({ successful: false })
  })

  it('正文读取服务 提取受限 Office 文档正文并保留行号结果', async () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['事项', '详情'], ['合成计划', 'owner 内容']]), '计划')
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array
    const { dispatch } = await fixture(bytes, { relativePath: 'report.xlsx', writePath: 'report.xlsx', extension: 'xlsx' })
    const result = await dispatch({ file_id: 1, target_lines: '2-3' })
    expect(result).toMatchObject({ successful: true, value: {
      name: '便签.xlsx', content: expect.stringContaining('合成计划'), numbered_content: expect.stringContaining('2:'),
      line_range: { start: 2, end: 3 },
    } })
  })

  it('正文读取 通过 attach_id 读取 owner 聊天文本附件，支持批量和类型拒绝', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gugu-read-attachment-'))
    temporary.push(root)
    const content = '附件第一行\n附件第二行'
    await writeFile(path.join(root, 'attachment.txt'), content, 'utf8')
    let opens = 0
    const read = createOwnedTextReader({
      async resolveOwnedFile() { return null },
      async resolveOwnedAttachment(current, attachId) {
        if (current.ownerId !== identity.ownerId) return null
        if (attachId === 'owner-text') return {
          attach_id: attachId, name: '历史备注.txt', kind: 'text', extension: 'txt', size_bytes: Buffer.byteLength(content),
          root, relativePath: 'attachment.txt',
        }
        if (attachId === 'owner-image') return {
          attach_id: attachId, name: '照片.png', kind: 'image', extension: 'png', size_bytes: 4,
          root, relativePath: 'attachment.txt',
        }
        return null
      },
      async openFile(fileRoot, relativePath) { opens++; return openLocalFile(fileRoot, relativePath) },
    })
    const dispatch = (input: unknown, ownerId = identity.ownerId) => read(input, {
      identity: { ...identity, ownerId }, signal: new AbortController().signal,
    })
    expect(await dispatch({ attach_id: 'owner-text', target_lines: '2' })).toMatchObject({
      kind: 'completed', successful: true, mutated: false,
      value: { attach_id: 'owner-text', name: '历史备注.txt', content: '附件第二行', numbered_content: '2: 附件第二行', line_range: { start: 2, end: 2 } },
    })
    expect(await dispatch({ items: [{ attach_id: 'owner-text', title: '历史附件' }] })).toMatchObject({
      kind: 'completed', successful: true,
      value: { successful_count: 1, failed_count: 0, results: [{ label: '历史附件', successful: true, value: { attach_id: 'owner-text', content } }] },
    })
    expect(await dispatch({ attach_id: 'owner-image' })).toMatchObject({
      kind: 'completed', successful: false, value: { error: '历史附件目前只支持文本和 PDF/Office 正文读取' },
    })
    expect(await dispatch({ attach_id: 'owner-text' }, 'other-owner')).toMatchObject({ successful: false })
    expect(opens).toBe(2, '不支持的媒体和异主附件不得打开文件字节')
    expect(await dispatch({ attach_id: 'owner-text', file_id: 1 })).toMatchObject({ successful: false, executed: false })
  })

  it('近期附件经 Core 注册器返回元数据并绑定当前身份，不声称可直接读取媒体', async () => {
    const received: unknown[] = []
    const registry = createToolRegistry({ authorize: async () => true, tools: [createListRecentAttachmentsTool({
      async list(current, signal) {
        received.push(current)
        signal.throwIfAborted()
        return [{ attach_id: 'attachment-synthetic', name: '图片.png', ext: 'png', kind: 'image', platform: 'web',
          size_bytes: 12, img_width: 2, img_height: 3, state: 'attached' }]
      },
    })] })
    const result = await registry.tools.dispatch({ id: 'recent', name: 'list_recent_attachments', input: {} }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('只读附件列表不得调用执行后端') },
    })
    expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: false,
      value: { count: 1, items: [{ attach_id: 'attachment-synthetic', size_bytes: 12, state: 'attached' }],
        note: expect.stringContaining('save_attachment') } })
    expect(received).toEqual([identity])
  })
  it('近期附件工具拒绝额外参数并脱敏 Host 读取错误', async () => {
    let calls = 0
    const registry = createToolRegistry({ authorize: async () => true, tools: [createListRecentAttachmentsTool({
      async list() { calls++; throw new Error('/private/storage/secret-key') },
    })] })
    const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'recent', name: 'list_recent_attachments', input }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('不应执行') },
    })
    expect(await dispatch({ owner_id: 'someone-else' })).toMatchObject({ successful: false, executed: false })
    expect(calls).toBe(0)
    const result = await dispatch({})
    expect(result).toMatchObject({ successful: false, value: { error: '近期附件读取失败' } })
    expect(JSON.stringify(result)).not.toContain('/private/storage')
  })
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
  it('批量读取逐项隔离失败、保留顺序并隐藏各项源文件大小', async () => {
    const f = await fixture('甲\n乙\n丙')
    const read = createOwnedTextReader({
      openFile: openLocalFile,
      async resolveOwnedFile(scope, id) {
        if (scope.ownerId !== identity.ownerId || id === 99) return null
        return { id, name: `文件${id}`, root: f.root, relativePath: 'note', text: true, extensionless: true }
      },
    })
    const result = await read({ items: [
      { file_id: 1, target_lines: '2', title: '第二项' }, { file_id: 99 }, { file_id: 2, target_lines: '1', result_id: 'third' },
    ] }, { identity, signal: new AbortController().signal })
    expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: false, value: {
      successful_count: 2, failed_count: 1, results: [
        { index: 1, label: '第二项', successful: true, value: { file_id: 1, content: '乙\n', numbered_content: '2: 乙', line_range: { start: 2, end: 2 } } },
        { index: 2, label: '文件 99', successful: false, value: { error: '文件不存在或无权访问' } },
        { index: 3, label: 'third', successful: true, value: { file_id: 2, content: '甲\n', numbered_content: '1: 甲' } },
      ],
    } })
    expect((result.value as { results: Array<{ value: Record<string, unknown> }> }).results.every(item => !('_source_size_bytes' in item.value))).toBe(true)
  })
  it('批量超出 20 项或混用单项来源时在访问文件前拒绝', async () => {
    let resolutions = 0
    const read = createOwnedTextReader({
      async resolveOwnedFile() { resolutions++; return null },
      async openFile() { throw new Error('不可打开') },
    })
    const dispatch = (input: unknown) => read(input, {
      identity, signal: new AbortController().signal,
    })
    expect(await dispatch({ items: Array.from({ length: 21 }, (_, index) => ({ file_id: index + 1 })) })).toMatchObject({ successful: false })
    expect(await dispatch({ file_id: 1, items: [{ file_id: 2 }] })).toMatchObject({ successful: false })
    expect(resolutions).toBe(0)
  })
  it('批量总量达到64MiB后不再打开后续文件', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gugu-read-batch-cap-'))
    temporary.push(root)
    let resolved = 0
    const read = createOwnedTextReader({
      async resolveOwnedFile(_scope, id) {
        resolved++
        return { id, name: `文件${id}`, root, relativePath: 'synthetic', text: true, extensionless: false }
      },
      async openFile() {
        const size = 32 * 1024 * 1024
        let position = 0
        return { size, handle: {
          async read(buffer, offset, length) {
            const bytesRead = Math.min(length, size - position)
            buffer.fill(0x61, offset, offset + bytesRead)
            position += bytesRead
            return { bytesRead }
          },
          async close() {},
        } }
      },
    })
    const result = await read({ items: [
      { file_id: 1 }, { file_id: 2 }, { file_id: 3 },
    ] }, { identity, signal: new AbortController().signal })
    expect(result).toMatchObject({ successful: true, value: { successful_count: 2, failed_count: 1,
      total_source_size_bytes: 64 * 1024 * 1024,
      results: [{ successful: true }, { successful: true }, { successful: false, value: { error: '已达到批次源文件总量上限，后续项目未读取' } }],
    } })
    expect(resolved).toBe(2)
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

describe('聊天附件保存工具注册器行为', () => {
  it('只转发精确附件来源和可信 owner，支持批量/最近来源并拒绝歧义参数', async () => {
    const calls: Array<{ owner: string; input: unknown }> = []
    let authorized = true
    const registry = createToolRegistry({ authorize: async (current, name) => authorized && current.ownerId === identity.ownerId && name === 'save_attachment',
      tools: [createSaveAttachmentTool({ async save(current, input) {
        calls.push({ owner: current.ownerId, input })
        return { kind: 'saved', mutated: true, value: { file_id: calls.length, name: 'saved.txt', size: 4 } }
      } })] })
    const dispatch = (input: unknown, owner = identity.ownerId) => registry.tools.dispatch({ id: 'save', name: 'save_attachment', input }, {
      identity: { ...identity, ownerId: owner }, roundId: 'round', signal: new AbortController().signal,
      resolution: null, execute: async () => { throw new Error('不允许执行 Shell') },
    })
    expect(await dispatch({ attach_id: 'attachment-1' })).toMatchObject({ successful: true, mutated: true, value: { file_id: 1 } })
    expect(calls[0]).toEqual({ owner: identity.ownerId, input: { source: 'attach_id', attach_id: 'attachment-1', space: 'personal' } })
    expect(await dispatch({ source: 'attach_ids', attach_ids: ['attachment-2', 'attachment-3'], space: 'project', project_id: 7, folder_path: '资料' }))
      .toMatchObject({ successful: true, value: { file_id: 2 } })
    expect(await dispatch({ source: 'latest' })).toMatchObject({ successful: true, value: { file_id: 3 } })
    expect(await dispatch({ attach_id: 'folder-path', folder_path: '资料/项目' })).toMatchObject({ successful: true })
    expect(calls[3]?.input).toMatchObject({ source: 'attach_id', attach_id: 'folder-path', folder_path: '资料/项目' })
    expect(await dispatch({ attach_id: 'attachment-workspace', space: 'workspace' })).toMatchObject({ successful: true, value: { file_id: 5 } })
    expect(calls[4]).toEqual({ owner: identity.ownerId,
      input: { source: 'attach_id', attach_id: 'attachment-workspace', space: 'workspace' } })
    expect(await dispatch({ source: 'latest', attach_id: 'must-not-fallback' })).toMatchObject({ successful: false, executed: false })
    expect(await dispatch({ attach_ids: ['same', 'same'] })).toMatchObject({ successful: false, executed: false })
    expect(await dispatch({ attach_id: 'bad-folder', folder_path: '../越界' })).toMatchObject({ successful: false, executed: false })
    expect(await dispatch({ attach_id: 'wrong-scope', space: 'workspace', project_id: 7 })).toMatchObject({ successful: false, executed: false })
    authorized = false
    expect(await dispatch({ attach_id: 'attachment-4' })).toMatchObject({ successful: false, executed: false })
    expect(calls).toHaveLength(5)
  })
})

describe('文件软删除工具注册器行为', () => {
  it('按稳定文件 ID 或 owner 解析的登记路径调用端口，并拒绝宿主路径和额外参数', async () => {
    const calls: unknown[] = []
    const registry = createToolRegistry({ authorize: async (current, name) => current.ownerId === identity.ownerId && name === 'delete_file',
      tools: [createDeleteFileTool({ async resolveFilePath(current, path) {
        calls.push(['resolve', current, path])
        return path === '/personal/计划.md' ? 75 : null
      }, async remove(current, fileId) {
        calls.push([current, fileId])
        return { kind: 'completed', successful: true, mutated: true,
          value: { success: true, file_id: fileId, note: '已移入回收站，30 天内可还原' } }
      }, async removeMany(current, fileIds) {
        calls.push([current, fileIds])
        return { kind: 'completed', successful: true, mutated: true, value: { success: true, deleted_count: fileIds.length } }
      } })] })
    const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'delete-file', name: 'delete_file', input }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('文件删除不得执行宿主 Shell') },
    })
    expect(await dispatch({ file_id: 72 })).toMatchObject({ kind: 'completed', successful: true, mutated: true,
      value: { success: true, file_id: 72 } })
    expect(await dispatch({ file_ids: [73, 74] })).toMatchObject({ kind: 'completed', successful: true, mutated: true,
      value: { success: true, deleted_count: 2 } })
    expect(await dispatch({ file: '/personal/计划.md' })).toMatchObject({ kind: 'completed', successful: true, mutated: true,
      value: { success: true, file_id: 75 } })
    expect(await dispatch({ file: '/personal/../outside.txt' })).toMatchObject({ kind: 'completed', successful: false, mutated: false })
    expect(await dispatch({ file: '/etc/passwd' })).toMatchObject({ kind: 'completed', successful: false, mutated: false })
    expect(await dispatch({ file: '/personal/absent.txt' })).toMatchObject({ kind: 'completed', successful: false, mutated: false })
    expect(await dispatch({ file_ids: [73, 73] })).toMatchObject({ kind: 'completed', successful: false, mutated: false })
    expect(calls).toHaveLength(5)
    expect(calls[0]).toEqual([identity, 72])
    expect(calls[1]).toEqual([identity, [73, 74]])
    expect(calls[2]).toEqual(['resolve', identity, '/personal/计划.md'])
    expect(calls[3]).toEqual([identity, 75])
    expect(calls[4]).toEqual(['resolve', identity, '/personal/absent.txt'])
  })
})

it('桌面引用回执同时提供文件的真实路径和可点击链接', async () => {
  const absolute = '/synthetic/工作区/文件.md'
  const registry = createToolRegistry({ authorize: async () => true, tools: [createPresentFileTool({
    async resolve(_identity, selector) {
      expect(selector).toEqual({ file: absolute, reference_only: true })
      return { file: { referenceId: 'drop-synthetic', name: '文件', ext: 'md', location: { kind: 'host_absolute', value: absolute }, surface: 'desktop' } }
    },
  })] })
  const result = await registry.tools.dispatch({ id: 'present-path', name: 'open_item',
    input: { kind: 'file', item: absolute, reference_only: true } }, {
    identity, roundId: '1', signal: new AbortController().signal, resolution: null,
    async execute() { throw new Error('不执行宿主机命令') },
  })
  expect(result).toMatchObject({ successful: true, value: { location: { kind: 'host_absolute', value: absolute }, link: 'gugu://open-object/file/drop-synthetic' } })
})

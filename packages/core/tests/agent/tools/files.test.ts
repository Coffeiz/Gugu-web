import { mkdtemp, writeFile, readFile, symlink, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
const { openLocalFile } = await import(new URL('../../../../fs/src/node.ts', import.meta.url).href)
import type { FileArchivePort, FileDeletePort, FileEditPort, ReadFilePorts } from '../../../src/agent/tools/files.js'
import { createCopyFileTool, createCreateFileTool, createCreateFolderTool, createDeleteFileTool, createEditFileTool, createFileArchiveTools, createGrepFilesTool, createListDirectoryTool, createListRecentAttachmentsTool, createMoveItemsTool, createReadFileTool, createRenameFileTool, createRenameFolderTool, createSaveUploadedFileTool } from '../../../src/agent/tools/files.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'

const identity = { ownerId: '小北', sessionId: '1', runId: 'run' }
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(content: string | Uint8Array = '甲\r\n乙\n丙', options: { relativePath?: string; writePath?: string; extensionless?: boolean; extension?: string; openFile?: ReadFilePorts['openFile']; resolveFilePath?: ReadFilePorts['resolveFilePath'] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-read-'))
  temporary.push(root)
  await writeFile(path.join(root, options.writePath ?? 'note'), content)
  const registry = createToolRegistry({ authorize: async () => true, tools: [createReadFileTool({
    openFile: options.openFile ?? openLocalFile,
    async resolveOwnedFile(scope, id) {
      return scope.ownerId === identity.ownerId && id === 1 ? { id, name: options.extension ? `便签.${options.extension}` : '便签', root,
        relativePath: options.relativePath ?? 'note', text: !options.extension, extension: options.extension,
        extensionless: options.extensionless ?? !options.extension } : null
    },
    ...(options.resolveFilePath ? { resolveFilePath: options.resolveFilePath } : {}),
  })] })
  const dispatch = (input: unknown, ownerId = identity.ownerId, signal = new AbortController().signal) => registry.tools.dispatch({ id: 'call', name: 'read_file', input }, {
    identity: { ...identity, ownerId }, roundId: 'round', signal, resolution: null, execute: async () => { throw new Error('不应执行命令') },
  })
  return { root, dispatch }
}

describe('文件工具通过注册器读取真实临时文件', () => {
  it('read_file 只通过 Host 解析逻辑路径，不接受宿主路径或混合定位参数', async () => {
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

  it('read_file 经真实 ToolRegistry 提取受限 Office 文档正文并保留行号结果', async () => {
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

  it('read_file 通过 attach_id 读取 owner 聊天文本附件，支持批量和类型拒绝', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gugu-read-attachment-'))
    temporary.push(root)
    const content = '附件第一行\n附件第二行'
    await writeFile(path.join(root, 'attachment.txt'), content, 'utf8')
    let opens = 0
    const registry = createToolRegistry({ authorize: async () => true, tools: [createReadFileTool({
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
    })] })
    const dispatch = (input: unknown, ownerId = identity.ownerId) => registry.tools.dispatch({ id: 'attachment', name: 'read_file', input }, {
      identity: { ...identity, ownerId }, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('read_file 不得执行宿主命令') },
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

  it('grep 经真实 Core ToolRegistry 按逻辑路径逐行匹配并保留上下文和排序', async () => {
    const candidates = [
      { file_id: 2, name: '第二.txt', space: 'personal' as const, path: '/personal/第二.txt', project_id: null,
        folder_id: null, workspace_directory_id: null, size_bytes: 20, is_text: true },
      { file_id: 3, name: '二进制.bin', space: 'personal' as const, path: '/personal/二进制.bin', project_id: null,
        folder_id: null, workspace_directory_id: null, size_bytes: 2, is_text: false },
      { file_id: 1, name: '第一.txt', space: 'project' as const, path: '/project/项目/第一.txt', project_id: 7,
        folder_id: 8, workspace_directory_id: null, size_bytes: 30, is_text: true },
    ]
    const registry = createToolRegistry({ authorize: async () => true, tools: [createGrepFilesTool({
      async list(current) { expect(current).toEqual(identity); return candidates },
      async readText(_current, fileId) { return fileId === 2 ? '前行\nNeedle 在这一行\n后行' : '前缀\nneedle 在项目里\n尾行' },
    })] })
    const result = await registry.tools.dispatch({ id: 'grep', name: 'grep', input: {
      query: 'needle', context_lines: 1, path: '/project/项目',
    } }, { identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('grep 不得运行 shell') } })
    expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: false, value: {
      success: true, query: 'needle', path: '/project/项目', context_lines: 1, scanned_files: 1, skipped_files: 0,
      matched_files: 1, total_matches: 1, results: [{ file_id: 1, path: '/project/项目/第一.txt', matches: [{
        line: 2, text: 'needle 在项目里', context: [{ line: 1, text: '前缀' }, { line: 2, text: 'needle 在项目里' }, { line: 3, text: '尾行' }],
      }] }],
    } })
  })
  it('grep 拒绝物理路径/越界逻辑路径、限制关键词并脱敏单文件读取失败', async () => {
    let reads = 0
    const registry = createToolRegistry({ authorize: async () => true, tools: [createGrepFilesTool({
      async list() { return [{ file_id: 1, name: '文件.txt', space: 'personal', path: '/personal/文件.txt',
        project_id: null, folder_id: null, workspace_directory_id: null, size_bytes: 1, is_text: true }] },
      async readText() { reads++; throw new Error('/private/storage/private-key') },
    })] })
    const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'grep', name: 'grep', input }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('不得调用执行后端') },
    })
    expect(await dispatch({ query: 'x', path: '/personal/../secret' })).toMatchObject({ successful: false, value: { error: '路径不能包含空目录、. 或 ..' } })
    expect(await dispatch({ query: 'x', path: '/etc/passwd' })).toMatchObject({ successful: false, value: { error: '路径只允许 /personal、/project 或 /workspace' } })
    expect(await dispatch({ query: 'x'.repeat(501) })).toMatchObject({ successful: false })
    const failedRead = await dispatch({ query: 'private' })
    expect(failedRead).toMatchObject({ successful: true, value: { skipped_files: 1, total_matches: 0 } })
    expect(JSON.stringify(failedRead)).not.toContain('/private/storage')
    expect(reads).toBe(1)
  })
  it('grep 不搜索内嵌 Base64，并在总结果字节上限处报告截断', async () => {
    const candidate = { file_id: 1, name: '图文.svg', space: 'personal' as const, path: '/personal/图文.svg',
      project_id: null, folder_id: null, workspace_directory_id: null, size_bytes: 10, is_text: true }
    const registry = createToolRegistry({ authorize: async () => true, tools: [createGrepFilesTool({
      async list() { return [candidate] },
      async readText(_identity, _fileId, signal) {
        signal.throwIfAborted()
        return `data:image/png;base64,${'needle'.repeat(40)}\n普通 needle 命中`
      },
    })] })
    const base64 = await registry.tools.dispatch({ id: 'grep-data', name: 'grep', input: { query: 'needle', context_lines: 0 } }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('grep 不得调用 Shell') },
    })
    expect(base64).toMatchObject({ successful: true, value: { total_matches: 1, truncated: true,
      truncation_reasons: ['embedded_data_uri'], results: [{ matches: [{ line: 2, text: '普通 needle 命中' }] }] } })

    const large = createToolRegistry({ authorize: async () => true, tools: [createGrepFilesTool({
      async list() { return [candidate] },
      async readText() { return Array.from({ length: 220 }, (_, index) => `needle-${index}${'x'.repeat(680)}`).join('\n') },
    })] })
    const capped = await large.tools.dispatch({ id: 'grep-cap', name: 'grep', input: { query: 'needle', context_lines: 0, limit: 200 } }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('grep 不得调用 Shell') },
    })
    expect(capped).toMatchObject({ successful: true, value: { truncated: true,
      truncation_reasons: ['match_limit', 'result_byte_limit'] } })
    expect((capped.value as { total_matches: number }).total_matches).toBeLessThan(200)
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
        note: expect.stringContaining('save_uploaded_file') } })
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
    const registry = createToolRegistry({ authorize: async () => true, tools: [createReadFileTool({
      openFile: openLocalFile,
      async resolveOwnedFile(scope, id) {
        if (scope.ownerId !== identity.ownerId || id === 99) return null
        return { id, name: `文件${id}`, root: f.root, relativePath: 'note', text: true, extensionless: true }
      },
    })] })
    const result = await registry.tools.dispatch({ id: 'batch', name: 'read_file', input: { items: [
      { file_id: 1, target_lines: '2', title: '第二项' }, { file_id: 99 }, { file_id: 2, target_lines: '1', result_id: 'third' },
    ] } }, { identity, roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行命令') } })
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
    const tool = createReadFileTool({
      async resolveOwnedFile() { resolutions++; return null },
      async openFile() { throw new Error('不可打开') },
    })
    const registry = createToolRegistry({ authorize: async () => true, tools: [tool] })
    const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'invalid', name: 'read_file', input }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行命令') },
    })
    expect(await dispatch({ items: Array.from({ length: 21 }, (_, index) => ({ file_id: index + 1 })) })).toMatchObject({ successful: false })
    expect(await dispatch({ file_id: 1, items: [{ file_id: 2 }] })).toMatchObject({ successful: false })
    expect(resolutions).toBe(0)
  })
  it('批量总量达到64MiB后不再打开后续文件', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gugu-read-batch-cap-'))
    temporary.push(root)
    let resolved = 0
    const registry = createToolRegistry({ authorize: async () => true, tools: [createReadFileTool({
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
    })] })
    const result = await registry.tools.dispatch({ id: 'batch-cap', name: 'read_file', input: { items: [
      { file_id: 1 }, { file_id: 2 }, { file_id: 3 },
    ] } }, { identity, roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行命令') } })
    expect(result).toMatchObject({ successful: true, value: { successful_count: 2, failed_count: 1,
      total_source_size_bytes: 64 * 1024 * 1024,
      results: [{ successful: true }, { successful: true }, { successful: false, value: { error: '已达到批次源文件总量上限，后续项目未读取' } }],
    } })
    expect(resolved).toBe(2)
  })
})

describe('归档工具经 Core ToolRegistry 委托文件域操作', () => {
  it('压缩按类型拆分 entries 并保持文件库结果结构；非法条目不会调用端口', async () => {
    const calls: unknown[] = []
    const port: FileArchivePort = {
      async compress(current, input, _roundId, _call, signal) { calls.push({ current, input }); signal.throwIfAborted(); return { file_id: 17, name: '归档.zip' } },
      async extract() { throw new Error('不应调用') },
    }
    const registry = createToolRegistry({ authorize: async () => true, tools: createFileArchiveTools(port) })
    const dispatch = (name: string, input: unknown) => registry.tools.dispatch({ id: 'archive', name, input }, {
      identity: { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }, roundId: 'round',
      signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('归档不得调用 Shell') },
    })
    const invalid = await dispatch('compress_files', { entries: [{ kind: 'unknown', id: 1 }] })
    expect(invalid).toMatchObject({ kind: 'completed', successful: false, executed: false })
    expect(calls).toHaveLength(0)
    const result = await dispatch('compress_files', { entries: [{ kind: 'file', id: 4 }, { kind: 'folder', id: 8 }], archive_name: '归档' })
    expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: true,
      value: { success: true, file_id: 17, name: '归档.zip' } })
    expect(calls).toEqual([{ current: { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }, input: {
      entries: [{ kind: 'file', id: 4 }, { kind: 'folder', id: 8 }], archive_name: '归档',
    } }])
    const uncertainRegistry = createToolRegistry({ authorize: async () => true, tools: createFileArchiveTools({
      async compress() { return { kind: 'unknown' } }, async extract() { return { kind: 'unknown' } },
    }) })
    const uncertain = await uncertainRegistry.tools.dispatch({ id: 'uncertain', name: 'compress_files', input: { entries: [{ kind: 'file', id: 4 }] } }, {
      identity: { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }, roundId: 'round',
      signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不可执行') },
    })
    expect(uncertain).toEqual({ kind: 'unknown' })
  })

  it('解压保留统计与 ID 采样结构，并传播取消', async () => {
    const port: FileArchivePort = {
      async compress() { throw new Error('不应调用') },
      async extract(_current, _input, _roundId, _call, signal) {
        signal.throwIfAborted()
        return { created_count: 102, file_count: 101, folder_count: 1, skipped_count: 2, rejected_count: 0,
          file_ids: Array.from({ length: 101 }, (_, index) => index + 1), folder_ids: [202] }
      },
    }
    const registry = createToolRegistry({ authorize: async () => true, tools: createFileArchiveTools(port) })
    const result = await registry.tools.dispatch({ id: 'extract', name: 'extract_files', input: { file_id: 9, format: 'zip' } }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('解压不得调用 Shell') },
    })
    expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: true, value: {
      success: true, created_count: 102, file_count: 101, folder_count: 1, skipped_count: 2, rejected_count: 0,
      file_ids: Array.from({ length: 100 }, (_, index) => index + 1), folder_ids: [202], ids_truncated: true,
    } })
    const controller = new AbortController(); controller.abort()
    await expect(registry.tools.dispatch({ id: 'cancel', name: 'extract_files', input: { file_id: 9 } }, {
      identity, roundId: 'round', signal: controller.signal, resolution: null, execute: async () => undefined,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('目录工具通过Core注册器复用可信分页端口', () => {
  it('允许文件库登记路径并拒绝宿主路径、越界路径和混合定位', async () => {
    const received: unknown[] = []
    const definition = createListDirectoryTool({
      async list(_runIdentity, query) {
        received.push(query)
        return { files: [], folders: [], files_has_more: false, next_file_cursor: null, folders_has_more: false, next_folder_cursor: null }
      },
    })
    const parameters = definition.definition.schema.function.parameters as { properties: Record<string, unknown>; anyOf: Array<{ required: string[]; not: { required: string[] } }> }
    expect(parameters.properties.file_path).toBeDefined()
    expect(parameters.properties.path).toBeUndefined()
    expect(parameters.anyOf).toEqual([
      { required: ['space'], not: { required: ['file_path'] } },
      { required: ['file_path'], not: { required: ['space'] } },
    ])
    const registry = createToolRegistry({ authorize: async () => true, tools: [definition] })
    const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'logical', name: 'list_dir', input }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行命令') },
    })
    expect(await dispatch({ file_path: '/project/项目甲/资料', kind: 'both' })).toMatchObject({ successful: true })
    expect(received).toEqual([{ file_path: '/project/项目甲/资料', kind: 'both', mode: 'OR', limit: 100, sort_by: 'createdAt', sort_order: 'desc' }])
    expect(await dispatch({ file_path: '/etc/passwd' })).toMatchObject({ successful: false })
    expect(await dispatch({ file_path: '/personal/../etc' })).toMatchObject({ successful: false })
    expect(await dispatch({ file_path: '/personal', space: 'personal' })).toMatchObject({ successful: false })
    expect(received).toHaveLength(1)
  })

  it('传递明确空间、分页和可信身份，并返回浏览器分页结果', async () => {
    const received: unknown[] = []
    const registry = createToolRegistry({ authorize: async () => true, tools: [createListDirectoryTool({
      async list(runIdentity, query) {
        received.push({ runIdentity, query })
        return { files: [{ id: 3, displayName: '说明' }], folders: [{ id: 9, name: '资料' }], files_has_more: true,
          next_file_cursor: 'file-next', folders_has_more: false, next_folder_cursor: null }
      },
    })] })
    const result = await registry.tools.dispatch({ id: 'directory', name: 'list_dir', input: { space: 'personal', folder_id: 9, kind: 'both', limit: 20 } }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行命令') },
    })
    expect(received).toEqual([{ runIdentity: identity, query: {
      space: 'personal', folder_id: 9, kind: 'both', mode: 'OR', limit: 20, sort_by: 'createdAt', sort_order: 'desc',
    } }])
    expect(result).toMatchObject({ successful: true, mutated: false, value: {
      files: [{ id: 3, displayName: '说明' }], folders: [{ id: 9, name: '资料' },],
      files_has_more: true, next_file_cursor: 'file-next', folders_has_more: false, next_folder_cursor: null, shown: 1, truncated: true,
    } })
  })
  it('将旧版 queries 规范化后传递 OR/AND 模式与准确文件总数', async () => {
    const received: unknown[] = []
    const registry = createToolRegistry({ authorize: async () => true, tools: [createListDirectoryTool({
      async list(_runIdentity, query) {
        received.push(query)
        return { files: [{ id: 7 }], folders: [], files_has_more: true, next_file_cursor: 'next',
          folders_has_more: false, next_folder_cursor: null, total: 9 }
      },
    })] })
    const result = await registry.tools.dispatch({ id: 'queries', name: 'list_dir', input: {
      space: 'personal', queries: [' Alpha ', 'alpha', '', 'Beta'], mode: 'AND',
    } }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => undefined,
    })
    expect(received).toMatchObject([{ queries: ['Alpha', 'Beta'], mode: 'AND' }])
    expect(result).toMatchObject({ successful: true, value: { total: 9, shown: 1, truncated: true } })
  })
  it('拒绝未明确空间及任意宿主路径参数', async () => {
    let queries = 0
    const registry = createToolRegistry({ authorize: async () => true, tools: [createListDirectoryTool({
      async list() { queries++; return { files: [], folders: [], files_has_more: false, next_file_cursor: null, folders_has_more: false, next_folder_cursor: null } },
    })] })
    const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'invalid', name: 'list_dir', input }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行命令') },
    })
    expect(await dispatch({})).toMatchObject({ successful: false })
    expect(await dispatch({ file_path: '/etc' })).toMatchObject({ successful: false })
    expect(await dispatch({ space: 'personal', project_id: 12 })).toMatchObject({ successful: false })
    expect(queries).toBe(0)
  })
})

describe('edit_file 通过Core注册器执行内容修改与版本保护', () => {
  it('精确替换、拒绝歧义和旧版本，并将一次修改写入可信端口', async () => {
    let content = '甲甲\n乙'
    let version = 4
    let simulateUncertainCommit = false
    const writes: Array<{ content: string; version: number }> = []
    const port: FileEditPort = {
      async read(runIdentity, id) {
        if (runIdentity.ownerId !== identity.ownerId || id !== 1) return null
        return { id, name: '便签.txt', content, version }
      },
      async update(runIdentity, id, next, expectedVersion) {
        if (runIdentity.ownerId !== identity.ownerId || id !== 1 || expectedVersion !== version)
          throw new Error('文件已被其他端修改，请刷新后重试')
        content = next; version++
        writes.push({ content, version: expectedVersion })
        if (simulateUncertainCommit) throw new Error('模拟 COMMIT 返回前连接中断')
        return { version, size_bytes: new TextEncoder().encode(content).byteLength }
      },
    }
    const registry = createToolRegistry({ authorize: async () => true, tools: [createEditFileTool(port)] })
    const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'edit', name: 'edit_file', input }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行命令') },
    })
    expect(await dispatch({ file_id: 1, operation: 'replace_text', old_text: '甲', new_text: '丙' })).toMatchObject({ successful: false, value: { error: '目标文本出现多次，请指定 replace_all' } })
    expect(await dispatch({ file_id: 1, operation: 'append', content: '' })).toMatchObject({ successful: false, value: { error: '文件内容未变化' } })
    expect(writes).toEqual([])
    expect(await dispatch({ file_id: 1, operation: 'append', content: '过期', expected_version: 3 })).toMatchObject({ successful: false, value: { error: '文件已被其他端修改，请刷新后重试' } })
    expect(content).toBe('甲甲\n乙')
    simulateUncertainCommit = true
    expect(await dispatch({ file_id: 1, operation: 'append', content: '可能已写入', expected_version: 4 })).toEqual({ kind: 'unknown' })
    simulateUncertainCommit = false
    expect(content).toBe('甲甲\n乙可能已写入')
    expect(await dispatch({ file_id: 1, operation: 'replace_text', old_text: '甲', new_text: '丙', replace_all: true, expected_version: 4 })).toMatchObject({ successful: false, value: { error: '文件已被其他端修改，请刷新后重试' } })
    content = '甲甲\n乙'; version = 4; writes.splice(0)
    expect(await dispatch({ file_id: 1, operation: 'replace_text', old_text: '甲', new_text: '丙', replace_all: true, expected_version: 4 })).toMatchObject({
      kind: 'completed', successful: true, mutated: true, value: { file_id: 1, name: '便签.txt', version: 5 },
    })
    expect(content).toBe('丙丙\n乙')
    expect(writes).toEqual([{ content: '丙丙\n乙', version: 4 }])
    expect(await dispatch({ file_id: 1, operation: 'append', content: '无效', path: '/tmp/x' })).toMatchObject({ successful: false, executed: false })
  })

  it('按逻辑路径执行行编辑，并逐项返回批量成功与失败', async () => {
    const contents = new Map([[1, '标题\n第一行\n第二行\n'], [2, '附录\n']])
    const versions = new Map([[1, 2], [2, 1]])
    const writes: Array<{ id: number; content: string; version: number }> = []
    const port: FileEditPort = {
      async resolveFilePath(runIdentity, file) {
        if (runIdentity.ownerId !== identity.ownerId) return null
        return file === '/personal/notes.txt' ? 1 : file === '/project/report.txt' ? 2 : null
      },
      async read(runIdentity, id) {
        if (runIdentity.ownerId !== identity.ownerId || !contents.has(id)) return null
        return { id, name: id === 1 ? 'notes.txt' : 'report.txt', content: contents.get(id)!, version: versions.get(id)! }
      },
      async update(runIdentity, id, content, version) {
        if (runIdentity.ownerId !== identity.ownerId || version !== versions.get(id)) throw new Error('文件已被其他端修改，请刷新后重试')
        contents.set(id, content); versions.set(id, version + 1); writes.push({ id, content, version })
        return { version: version + 1, size_bytes: Buffer.byteLength(content) }
      },
    }
    const registry = createToolRegistry({ authorize: async () => true, tools: [createEditFileTool(port)] })
    const dispatch = (input: unknown, ownerId = identity.ownerId) => registry.tools.dispatch({ id: 'edit', name: 'edit_file', input }, {
      identity: { ...identity, ownerId }, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('不应执行命令') },
    })
    const lineEdit = await dispatch({ file: '/personal/notes.txt', mode: 'line_edit', line_edits: [
      { target_lines: '2', expected: '第一行', content: '更新行' }, { target_lines: '3', expected: '第二行', content: '' },
    ] })
    expect(lineEdit).toMatchObject({ successful: true, mutated: true, value: { file_id: 1, name: 'notes.txt' } })
    expect(contents.get(1)).toBe('标题\n更新行\n')
    expect(writes).toEqual([{ id: 1, content: '标题\n更新行\n', version: 2 }])

    const batch = await dispatch({ file_id: 1, mode: 'append', edits: [
      { content: '批次内容' }, { file: '/project/report.txt', content: '补充' }, { file: '/personal/../secret.txt', content: '越权' },
    ] })
    expect(batch).toMatchObject({ successful: true, mutated: true, value: { edited_count: 2, failed_count: 1 } })
    expect(contents.get(1)).toBe('标题\n更新行\n批次内容')
    expect(contents.get(2)).toBe('附录\n补充')
    expect(JSON.stringify(batch.value)).not.toContain('越权')
    expect(await dispatch({ file_id: 1, mode: 'line_edit', line_edits: [{ target_lines: '1', content: '替换' }] }))
      .toMatchObject({ successful: false, value: { error: expect.stringContaining('必须提供 expected') } })
    expect(await dispatch({ file_id: 1, mode: 'line_edit', line_edits: [
      { target_lines: '1-2', expected: '标题\n更新行', content: '合并' }, { target_lines: '2', expected: '更新行', content: '重复' },
    ] })).toMatchObject({ successful: false, value: { error: expect.stringContaining('不能重叠') } })
    const priorWrites = writes.length
    expect(await dispatch({ file_id: 1, mode: 'append', content: '不应写入' }, '其他用户'))
      .toMatchObject({ successful: false })
    expect(writes).toHaveLength(priorWrites)
  })
})

describe('rename_file 委托共享文件更新端口', () => {
  it('拒绝不安全名称，并把 owner 文件 ID 与期望版本交给 Host 端口', async () => {
    const calls: unknown[] = []
    const registry = createToolRegistry({ authorize: async () => true, tools: [createRenameFileTool({
      async resolveFilePath(runIdentity, path) {
        calls.push({ resolveIdentity: runIdentity, path })
        return path === '/personal/资料.md' ? 2 : null
      },
      async rename(runIdentity, id, name, extension, expectedVersion, roundId, call) {
        calls.push({ runIdentity, id, name, extension, expectedVersion, roundId, callId: call.id })
        if (id === 99) return { kind: 'completed', successful: false, mutated: false, value: { error: '文件不存在或无权访问' } }
        return { kind: 'completed', successful: true, mutated: true,
          value: { file_id: id, name: `${name}${extension ? `.${extension}` : ''}`, version: 5 } }
      },
    })] })
    const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'rename', name: 'rename_file', input }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行命令') },
    })
    expect(await dispatch({ file_id: 1, new_name: '../other' })).toMatchObject({ kind: 'completed', successful: false, mutated: false })
    expect(calls).toEqual([])
    expect(await dispatch({ file_id: 1, new_name: '更新后', expected_version: 4 })).toMatchObject({
      successful: true, mutated: true, value: { file_id: 1, name: '更新后', version: 5 },
    })
    expect(await dispatch({ file: '/personal/资料.md', new_name: '路径改名' })).toMatchObject({
      kind: 'completed', successful: true, mutated: true, value: { file_id: 2, name: '路径改名', version: 5 },
    })
    expect(await dispatch({ file: '/personal/../outside.md', new_name: '禁止' })).toMatchObject({
      kind: 'completed', successful: false, mutated: false,
    })
    expect(calls).toEqual([
      { runIdentity: identity, id: 1, name: '更新后', extension: undefined, expectedVersion: 4, roundId: 'round', callId: 'rename' },
      { resolveIdentity: identity, path: '/personal/资料.md' },
      { runIdentity: identity, id: 2, name: '路径改名', extension: undefined, expectedVersion: undefined, roundId: 'round', callId: 'rename' },
    ])
    expect(await dispatch({ file_id: 1, new_name: 'docker-compose.yml' })).toMatchObject({
      successful: true, value: { file_id: 1, name: 'docker-compose.yml' },
    })
    expect(await dispatch({ file_id: 1, new_name: '说明.markdown', format: 'markdown' })).toMatchObject({
      successful: true, value: { file_id: 1, name: '说明.md' },
    })
    expect(calls.slice(-2)).toEqual([
      { runIdentity: identity, id: 1, name: 'docker-compose', extension: 'yml', expectedVersion: undefined, roundId: 'round', callId: 'rename' },
      { runIdentity: identity, id: 1, name: '说明', extension: 'md', expectedVersion: undefined, roundId: 'round', callId: 'rename' },
    ])
    const batch = await dispatch({ renames: [
      { file_id: 1, new_name: '批量甲.md' },
      { file_id: 99, new_name: '缺失文件' },
      { file: '/personal/资料.md', new_name: '批量乙' },
    ] })
    expect(batch).toMatchObject({ successful: true, mutated: true, value: {
      success: true, renamed_count: 2, failed_count: 1,
      renamed: [
        { index: 0, file_id: 1, name: '批量甲.md', version: 5 },
        { index: 2, file_id: 2, name: '批量乙', version: 5 },
      ], failed: [{ item: 99, error: '文件不存在或无权访问' }],
    } })
    expect(calls.filter(value => typeof value === 'object' && value !== null && 'callId' in value)
      .slice(-3).map(value => (value as { callId: string }).callId)).toEqual(['rename:0', 'rename:1', 'rename:2'])
  })
})

describe('copy_file 只开放明确空间的保留两者写入', () => {
  it('拒绝缺失/冲突的目标归属并将安全复制请求传给Host', async () => {
    const received: unknown[] = []
    const registry = createToolRegistry({ authorize: async () => true, tools: [createCopyFileTool({
      async resolveFilePath(runIdentity, path) {
        received.push({ resolveIdentity: runIdentity, path })
        return path === '/project/项目/资料.md' ? 3 : null
      },
      async copy(runIdentity, id, destination, roundId, call) {
        received.push({ runIdentity, id, destination, roundId, callId: call.id })
        return { kind: 'completed', successful: true, mutated: true, value: { file_id: 8, name: '说明(1).txt', version: 1 } }
      },
    })] })
    const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'copy', name: 'copy_file', input }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行命令') },
    })
    expect(await dispatch({ file_id: 1, space: 'project' })).toMatchObject({ successful: false, executed: false })
    expect(await dispatch({ file_id: 1, space: 'project', project_id: 2, workspace_directory_id: 3 })).toMatchObject({ successful: false, executed: false })
    expect(received).toEqual([])
    expect(await dispatch({ file_id: 1, space: 'personal' })).toMatchObject({
      successful: true, mutated: true, value: { file_id: 8, name: '说明(1).txt', version: 1 },
    })
    expect(await dispatch({ file: '/project/项目/资料.md', space: 'workspace', workspace_directory_id: 4 })).toMatchObject({
      kind: 'completed', successful: true, mutated: true, value: { file_id: 8, name: '说明(1).txt', version: 1 },
    })
    expect(await dispatch({ file: '/project/../outside.md', space: 'personal' })).toMatchObject({
      kind: 'completed', successful: false, mutated: false,
    })
    expect(received).toEqual([
      { runIdentity: identity, id: 1, destination: { space: 'personal' }, roundId: 'round', callId: 'copy' },
      { resolveIdentity: identity, path: '/project/项目/资料.md' },
      { runIdentity: identity, id: 3, destination: { space: 'workspace', workspace_directory_id: 4 }, roundId: 'round', callId: 'copy' },
    ])
  })
})

describe('create_file 使用明确目标空间与持久 Host 收据', () => {
  it('拒绝路径参数和目标空间冲突，并将真实调用坐标传入创建端口', async () => {
    const calls: unknown[] = []
    const registry = createToolRegistry({ authorize: async () => true, tools: [createCreateFileTool({
      async create(runIdentity, input, roundId, call) {
        calls.push({ runIdentity, input, roundId, callId: call.id })
        return { kind: 'created', file_id: 12, name: '新建.txt', size_bytes: 6, mutated: false }
      },
    })] })
    const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'create-call', name: 'create_file', input }, {
      identity, roundId: 'tool-round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行命令') },
    })
    expect(await dispatch({ filename: '../secret', content: 'x', space: 'personal' })).toMatchObject({ successful: false, executed: false })
    expect(await dispatch({ filename: 'test.txt', content: 'x', space: 'project' })).toMatchObject({ successful: false, executed: false })
    expect(calls).toEqual([])
    expect(await dispatch({ filename: '新建.txt', content: '内容', space: 'personal' })).toMatchObject({
      successful: true, mutated: false, value: { file_id: 12, name: '新建.txt', size_bytes: 6 },
    })
    expect(calls).toEqual([{ runIdentity: identity, input: { filename: '新建.txt', content: '内容', space: 'personal' }, roundId: 'tool-round', callId: 'create-call' }])
  })

  it('批量逐项创建并复用独立收据坐标，Workspace 目录只由 Host 解析', async () => {
    const received: Array<{ input: unknown; callId: string; fingerprintInput: unknown }> = []
    const registry = createToolRegistry({ authorize: async () => true, tools: [createCreateFileTool({
      async resolveWorkspaceDirectory(runIdentity) { return runIdentity.ownerId === identity.ownerId ? 41 : null },
      async create(runIdentity, input, roundId, call) {
        received.push({ input, callId: call.id, fingerprintInput: call.input })
        if (input.filename === '失败.txt') return { kind: 'failed', error: '目标目录不可写' }
        return { kind: 'created', file_id: received.length, name: input.filename, size_bytes: Buffer.byteLength(input.content), mutated: true }
      },
    })] })
    const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'create-batch', name: 'create_file', input }, {
      identity, roundId: 'batch-round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('文件创建不得执行宿主命令') },
    })
    const created = await dispatch({ target: { space: 'personal' }, files: [
      { filename: '一.txt', content: '一' }, { filename: '失败.txt', content: '失败' },
      { filename: '工作区.txt', content: '工作区', space: 'workspace' },
    ] })
    expect(created).toMatchObject({ successful: true, mutated: true, value: { created_count: 2, failed_count: 1 } })
    expect(received.map(item => item.callId)).toEqual(['create-batch:file:0', 'create-batch:file:1', 'create-batch:file:2'])
    expect(received[2]!.input).toMatchObject({ space: 'workspace', workspace_directory_id: 41 })
    expect((created.value as Record<string, any>).failed).toEqual([{ index: 1, name: '失败.txt', error: '目标目录不可写' }])
    expect(await dispatch({ filename: 'report.pdf', content: 'not a PDF', space: 'personal' }))
      .toMatchObject({ successful: false, value: { error: expect.stringContaining('不能直接生成 pdf') } })
    expect(await dispatch({ filename: 'invalid', content: 'x', space: 'personal' })).toMatchObject({ successful: false, executed: false })
    expect(await dispatch({ filename: 'forged.txt', content: 'x', space: 'workspace', workspace_directory_id: 999 }))
      .toMatchObject({ successful: false, executed: false })
  })
})

describe('create_folder 只接受同一明确空间中的安全直接父级', () => {
  it('拒绝不安全路径和空间冲突，并验证真实注册器端口调用', async () => {
    const received: unknown[] = []
    const registry = createToolRegistry({ authorize: async () => true, tools: [createCreateFolderTool({
      async create(request) {
        received.push(request)
        return { kind: 'completed', successful: true, mutated: true,
          value: { folder_id: 13, name: request.args.folder_name, version: 1, file_count: 0, folder_count: 0 } }
      },
      async reconcile() { return { kind: 'unknown' } },
    })] })
    const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'folder', name: 'create_folder', input }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行命令') },
    })
    expect(await dispatch({ folder_name: '../secret', space: 'personal' })).toMatchObject({ successful: false, executed: false })
    expect(await dispatch({ folder_name: '新目录', space: 'workspace' })).toMatchObject({ successful: false, executed: false })
    expect(received).toEqual([])
    expect(await dispatch({ folder_name: '新目录', space: 'personal', parent_id: 4 })).toMatchObject({
      successful: true, mutated: true, value: { folder_id: 13, name: '新目录', version: 1 },
    })
    expect(received).toEqual([{ identity, roundId: 'round', toolCallId: 'folder',
      args: { folder_name: '新目录', space: 'personal', parent_id: 4 }, signal: expect.any(AbortSignal) }])
  })
})

describe('move_items 支持文件 ID/登记逻辑路径和明确个人/项目目标', () => {
  it('拒绝文件名猜测、危险路径、Workspace 及无项目 ID，并经真实注册器返回逐项结果', async () => {
    const received: unknown[] = []
    const registry = createToolRegistry({ authorize: async () => true, tools: [createMoveItemsTool({
      async move(runIdentity, input) {
        received.push({ runIdentity, input })
        return { moved_files: 1, moved_folders: 1, failed_count: 1,
          files: [{ file_id: 7, name: 'notes.txt' }], folders: [{ folder_id: 12, name: '资料' }],
          failed: [{ item: 8, kind: 'file', error: '文件不存在' }] }
      },
    })] })
    const dispatch = (input: unknown, signal = new AbortController().signal) => registry.tools.dispatch({ id: 'move', name: 'move_items', input }, {
      identity, roundId: 'round', signal, resolution: null, execute: async () => { throw new Error('不应执行命令') },
    })
    expect(await dispatch({ files: ['notes.txt'], target: { space: 'personal' } })).toMatchObject({ successful: false, executed: false })
    expect(await dispatch({ files: ['/personal/../notes.txt'], target: { space: 'personal' } })).toMatchObject({ successful: false, executed: false })
    expect(await dispatch({ files: [7], target: { space: 'workspace' } })).toMatchObject({ successful: false, executed: false })
    expect(await dispatch({ files: [7], target: { space: 'project' } })).toMatchObject({ successful: false, executed: false })
    expect(await dispatch({ files: Array.from({ length: 26 }, (_, i) => i + 1), folders: Array.from({ length: 25 }, (_, i) => i + 1), target: { space: 'personal' } }))
      .toMatchObject({ successful: false, executed: false })
    expect(received).toEqual([])
    expect(await dispatch({ files: [7, 8], folders: [12], target: { space: 'project', project_id: 5, folder_id: 20 } })).toMatchObject({
      kind: 'completed', successful: true, mutated: true,
      value: { moved_files: 1, moved_folders: 1, failed_count: 1, files: [{ file_id: 7 }], folders: [{ folder_id: 12 }], failed: [{ item: 8, kind: 'file' }] },
    })
    expect(received).toEqual([{ runIdentity: identity, input: {
      files: [7, 8], folders: [12], target: { space: 'project', project_id: 5, folder_id: 20 },
    } }])
    await dispatch({ files: ['/personal/notes.txt'], target: { space: 'personal' } })
    expect(received[1]).toEqual({ runIdentity: identity, input: {
      files: ['/personal/notes.txt'], folders: [], target: { space: 'personal' },
    } })
    const cancelled = new AbortController(); cancelled.abort(new Error('测试取消'))
    await expect(dispatch({ files: [7], target: { space: 'personal' } }, cancelled.signal)).rejects.toThrow('测试取消')
  })
})

describe('rename_folder 按稳定 ID 调用文件夹事务', () => {
  it('拒绝危险名称并保留 CAS 版本结果', async () => {
    const received: unknown[] = []
    const registry = createToolRegistry({ authorize: async () => true, tools: [createRenameFolderTool({
      async rename(request) {
        received.push(request)
        if (request.name === '同名') return { kind: 'completed', successful: false, mutated: false, value: { error: '文件夹名称未变化' } }
        if (request.expectedVersion === 1) return { kind: 'completed', successful: false, mutated: false, value: { error: '文件夹已被修改，请刷新后重试' } }
        if (request.name === '重名') return { kind: 'completed', successful: false, mutated: false, value: { error: '同名文件夹已存在' } }
        return { kind: 'completed', successful: true, mutated: true, value: { folder_id: request.folderId, name: request.name, version: 5 } }
      },
      async reconcile() { return { kind: 'unknown' } },
    })] })
    const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'folder-rename', name: 'rename_folder', input }, {
      identity, roundId: 'round', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行命令') },
    })
    expect(await dispatch({ folder_id: 12, new_folder_name: '../outside' })).toMatchObject({ successful: false, executed: false })
    expect(received).toEqual([])
    expect(await dispatch({ folder_id: 12, new_folder_name: '新版', expected_version: 1 })).toMatchObject({ successful: false, value: { error: '文件夹已被修改，请刷新后重试' } })
    expect(await dispatch({ folder_id: 12, new_folder_name: '同名' })).toMatchObject({ successful: false, value: { error: '文件夹名称未变化' } })
    expect(await dispatch({ folder_id: 12, new_folder_name: '重名' })).toMatchObject({ successful: false, value: { error: '同名文件夹已存在' } })
    expect(await dispatch({ folder_id: 12, new_folder_name: '新版', expected_version: 4 })).toMatchObject({
      kind: 'completed', successful: true, mutated: true, value: { folder_id: 12, name: '新版', version: 5 },
    })
    expect(received).toEqual([
      { identity, roundId: 'round', toolCallId: 'folder-rename', folderId: 12, name: '新版', expectedVersion: 1, signal: expect.any(AbortSignal) },
      { identity, roundId: 'round', toolCallId: 'folder-rename', folderId: 12, name: '同名', expectedVersion: undefined, signal: expect.any(AbortSignal) },
      { identity, roundId: 'round', toolCallId: 'folder-rename', folderId: 12, name: '重名', expectedVersion: undefined, signal: expect.any(AbortSignal) },
      { identity, roundId: 'round', toolCallId: 'folder-rename', folderId: 12, name: '新版', expectedVersion: 4, signal: expect.any(AbortSignal) },
    ])
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
    const registry = createToolRegistry({ authorize: async (current, name) => authorized && current.ownerId === identity.ownerId && name === 'save_uploaded_file',
      tools: [createSaveUploadedFileTool({ async save(current, input) {
        calls.push({ owner: current.ownerId, input })
        return { kind: 'saved', mutated: true, value: { file_id: calls.length, name: 'saved.txt', size: 4 } }
      } })] })
    const dispatch = (input: unknown, owner = identity.ownerId) => registry.tools.dispatch({ id: 'save', name: 'save_uploaded_file', input }, {
      identity: { ...identity, ownerId: owner }, roundId: 'round', signal: new AbortController().signal,
      resolution: null, execute: async () => { throw new Error('不允许执行 Shell') },
    })
    expect(await dispatch({ attach_id: 'attachment-1' })).toMatchObject({ successful: true, mutated: true, value: { file_id: 1 } })
    expect(calls[0]).toEqual({ owner: identity.ownerId, input: { source: 'attach_id', attach_id: 'attachment-1', space: 'personal' } })
    expect(await dispatch({ source: 'attach_ids', attach_ids: ['attachment-2', 'attachment-3'], space: 'project', project_id: 7, folder_id: 8 }))
      .toMatchObject({ successful: true, value: { file_id: 2 } })
    expect(await dispatch({ source: 'latest' })).toMatchObject({ successful: true, value: { file_id: 3 } })
    expect(await dispatch({ attach_id: 'attachment-workspace', space: 'workspace' })).toMatchObject({ successful: true, value: { file_id: 4 } })
    expect(calls[3]).toEqual({ owner: identity.ownerId,
      input: { source: 'attach_id', attach_id: 'attachment-workspace', space: 'workspace' } })
    expect(await dispatch({ source: 'latest', attach_id: 'must-not-fallback' })).toMatchObject({ successful: false, executed: false })
    expect(await dispatch({ attach_ids: ['same', 'same'] })).toMatchObject({ successful: false, executed: false })
    expect(await dispatch({ attach_id: 'wrong-scope', space: 'workspace', project_id: 7 })).toMatchObject({ successful: false, executed: false })
    authorized = false
    expect(await dispatch({ attach_id: 'attachment-4' })).toMatchObject({ successful: false, executed: false })
    expect(calls).toHaveLength(4)
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

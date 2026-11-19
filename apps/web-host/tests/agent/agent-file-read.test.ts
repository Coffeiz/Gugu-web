import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile as readLocalFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createAuthorizedWebAgentProductionRagRunPorts } from '../../src/modules/agent/rag/production.js'
import { createWebAgentFileReadPort } from '../../src/modules/agent/tools/files/read.js'
import { createWebAgentFileDirectoryPort } from '../../src/modules/agent/tools/files/directory.js'
import { createWebAgentFileEditPort } from '../../src/modules/agent/tools/files/edit.js'
import { createWebAgentFileRenamePort } from '../../src/modules/agent/tools/files/rename.js'
import { createWebAgentFileCopyPort } from '../../src/modules/agent/tools/files/copy.js'
import { createWebAgentFileCreatePort } from '../../src/modules/agent/tools/files/create.js'
import { createWebAgentFolderCreatePort, createWebAgentFolderRenamePort, createWebAgentMoveItemsPort } from '../../src/modules/agent/tools/files/write.js'
import type { FileBrowserOperations } from '../../src/modules/files/browse.js'
import type { FileContentOperations } from '../../src/modules/files/content.js'
import type { FileUpdateOperations } from '../../src/modules/files/store.js'
import type { FileCopyOperations } from '../../src/modules/files/store.js'
import type { FileUploadOperations } from '../../src/modules/files/upload.js'
import type { FolderWriteOperations } from '../../src/modules/files/folders/write.js'

function pdfFixture(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Uint8Array.from(Buffer.from(pdf, 'ascii'))
}

test('文件工具生产 registry 只访问同 owner 内容、保留编辑 CAS 并在 lease 撤销后拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-file-read-'))
  let core: SqlDataRuntime | undefined
  try {
    await initializeSqlite(join(root, 'core.db'))
    core = (await openSqliteRuntime(join(root, 'core.db'))).runtime
    const ownerId = randomUUID(), sessionId = '73', runId = 'file-read-run'
    const identity = { ownerId, sessionId, runId }
    const relativePath = `${ownerId}/personal/notes.txt`
    await mkdir(join(root, ownerId, 'personal'), { recursive: true })
    await writeFile(join(root, relativePath), '第一行\r\n第二行\n第三行', 'utf8')
    const officePath = `${ownerId}/personal/report.pdf`
    await writeFile(join(root, officePath), pdfFixture('Synthetic report text'))
    const attachmentPath = `${ownerId}/attachments/historical.txt`
    await mkdir(join(root, ownerId, 'attachments'), { recursive: true })
    await writeFile(join(root, attachmentPath), '历史附件第一行\n历史附件第二行', 'utf8')
    let active = true
    let fileQueries = 0
    let attachmentQueries = 0
    let folderVersion = 3
    let currentFileName = 'notes'
    let currentFileExtension = 'txt'
    let folderCreateCalls = 0
    let folderRenameCalls = 0
    let copySideEffects = 0
    const copyReceipts = new Map<string, { method: string; fingerprint: string; result_json: string }>()
    const renameReceipts = new Map<string, { method: string; fingerprint: string; result_json: string }>()
    let folderName = '资料'
    const pool = { async query(sql: string, values: unknown[]) {
      if (sql.includes('agent_run_dispatch')) return { rowCount: active ? 1 : 0, rows: [{}] }
      if (sql.includes('core_operation_receipts')) {
        const row = copyReceipts.get(String(values[1])) ?? renameReceipts.get(String(values[1]))
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] }
      }
      if (sql.includes('FROM chat_attachments')) {
        assert.deepEqual(values, ['historical-text', ownerId])
        attachmentQueries++
        return { rowCount: 1, rows: [{ attach_id: 'historical-text', user_id: ownerId, storage_key: attachmentPath,
          name: '历史备注.txt', ext: 'txt', kind: 'text', size: Buffer.byteLength('历史附件第一行\n历史附件第二行') }] }
      }
      if (sql.includes('FROM folders')) {
        assert.equal(values[1], ownerId)
        return values[0] === 12 ? { rowCount: 1, rows: [{ id: 12, user_id: ownerId, version: folderVersion, project_id: null, workspace_directory_id: null, parent_id: null, name: folderName }] } : { rowCount: 0, rows: [] }
      }
      assert.match(sql, /FROM files\s+WHERE id=\$1 AND user_id=\$2 AND deleted_at IS NULL/u)
      assert.equal(values[1], ownerId)
      fileQueries++
      if (values[0] !== 7 && values[0] !== 8) return { rowCount: 0, rows: [] }
      const office = values[0] === 8
      return { rowCount: 1, rows: [{ id: values[0], user_id: ownerId, storage_key: office ? officePath : relativePath,
        display_name: office ? 'report' : currentFileName, ext: office ? 'pdf' : currentFileExtension, mime_type: office ? 'application/pdf' : 'text/plain', version: currentVersion,
        space: 'personal', project_id: null, workspace_directory_id: null, folder_id: null }] }
    } }
    let currentVersion = 1
    const contentOperations: FileContentOperations = { async update(owner, fileId, content, version, metadata) {
      assert.equal(owner, ownerId)
      assert.equal(fileId, 7)
      assert.equal(version, currentVersion)
      assert.equal(metadata.undoContextId, `agent:${sessionId}:${runId}`)
      currentVersion++
      await writeFile(join(root, relativePath), content, 'utf8')
      return { version: currentVersion, sizeBytes: Buffer.byteLength(content) }
    } }
    const updateOperations: FileUpdateOperations = { async update(owner, fileId, input, metadata, operation) {
      assert.equal(owner, ownerId)
      assert.equal(fileId, 7)
      assert.equal(input.version, currentVersion)
      assert.equal(metadata.undoContextId, `agent:${sessionId}:${runId}`)
      if (input.displayName !== undefined) {
        assert.equal(input.folderSet || input.projectSet || input.workspaceDirectorySet, false)
        if (input.ext) assert.equal(input.ext, 'md')
        assert.equal(operation?.receipt.method, 'agent.file.rename')
        await operation?.authorize({ query: pool.query } as never)
        const previous = operation ? renameReceipts.get(operation.receipt.operationId) : undefined
        if (previous) return { file: JSON.parse(previous.result_json), replayed: true }
      } else {
        assert.equal(input.displayName, undefined)
        assert.deepEqual({ folderId: input.folderId, projectId: input.projectId, workspaceDirectoryId: input.workspaceDirectoryId },
          input.projectId === 5 ? { folderId: 20, projectId: 5, workspaceDirectoryId: null }
            : { folderId: null, projectId: 6, workspaceDirectoryId: null })
      }
      const oldName = `${currentFileName}.${currentFileExtension}`
      currentVersion++
      currentFileName = input.displayName ?? currentFileName
      currentFileExtension = input.ext ?? currentFileExtension
      const file = { id: fileId, displayName: currentFileName, ext: currentFileExtension, version: currentVersion }
      const receiptFile = operation ? { ...file, old_name: operation.receipt.previousName ?? oldName } : file
      if (operation) renameReceipts.set(operation.receipt.operationId, { method: operation.receipt.method,
        fingerprint: operation.receipt.fingerprint, result_json: JSON.stringify(receiptFile) })
      return operation ? { file: receiptFile, replayed: false } : file
    } }
    const copyOperations: FileCopyOperations = { async copy(owner, fileId, input, metadata, operation) {
      assert.equal(owner, ownerId)
      assert.equal(fileId, 7)
      assert.deepEqual(input, { folderId: null, projectId: null, workspaceDirectoryId: null, onConflict: 'keep_both', overwriteFileId: null })
      assert.equal(metadata.undoContextId, `agent:${sessionId}:${runId}`)
      assert.equal(operation?.receipt.method, 'agent.file.copy')
      await operation?.authorize({ query: pool.query } as never)
      const previous = operation ? copyReceipts.get(operation.receipt.operationId) : undefined
      if (previous) return { file: JSON.parse(previous.result_json), replayed: true }
      copySideEffects++
      const file = { id: 8 + copySideEffects, displayName: 'notes(1)', version: 1 }
      if (operation) copyReceipts.set(operation.receipt.operationId, { method: operation.receipt.method,
        fingerprint: operation.receipt.fingerprint, result_json: JSON.stringify(file) })
      return { file, replayed: false }
    } }
    const createdReceipts = new Map<string, Record<string, unknown>>()
    const uploadOperations: FileUploadOperations = {
      async getUploadCapacity(owner, input) {
        assert.equal(owner, ownerId)
        assert.deepEqual(input, { space: 'personal', projectId: null, folderId: null, workspaceDirectoryId: null, stageName: '', mindMapId: null, onConflict: 'keep_both', overwriteFileId: null })
        return 1024 * 1024
      },
      async store(owner, upload, metadata, operation) {
        assert.equal(owner, ownerId)
        assert.equal(metadata.undoContextId, `agent:${sessionId}:${runId}`)
        assert.equal(upload.originalName, 'draft.txt')
        assert.equal(await readLocalFile(upload.path, 'utf8'), '新建内容')
        assert.equal(operation?.receipt.method, 'agent.file.create')
        await operation?.authorize({ query: pool.query } as never)
        const file = { id: 9, displayName: 'draft', ext: 'txt', sizeBytes: Buffer.byteLength('新建内容') }
        if (operation && createdReceipts.has(operation.receipt.operationId))
          return { file: createdReceipts.get(operation.receipt.operationId), replayed: true }
        if (operation) createdReceipts.set(operation.receipt.operationId, file)
        return { file, replayed: false }
      },
    }
    const folderOperations: FolderWriteOperations = {
      async create(owner, input, metadata) {
        folderCreateCalls++
        assert.equal(owner, ownerId)
        assert.deepEqual(input, { name: '子目录', projectId: null, workspaceDirectoryId: null, parentId: null })
        assert.equal(metadata.undoContextId, `agent:${sessionId}:${runId}`)
        return { id: 11, name: input.name, version: 1, fileCount: 0, folderCount: 0 }
      },
      async rename(owner, id, input, metadata) {
        folderRenameCalls++
        assert.equal(owner, ownerId)
        assert.equal(id, 12)
        assert.deepEqual(input, { name: '新版资料', version: folderVersion })
        assert.equal(metadata.undoContextId, `agent:${sessionId}:${runId}`)
        folderVersion++
        folderName = input.name
        return { id, name: input.name, version: folderVersion, fileCount: 0, folderCount: 2 }
      },
      async move(owner, id, input, metadata) {
        assert.equal(owner, ownerId)
        assert.equal(id, 12)
        assert.deepEqual(input, { parentId: 20, version: folderVersion, projectId: 5, projectSet: true, workspaceDirectoryId: null, workspaceDirectorySet: true })
        assert.equal(metadata.undoContextId, `agent:${sessionId}:${runId}`)
        return { id, projectId: 5, workspaceDirectoryId: null, parentId: 20, name: folderName, version: folderVersion + 1, fileCount: 0, folderCount: 2 }
      },
    }
    const lease = { identity, token: 'synthetic-token', fence: 2, mode: 'start' as const, cancelRequested: false,
      input: { v: 2 as const, source: 'web' as const, accessVersion: 'b'.repeat(64), userMessageId: 3, locale: 'zh-CN' as const, origin: null } }
    const ports = createAuthorizedWebAgentProductionRagRunPorts({
      core: core!, pool: pool as never, storageRoot: root, lease,
      selection: { contextPolicy: { loadOwnerContext: true, memoryEnabled: true }, contextScopeKey: lease.input.accessVersion, modelIdentity: 'synthetic-model' },
      enabled: async () => true, enabledFileRead: true, enabledFileDirectoryRead: true,
      fileDirectory: createWebAgentFileDirectoryPort({
        async listFiles(owner, query) {
          assert.equal(owner, ownerId)
          assert.equal(query.space, 'personal')
          return { items: [{ id: 7, displayName: 'notes', ext: 'txt', space: 'personal' }], has_more: false, next_cursor: null }
        },
        async listFolders(owner, query) {
          assert.equal(owner, ownerId)
          assert.equal(query.parentId, null)
          return { items: [{ id: 4, name: '笔记', parentId: null }], has_more: true, next_cursor: 'synthetic-cursor' }
        },
      } satisfies FileBrowserOperations, lease),
      readFile: createWebAgentFileReadPort(pool as never, root, lease, {
        async list(current, signal) {
          signal.throwIfAborted()
          assert.deepEqual(current, identity)
          return [{ file_id: 7, name: 'notes.txt', space: 'personal', path: '/personal/notes.txt', project_id: null,
            folder_id: null, workspace_directory_id: null, size_bytes: 30, is_text: true }]
        },
        async readText() { return null },
      }),
      fileEdit: createWebAgentFileEditPort(pool as never, root, contentOperations, lease), enabledFileEdit: true,
      fileRename: createWebAgentFileRenamePort(pool as never, updateOperations, lease, {
        async list(current, signal) {
          signal.throwIfAborted()
          assert.deepEqual(current, identity)
          return [{ file_id: 7, name: 'notes.txt', space: 'personal', path: '/personal/notes.txt', project_id: null,
            folder_id: null, workspace_directory_id: null, size_bytes: 30, is_text: true }]
        },
        async readText() { return null },
      }), enabledFileRename: true,
      fileCopy: createWebAgentFileCopyPort(pool as never, copyOperations, lease, {
        async list(current, signal) {
          signal.throwIfAborted()
          assert.deepEqual(current, identity)
          return [{ file_id: 7, name: 'notes.txt', space: 'personal', path: '/personal/notes.txt', project_id: null,
            folder_id: null, workspace_directory_id: null, size_bytes: 30, is_text: true }]
        },
        async readText() { return null },
      }), enabledFileCopy: true,
      fileCreate: createWebAgentFileCreatePort({ pool: pool as never, upload: uploadOperations, lease }), enabledFileCreate: true,
      folderCreate: createWebAgentFolderCreatePort({ core: core!, pool: pool as never, operations: folderOperations, lease }), enabledFolderCreate: true,
      folderRename: createWebAgentFolderRenamePort({ core: core!, pool: pool as never, operations: folderOperations, lease }), enabledFolderRename: true,
      fileMoveItems: createWebAgentMoveItemsPort(pool as never, updateOperations, folderOperations, lease, {
        async list(current, signal) {
          signal.throwIfAborted()
          assert.deepEqual(current, identity)
          return [{ file_id: 7, name: 'notes.txt', space: 'personal', path: '/personal/notes.txt', project_id: null,
            folder_id: null, workspace_directory_id: null, size_bytes: 30, is_text: true }]
        },
        async readText() { return null },
      }), enabledFileMoveItems: true,
    })
    assert.equal((await ports.configuration(identity, new AbortController().signal)).toolNames.includes('read_file'), true)
    assert.equal((await ports.configuration(identity, new AbortController().signal)).toolNames.includes('list_dir'), true)
    assert.equal((await ports.configuration(identity, new AbortController().signal)).toolNames.includes('edit_file'), true)
    assert.equal((await ports.configuration(identity, new AbortController().signal)).toolNames.includes('rename_file'), true)
    assert.equal((await ports.configuration(identity, new AbortController().signal)).toolNames.includes('copy_file'), true)
    assert.equal((await ports.configuration(identity, new AbortController().signal)).toolNames.includes('create_file'), true)
    assert.equal((await ports.configuration(identity, new AbortController().signal)).toolNames.includes('create_folder'), true)
    assert.equal((await ports.configuration(identity, new AbortController().signal)).toolNames.includes('rename_folder'), true)
    assert.equal((await ports.configuration(identity, new AbortController().signal)).toolNames.includes('move_items'), true)
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('read_file 不得执行宿主命令') } }
    const result = await ports.toolRegistry.tools.dispatch({ id: 'read-lines', name: 'read_file', input: { file_id: 7, target_lines: '2-3' } }, scope)
    assert.deepEqual(result.kind === 'completed' ? result.value : null, {
      file_id: 7, name: 'notes.txt', content: '第二行\n第三行', numbered_content: '2: 第二行\n3: 第三行',
      line_range: { start: 2, end: 3 }, _source_size_bytes: Buffer.byteLength('第一行\r\n第二行\n第三行'),
    })
    const pathRead = await ports.toolRegistry.tools.dispatch({ id: 'read-path', name: 'read_file', input: { file: '/personal/notes.txt', target_lines: '1' } }, scope)
    assert.deepEqual(pathRead.kind === 'completed' ? pathRead.value : null, {
      file_id: 7, name: 'notes.txt', content: '第一行\r\n', numbered_content: '1: 第一行',
      line_range: { start: 1, end: 1 }, _source_size_bytes: Buffer.byteLength('第一行\r\n第二行\n第三行'),
    })
    const officeRead = await ports.toolRegistry.tools.dispatch({ id: 'read-office', name: 'read_file', input: { file_id: 8 } }, scope)
    assert.equal(officeRead.successful, true)
    assert.match(JSON.stringify(officeRead.value), /Synthetic report text/u)
    assert.equal(officeRead.value && typeof officeRead.value === 'object' && 'name' in officeRead.value ? officeRead.value.name : null, 'report.pdf')
    const attachmentRead = await ports.toolRegistry.tools.dispatch({ id: 'read-history-attachment', name: 'read_file', input: {
      attach_id: 'historical-text', target_lines: '2',
    } }, scope)
    assert.deepEqual(attachmentRead.kind === 'completed' ? attachmentRead.value : null, {
      attach_id: 'historical-text', name: '历史备注.txt', content: '历史附件第二行',
      numbered_content: '2: 历史附件第二行', line_range: { start: 2, end: 2 },
      _source_size_bytes: Buffer.byteLength('历史附件第一行\n历史附件第二行'),
    })
    const attachmentBatch = await ports.toolRegistry.tools.dispatch({ id: 'read-attachment-batch', name: 'read_file', input: {
      items: [{ attach_id: 'historical-text', title: '旧附件' }],
    } }, scope)
    assert.deepEqual(attachmentBatch.kind === 'completed' ? attachmentBatch.value : null, {
      results: [{ index: 1, label: '旧附件', successful: true, value: {
        attach_id: 'historical-text', name: '历史备注.txt', content: '历史附件第一行\n历史附件第二行',
        numbered_content: '1: 历史附件第一行\n2: 历史附件第二行', line_range: { start: 1, end: 2 },
      } }], successful_count: 1, failed_count: 0,
      total_source_size_bytes: Buffer.byteLength('历史附件第一行\n历史附件第二行'),
    })
    const attachmentQueriesBeforeForeignOwner = attachmentQueries
    const attachmentPort = createWebAgentFileReadPort(pool as never, root, lease)
    assert.equal(await attachmentPort.resolveOwnedAttachment?.({ ...identity, ownerId: randomUUID() }, 'historical-text', new AbortController().signal), null)
    assert.equal(attachmentQueries, attachmentQueriesBeforeForeignOwner, '不同 owner 不得查询附件行')
    assert.equal((await ports.toolRegistry.tools.dispatch({ id: 'read-traversal', name: 'read_file', input: { file: '/personal/../private.txt' } }, scope)).successful, false)
    assert.equal((await ports.toolRegistry.tools.dispatch({ id: 'read-host-uri', name: 'read_file', input: { file: 'file:///private/private.txt' } }, scope)).successful, false)
    const directory = await ports.toolRegistry.tools.dispatch({ id: 'list-root', name: 'list_dir', input: { space: 'personal' } }, scope)
    assert.deepEqual(directory.kind === 'completed' ? directory.value : null, {
      files: [{ id: 7, displayName: 'notes', ext: 'txt', space: 'personal' }],
      folders: [{ id: 4, name: '笔记', parentId: null }],
      files_has_more: false, next_file_cursor: null,
      folders_has_more: true, next_folder_cursor: 'synthetic-cursor', total: 1, shown: 1, truncated: false,
    })
    const batch = await ports.toolRegistry.tools.dispatch({ id: 'read-batch', name: 'read_file', input: { items: [
      { file_id: 7, target_lines: '1', title: '已有文件' }, { file_id: 9, result_id: '异主或不存在' },
    ] } }, scope)
    assert.deepEqual(batch.kind === 'completed' ? batch.value : null, {
      results: [
        { index: 1, label: '已有文件', successful: true, value: {
          file_id: 7, name: 'notes.txt', content: '第一行\r\n', numbered_content: '1: 第一行',
          line_range: { start: 1, end: 1 },
        } },
        { index: 2, label: '异主或不存在', successful: false, value: { error: '文件不存在或无权访问' } },
      ],
      successful_count: 1, failed_count: 1, total_source_size_bytes: Buffer.byteLength('第一行\r\n第二行\n第三行'),
    })
    const missing = await ports.toolRegistry.tools.dispatch({ id: 'missing', name: 'read_file', input: { file_id: 9 } }, scope)
    assert.equal(missing.kind === 'completed' && JSON.stringify(missing.value).includes('文件不存在或无权访问'), true)
    const ambiguous = await ports.toolRegistry.tools.dispatch({ id: 'ambiguous', name: 'edit_file', input: {
      file_id: 7, operation: 'replace_text', old_text: '行', new_text: '段',
    } }, scope)
    assert.equal(ambiguous.kind === 'completed' && ambiguous.successful, false, '多处匹配时不得静默修改任意位置')
    assert.equal(await readLocalFile(join(root, relativePath), 'utf8'), '第一行\r\n第二行\n第三行')
    const edited = await ports.toolRegistry.tools.dispatch({ id: 'edit', name: 'edit_file', input: {
      file_id: 7, operation: 'replace_text', expected_version: 1, old_text: '第二行', new_text: '更新段',
    } }, scope)
    assert.equal(edited.kind === 'completed' && edited.successful, true)
    assert.deepEqual(edited.kind === 'completed' ? edited.value : null, { file_id: 7, name: 'notes.txt', version: 2, size_bytes: 30 })
    assert.equal(await readLocalFile(join(root, relativePath), 'utf8'), '第一行\r\n更新段\n第三行')
    const stale = await ports.toolRegistry.tools.dispatch({ id: 'stale', name: 'edit_file', input: {
      file_id: 7, operation: 'append', content: '不得写入', expected_version: 1,
    } }, scope)
    assert.equal(stale.kind === 'completed' && stale.successful, false, '显式旧版本须在副作用前拒绝')
    const appended = await ports.toolRegistry.tools.dispatch({ id: 'append', name: 'edit_file', input: {
      file_id: 7, operation: 'append', content: '\n尾行', expected_version: 2,
    } }, scope)
    assert.equal(appended.kind === 'completed' && appended.successful, true)
    assert.equal(await readLocalFile(join(root, relativePath), 'utf8'), '第一行\r\n更新段\n第三行\n尾行')
    const renamed = await ports.toolRegistry.tools.dispatch({ id: 'rename', name: 'rename_file', input: {
      file_id: 7, new_name: 'renamed', expected_version: 3,
    } }, scope)
    assert.deepEqual(renamed.kind === 'completed' ? renamed.value : null, { file_id: 7, old_name: 'notes.txt', name: 'renamed.txt', version: 4 })
    const renamedByPath = await ports.toolRegistry.tools.dispatch({ id: 'rename-path', name: 'rename_file', input: {
      file: '/personal/notes.txt', new_name: 'renamed-again', expected_version: 4,
    } }, scope)
    assert.deepEqual(renamedByPath.kind === 'completed' ? renamedByPath.value : null,
      { file_id: 7, old_name: 'renamed.txt', name: 'renamed-again.txt', version: 5 })
    const replayedFileRename = await ports.toolRegistry.tools.dispatch({ id: 'rename-path', name: 'rename_file', input: {
      file: '/personal/notes.txt', new_name: 'renamed-again', expected_version: 4,
    } }, scope)
    assert.deepEqual(replayedFileRename.kind === 'completed' ? replayedFileRename.value : null,
      { file_id: 7, old_name: 'renamed.txt', name: 'renamed-again.txt', version: 5 })
    assert.equal(replayedFileRename.kind === 'completed' && replayedFileRename.mutated, false, '改名路径在源逻辑路径变化后仍从回执恢复')
    const recoveredFileRename = await ports.toolRegistry.tools.reconcile({ id: 'rename-path', name: 'rename_file', input: {
      file: '/personal/notes.txt', new_name: 'renamed-again', expected_version: 4,
    } }, { ...identity, roundId: '1' })
    assert.deepEqual(recoveredFileRename.kind === 'completed' ? recoveredFileRename.value : null,
      { file_id: 7, old_name: 'renamed.txt', name: 'renamed-again.txt', version: 5 })
    assert.equal(recoveredFileRename.kind === 'completed' && recoveredFileRename.mutated, false, 'Run 恢复仅读取已提交改名结果')
    const changedExtension = await ports.toolRegistry.tools.dispatch({ id: 'rename-ext', name: 'rename_file', input: {
      file_id: 7, new_name: 'renamed-full.md', expected_version: 5,
    } }, scope)
    assert.deepEqual(changedExtension.kind === 'completed' ? changedExtension.value : null,
      { file_id: 7, old_name: 'renamed-again.txt', name: 'renamed-full.md', version: 6 })
    const renameBatchInput = { renames: [
      { file_id: 7, new_name: '批量改名.md', expected_version: 6 },
      { file: '/personal/missing.txt', new_name: '不存在' },
    ] }
    const renameBatch = await ports.toolRegistry.tools.dispatch({ id: 'rename-batch', name: 'rename_file', input: renameBatchInput }, scope)
    assert.equal(renameBatch.kind, 'completed', '批量改名应返回已完成结果，以区分校验拒绝与待恢复状态')
    assert.deepEqual(renameBatch.value, {
      success: true, renamed_count: 1, failed_count: 1,
      renamed: [{ index: 0, file_id: 7, old_name: 'renamed-full.md', name: '批量改名.md', version: 7 }],
      failed: [{ item: '/personal/missing.txt', error: '文件路径不存在或不唯一；请用 list_dir 确认' }],
    })
    const replayedRenameBatch = await ports.toolRegistry.tools.dispatch({ id: 'rename-batch', name: 'rename_file', input: renameBatchInput }, scope)
    assert.equal(replayedRenameBatch.kind === 'completed' && replayedRenameBatch.mutated, false, '批量改名恢复复用成功项收据，不重复改名')
    assert.deepEqual(replayedRenameBatch.kind === 'completed' ? replayedRenameBatch.value : null, renameBatch.kind === 'completed' ? renameBatch.value : null)
    const copied = await ports.toolRegistry.tools.dispatch({ id: 'copy', name: 'copy_file', input: {
      file_id: 7, space: 'personal',
    } }, scope)
    assert.deepEqual(copied.kind === 'completed' ? copied.value : null, { file_id: 9, name: 'notes(1)', version: 1 })
    const copiedByPath = await ports.toolRegistry.tools.dispatch({ id: 'copy-path', name: 'copy_file', input: {
      file: '/personal/notes.txt', space: 'personal',
    } }, scope)
    assert.deepEqual(copiedByPath.kind === 'completed' ? copiedByPath.value : null,
      { file_id: 10, name: 'notes(1)', version: 1 })
    const replayedCopy = await ports.toolRegistry.tools.dispatch({ id: 'copy', name: 'copy_file', input: {
      file_id: 7, space: 'personal',
    } }, scope)
    assert.deepEqual(replayedCopy.kind === 'completed' ? replayedCopy.value : null, { file_id: 9, name: 'notes(1)', version: 1 })
    assert.equal(replayedCopy.kind === 'completed' && replayedCopy.mutated, false, '重复调用只返回收据结果，不再次复制')
    assert.equal(copySideEffects, 2)
    const recoveredCopy = await ports.toolRegistry.tools.reconcile({ id: 'copy', name: 'copy_file', input: {
      file_id: 7, space: 'personal',
    } }, { ...identity, roundId: '1' })
    assert.deepEqual(recoveredCopy.kind === 'completed' ? recoveredCopy.value : null, { file_id: 9, name: 'notes(1)', version: 1 })
    assert.equal(recoveredCopy.kind === 'completed' && recoveredCopy.mutated, false, '恢复只读取已提交收据')
    const created = await ports.toolRegistry.tools.dispatch({ id: 'create', name: 'create_file', input: {
      filename: 'draft.txt', content: '新建内容', space: 'personal',
    } }, scope)
    assert.deepEqual(created.kind === 'completed' ? created.value : null, { file_id: 9, name: 'draft.txt', size_bytes: Buffer.byteLength('新建内容') })
    assert.equal(created.kind === 'completed' && created.mutated, true)
    const replayedCreate = await ports.toolRegistry.tools.dispatch({ id: 'create', name: 'create_file', input: {
      filename: 'draft.txt', content: '新建内容', space: 'personal',
    } }, scope)
    assert.equal(replayedCreate.kind === 'completed' && replayedCreate.mutated, false, '同一持久操作收据重放不得报告为第二次创建')
    const createdFolder = await ports.toolRegistry.tools.dispatch({ id: 'folder-create', name: 'create_folder', input: {
      folder_name: '子目录', space: 'personal',
    } }, scope)
    assert.deepEqual(createdFolder.kind === 'completed' ? createdFolder.value : null, {
      folder_id: 11, name: '子目录', version: 1, file_count: 0, folder_count: 0,
    })
    const replayedFolder = await ports.toolRegistry.tools.dispatch({ id: 'folder-create', name: 'create_folder', input: {
      folder_name: '子目录', space: 'personal',
    } }, scope)
    assert.equal(replayedFolder.kind === 'completed' && replayedFolder.mutated, false, '重复创建只读取持久结果，不再执行文件夹事务')
    const recoveredFolder = await ports.toolRegistry.tools.reconcile({ id: 'folder-create', name: 'create_folder', input: {
      folder_name: '子目录', space: 'personal',
    } }, { ...identity, roundId: '1' })
    assert.equal(recoveredFolder.kind === 'completed' && recoveredFolder.mutated, false, '进程恢复只返回持久结果')
    const changedFolderCall = await ports.toolRegistry.tools.dispatch({ id: 'folder-create', name: 'create_folder', input: {
      folder_name: '改参目录', space: 'personal',
    } }, scope)
    assert.equal(changedFolderCall.kind, 'unknown', '同一调用标识改参不得创建第二个文件夹')
    assert.equal(folderCreateCalls, 1)
    const renamedFolder = await ports.toolRegistry.tools.dispatch({ id: 'folder-rename', name: 'rename_folder', input: {
      folder_id: 12, new_folder_name: '新版资料', expected_version: 3,
    } }, scope)
    assert.deepEqual(renamedFolder.kind === 'completed' ? renamedFolder.value : null, {
      folder_id: 12, name: '新版资料', version: 4,
    })
    const replayedRename = await ports.toolRegistry.tools.dispatch({ id: 'folder-rename', name: 'rename_folder', input: {
      folder_id: 12, new_folder_name: '新版资料', expected_version: 3,
    } }, scope)
    assert.equal(replayedRename.kind === 'completed' && replayedRename.mutated, false, '重复改名只读持久结果')
    assert.equal(folderRenameCalls, 1)
    const staleFolderRename = await ports.toolRegistry.tools.dispatch({ id: 'folder-rename-stale', name: 'rename_folder', input: {
      folder_id: 12, new_folder_name: '过期改名', expected_version: 3,
    } }, scope)
    assert.equal(staleFolderRename.kind === 'completed' && staleFolderRename.successful, false, '旧版本不得调用文件夹事务')
    const moved = await ports.toolRegistry.tools.dispatch({ id: 'move-items', name: 'move_items', input: {
      files: [7], folders: [12], target: { space: 'project', project_id: 5, folder_id: 20 },
    } }, scope)
    assert.deepEqual(moved.kind === 'completed' ? moved.value : null, {
      moved_files: 1, moved_folders: 1, failed_count: 0,
      files: [{ file_id: 7, name: 'renamed-full.md', space: 'project', project_id: 5, folder_id: 20 }],
      folders: [{ folder_id: 12, name: '新版资料', folder_count: 2, space: 'project', project_id: 5 }], failed: [],
    })
    const movedByPath = await ports.toolRegistry.tools.dispatch({ id: 'move-path', name: 'move_items', input: {
      files: ['/personal/notes.txt'], target: { space: 'project', project_id: 6 },
    } }, scope)
    assert.deepEqual(movedByPath.kind === 'completed' ? movedByPath.value : null, {
      moved_files: 1, moved_folders: 0, failed_count: 0,
      files: [{ file_id: 7, name: 'renamed-full.md', space: 'project', project_id: 6, folder_id: null }], folders: [], failed: [],
    })
    const beforeRevocation = fileQueries
    active = false
    const revoked = await ports.toolRegistry.tools.dispatch({ id: 'after-revoke', name: 'read_file', input: { file_id: 7 } }, scope)
    assert.equal(revoked.kind === 'completed' && revoked.executed, false)
    const revokedMove = await ports.toolRegistry.tools.dispatch({ id: 'after-revoke-move', name: 'move_items', input: {
      files: [7], target: { space: 'personal' },
    } }, scope)
    assert.equal(revokedMove.kind === 'completed' && revokedMove.executed, false)
    assert.equal(fileQueries, beforeRevocation, 'lease 撤销后不得查询或打开文件')
  } finally {
    await core?.close()
    await rm(root, { recursive: true, force: true })
  }
})


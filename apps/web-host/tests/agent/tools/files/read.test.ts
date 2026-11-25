import { createOwnedTextReader } from '@gugu/core/tools'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createAuthorizedWebAgentProductionRagRunPorts } from '../../../../src/modules/agent/rag/production.js'
import { createWebAgentFileReadPort } from '../../../../src/modules/agent/tools/files/read.js'
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

test('Web 拒绝退役工具并保留受控正文读取', async () => {
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
    const lease = { identity, token: 'synthetic-token', fence: 1, mode: 'start' as const, cancelRequested: false,
      input: { v: 2 as const, source: 'web' as const, userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64) } }
    const pool = { async query(sql: string, values: unknown[]) {
      if (sql.includes('agent_run_dispatch')) return { rowCount: active ? 1 : 0, rows: [{}] }
      if (sql.includes('FROM chat_attachments')) {
        assert.deepEqual(values, ['historical-text', ownerId])
        attachmentQueries++
        return { rowCount: 1, rows: [{ attach_id: 'historical-text', user_id: ownerId, storage_key: attachmentPath,
          name: '历史备注.txt', ext: 'txt', kind: 'text', size: Buffer.byteLength('历史附件第一行\n历史附件第二行') }] }
      }
      assert.match(sql, /FROM files\s+WHERE path=\$1 AND user_id=\$2 AND deleted_at IS NULL/u)
      assert.equal(values[1], ownerId)
      fileQueries++
      if (values[0] !== relativePath && values[0] !== officePath) return { rowCount: 0, rows: [] }
      const office = values[0] === officePath
      return { rowCount: 1, rows: [{ user_id: ownerId, path: office ? officePath : relativePath,
        display_name: office ? 'report' : 'notes', ext: office ? 'pdf' : 'txt', mime_type: office ? 'application/pdf' : 'text/plain', version: 1,
        space: 'personal', project_id: null, workspace_directory_id: null }] }
    } }
    const ports = createAuthorizedWebAgentProductionRagRunPorts({
      core: core!, pool: pool as never, storageRoot: root, lease,
      selection: { contextPolicy: { loadOwnerContext: true, memoryEnabled: true }, contextScopeKey: lease.input.accessVersion, modelIdentity: 'synthetic-model' },
      enabled: async () => true,
    })
    const read = createOwnedTextReader(createWebAgentFileReadPort(pool as never, root, lease, {
      async list(current, signal) {
        signal.throwIfAborted()
        assert.deepEqual(current, identity)
        return [
          { filePath: relativePath, name: 'notes.txt', path: '/personal/notes.txt' },
          { filePath: officePath, name: 'report.pdf', path: '/personal/report.pdf' },
        ]
      },
    }))
    const retired = ['read_file', 'list_dir', 'grep', 'edit_file', 'rename_file', 'copy_file', 'create_file',
      'create_folder', 'rename_folder', 'move_items', 'compress_files', 'extract_files']
    const available = (await ports.configuration(identity, new AbortController().signal)).toolNames
    for (const name of retired) assert.ok(!available.includes(name), name)
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('退役工具不得执行宿主命令') } }
    for (const name of retired) {
      const result = await ports.toolRegistry.tools.dispatch({ id: `retired-${name}`, name, input: {} }, scope)
      assert.equal(result.kind === 'completed' && !result.successful && result.executed === false, true, name)
    }
    const result = await read({ file: '/personal/notes.txt', target_lines: '2-3' }, scope)
    assert.deepEqual(result.kind === 'completed' ? result.value : null, {
      file: '/personal/notes.txt', name: 'notes.txt', content: '第二行\n第三行', numbered_content: '2: 第二行\n3: 第三行',
      line_range: { start: 2, end: 3 }, _source_size_bytes: Buffer.byteLength('第一行\r\n第二行\n第三行'),
    })
    const pathRead = await read({ file: '/personal/notes.txt', target_lines: '1' }, scope)
    assert.deepEqual(pathRead.kind === 'completed' ? pathRead.value : null, {
      file: '/personal/notes.txt', name: 'notes.txt', content: '第一行\r\n', numbered_content: '1: 第一行',
      line_range: { start: 1, end: 1 }, _source_size_bytes: Buffer.byteLength('第一行\r\n第二行\n第三行'),
    })
    const officeRead = await read({ file: '/personal/report.pdf' }, scope)
    assert.equal(officeRead.successful, true)
    assert.match(JSON.stringify(officeRead.value), /Synthetic report text/u)
    assert.equal(officeRead.value && typeof officeRead.value === 'object' && 'name' in officeRead.value ? officeRead.value.name : null, 'report.pdf')
    const attachmentRead = await read({
      attach_id: 'historical-text', target_lines: '2',
    }, scope)
    assert.deepEqual(attachmentRead.kind === 'completed' ? attachmentRead.value : null, {
      attach_id: 'historical-text', name: '历史备注.txt', content: '历史附件第二行',
      numbered_content: '2: 历史附件第二行', line_range: { start: 2, end: 2 },
      _source_size_bytes: Buffer.byteLength('历史附件第一行\n历史附件第二行'),
    })
    const attachmentBatch = await read({
      items: [{ attach_id: 'historical-text', title: '旧附件' }],
    }, scope)
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
    assert.equal((await read({ file: '/personal/../private.txt' }, scope)).successful, false)
    assert.equal((await read({ file: 'file:///private/private.txt' }, scope)).successful, false)
    const batch = await read({ items: [
      { file: '/personal/notes.txt', target_lines: '1', title: '已有文件' }, { file: '/personal/missing.txt', result_id: '异主或不存在' },
    ] }, scope)
    assert.deepEqual(batch.kind === 'completed' ? batch.value : null, {
      results: [
        { index: 1, label: '已有文件', successful: true, value: {
          file: '/personal/notes.txt', name: 'notes.txt', content: '第一行\r\n', numbered_content: '1: 第一行',
          line_range: { start: 1, end: 1 },
        } },
        { index: 2, label: '异主或不存在', successful: false, value: { error: '文件不存在或无权访问' } },
      ],
      successful_count: 1, failed_count: 1, total_source_size_bytes: Buffer.byteLength('第一行\r\n第二行\n第三行'),
    })
    const missing = await read({ file: '/personal/missing.txt' }, scope)
    assert.equal(missing.kind === 'completed' && JSON.stringify(missing.value).includes('文件不存在或无权访问'), true)
    const beforeRevocation = fileQueries
    active = false
    const revoked = await ports.toolRegistry.tools.dispatch({ id: 'after-revoke', name: 'read_file', input: { file: '/personal/notes.txt' } }, scope)
    assert.equal(revoked.kind === 'completed' && revoked.executed, false)
    assert.equal(fileQueries, beforeRevocation, 'lease 撤销后不得查询或打开文件')
  } finally {
    await core?.close()
    await rm(root, { recursive: true, force: true })
  }
})


import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import JSZip from 'jszip'
import type { Pool } from 'pg'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'
import { createPostgresXlsxPreviewOperations } from '../../src/modules/files/xlsx-preview-postgres.js'

const ownerId = '00000000-0000-4000-8000-000000000081'
const otherOwnerId = '00000000-0000-4000-8000-000000000082'
const secret = 'synthetic-xlsx-preview-secret'
const rootDirectories: string[] = []
const apps: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
  await Promise.all(rootDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function makeXlsx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('xl/workbook.xml', '<workbook xmlns:r="urn:r"><sheets><sheet name="合成表" r:id="rId1"/></sheets></workbook>')
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
  zip.file('xl/worksheets/sheet1.xml', '<worksheet xmlns:r="urn:r"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>样例值</t></is></c></row></sheetData><drawing r:id="rIdDraw"/></worksheet>')
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="rIdDraw" Target="../drawings/drawing1.xml"/></Relationships>')
  zip.file('xl/drawings/drawing1.xml', '<wsDr xmlns:r="urn:r"><oneCellAnchor><from><col>1</col><row>0</row></from><ext cx="9525" cy="9525"/><pic><blipFill><blip r:embed="rIdImage"/></blipFill></pic></oneCellAnchor></wsDr>')
  zip.file('xl/drawings/_rels/drawing1.xml.rels', '<Relationships><Relationship Id="rIdImage" Target="../media/image.png"/></Relationships>')
  zip.file('xl/media/image.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64'))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

test('XLSX preview routes use the authenticated owner and the PostgreSQL plus local-file adapter', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-xlsx-preview-'))
  rootDirectories.push(root)
  const storageKey = `${ownerId}/sample.xlsx`
  const filePath = path.join(root, storageKey)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, await makeXlsx())
  const sqlCalls: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    async query(sql: string, params: unknown[]) {
      sqlCalls.push({ sql, params })
      const [fileId, userId] = params
      if (userId !== ownerId) return { rows: [] }
      if (fileId === 23) return { rows: [{ id: 23, storage_key: storageKey, ext: 'XLSX', version: 7 }] }
      if (fileId === 24) return { rows: [{ id: 24, storage_key: `${ownerId}/sample.txt`, ext: 'txt', version: 1 }] }
      if (fileId === 25) return { rows: [{ id: 25, storage_key: `${ownerId}/missing.xlsx`, ext: 'xlsx', version: 1 }] }
      return { rows: [] }
    },
  } as unknown as Pick<Pool, 'query'>
  const operations = createPostgresXlsxPreviewOperations(pool, root)
  const app = createApp({
    appName: '合成测试应用', isReady: async () => true,
    userAuth: { secret, async lookupUser(id) {
      return id === ownerId || id === otherOwnerId ? {
        id, username: 'sample', displayName: null, email: 'sample@example.invalid', avatarUrl: null,
        createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1,
      } : null
    } },
    fileReads: {
      async getFile() { return null }, async getFileLocation() { return null }, async getSummary() { return {} },
      async getLibraryCounts() { return {} }, async getStorage() { return {} }, async openContent() { return null },
      ...operations,
    },
  })
  apps.push(app)
  const token = createUserToken(ownerId, 1, secret)
  const otherToken = createUserToken(otherOwnerId, 1, secret)
  const denied = await app.inject({ url: '/api/v1/files/23/xlsx-preview' })
  const preview = await app.inject({ url: '/api/v1/files/23/xlsx-preview', headers: { authorization: `Bearer ${token}` } })
  const foreign = await app.inject({ url: '/api/v1/files/23/xlsx-preview', headers: { authorization: `Bearer ${otherToken}` } })
  const unsupported = await app.inject({ url: '/api/v1/files/24/xlsx-preview', headers: { authorization: `Bearer ${token}` } })
  const missing = await app.inject({ url: '/api/v1/files/25/xlsx-preview', headers: { authorization: `Bearer ${token}` } })
  const image = await app.inject({ url: '/api/v1/files/23/xlsx-preview-image/0', headers: { authorization: `Bearer ${token}` } })

  assert.equal(denied.statusCode, 401)
  assert.equal(preview.statusCode, 200, preview.payload)
  assert.deepEqual(preview.json(), { version: 7, sheets: [{ images: { '0:1': [{ id: 0, width: 1, height: 1 }] }, data: {
    name: '合成表', cells: { A1: '样例值' }, merges: [], rowHeights: {}, colWidths: {}, rows: 1, cols: 1,
  } }] })
  assert.equal(foreign.statusCode, 404)
  assert.equal(unsupported.statusCode, 415)
  assert.equal(unsupported.json<{ detail: string }>().detail, '仅支持 XLSX 文件')
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json<{ detail: string }>().detail, '物理文件丢失')
  assert.equal(image.statusCode, 200)
  assert.equal(image.headers['content-type'], 'image/png')
  assert.equal(image.headers['cache-control'], 'private, max-age=86400')
  assert.deepEqual(image.rawPayload, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64'))
  assert.deepEqual(sqlCalls.map(({ params }) => params), [
    [23, ownerId], [23, otherOwnerId], [24, ownerId], [25, ownerId], [23, ownerId],
  ])
})

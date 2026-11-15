import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataContext } from '../../../src/contracts/index.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createKyselySqliteGlobalSearchSources } from '../../../src/search/sqlite.js'
import { createGlobalSearchOperations } from '../../../src/search/global-search.js'
import { parseGlobalSearchQuery } from '../../../src/search/query.js'
import { casefoldSearchText } from '../../../src/search/unicode.js'
import { strip } from '../../../src/shared/values.js'

interface Result { queries: readonly string[]; total: number; mode: string; groups: Array<{ type: string; items: Array<Record<string, unknown>> }> }
let folder: string, core: SqlDataRuntime, owner: string, other: string, queries: number
let ids: { exact: number; prefix: number; contains: number; multi: number; deleted: number; foreign: number }
const key = (value: string) => value.replaceAll('-', '')
function sources() {
  return createKyselySqliteGlobalSearchSources(core.db.withPlugin({ transformQuery(args) { queries++; return args.node }, async transformResult(args) { return args.result } }))
}
async function search(raw: unknown, user = owner): Promise<Result> {
  const query = parseGlobalSearchQuery(raw)
  return await createGlobalSearchOperations(sources()).search(user, query.types === null && query.queries.length ? { ...query, types: ['project', 'event', 'client'] } : query) as Result
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'gugu-global-search-'))
  const filename = join(folder, 'core.db')
  await initializeSqlite(filename)
  const opened = await openSqliteRuntime(filename, { clock: () => '2026-11-15T00:00:00Z' })
  core = opened.runtime; owner = opened.ownerId; other = randomUUID(); queries = 0
  const rows = await core.transaction(dataContext(owner), async data => [
    await data.projects.create({ name: 'alpha' }), await data.projects.create({ name: 'alpha plan' }),
    await data.projects.create({ name: 'x alpha' }), await data.projects.create({ name: 'alpha beta', client: 'beta' }),
    await data.projects.create({ name: 'alpha已删除' }),
  ])
  const foreign = await core.transaction(dataContext(other), data => data.projects.create({ name: 'alpha他人' }))
  ids = { exact: rows[0]!.id, prefix: rows[1]!.id, contains: rows[2]!.id, multi: rows[3]!.id, deleted: rows[4]!.id, foreign: foreign.id }
  await sql`UPDATE projects SET deleted_at='2026-11-15 00:00:00' WHERE id=${ids.deleted}`.execute(core.db)
  await core.transaction(dataContext(owner), async data => {
    await data.clients.create({ name: 'alpha联系人', notes: '', contact: null, email: null, phone: null })
    await data.clients.create({ name: '其他名称', notes: 'alpha beta', contact: null, email: null, phone: null })
  })
  await core.transaction(dataContext(other), data => data.clients.create({ name: 'alpha他人联系人', notes: '' }))
  for (const [id, user, title, date, deleted] of [[1, owner, 'alpha活动', '2026-11-14', null], [2, owner, 'alpha活动', '2026-11-16', null], [3, other, 'alpha他人活动', '2026-11-17', null], [4, owner, 'alpha已删除活动', '2026-11-18', '2026-11-15 00:00:00']] as const)
    await sql`INSERT INTO calendar_events(id,user_id,title,date,type,description,version,created_at,deleted_at) VALUES(${id},${key(user)},${title},${date},'event',NULL,1,'2026-11-15 00:00:00',${deleted})`.execute(core.db)
})
afterEach(async () => { await core?.close(); if (folder) await rm(folder, { recursive: true, force: true }) })

describe('真实正式SQLite的三领域全局搜索切片', () => {
  it('完整Unicode标量的折叠与Python16独立oracle一致，strip不采用JS空白集合', () => {
    // 此摘要由Python3.14逐标量str.casefold生成，不从Node映射表生成期望。
    const hash = createHash('sha256'), stripped: number[] = []
    for (let codepoint = 0; codepoint <= 0x10ffff; codepoint++) {
      if (codepoint >= 0xd800 && codepoint <= 0xdfff) continue
      const character = String.fromCodePoint(codepoint)
      hash.update(codepoint.toString(16) + ':' + casefoldSearchText(character) + '\n')
      if (strip(character) === '') stripped.push(codepoint)
    }
    expect(hash.digest('hex')).toBe('b7491f53a5513d531763fca7f83a831e0ccaa86f8cea68523999fa89110e55ab')
    expect(stripped).toEqual([9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 133, 160, 5760,
      8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288])
    expect(casefoldSearchText('\ud800A\udfff')).toBe('\ud800a\udfff')
    expect(strip('\ufeff目标\ufeff')).toBe('\ufeff目标\ufeff')
    const interior = '前' + ' '.repeat(100_000) + '后'
    expect(strip('\u0085' + interior + '\u001c')).toBe(interior)
    expect(strip(' '.repeat(100_000))).toBe('')
  })
  it('去重采用完整casefold，保留首词原貌且不做兼容分解或语言特例', () => {
    for (const values of [['Straße', 'STRASSE'], ['Σ', 'ς', 'σ'], ['ﬃ', 'ffi'], ['Ꭰ', 'ꭰ']])
      expect(parseGlobalSearchQuery({ queries: values }).queries).toEqual([values[0]])
    expect(parseGlobalSearchQuery({ queries: ['İ', 'i\u0307', 'i', 'ı', 'Ａ', 'a'] }).queries)
      .toEqual(['İ', 'i', 'ı', 'Ａ', 'a'])
    expect(parseGlobalSearchQuery({ queries: ['\u001c目标\u0085', '目标', '\ufeff目标\ufeff'] }).queries)
      .toEqual(['目标', '\ufeff目标\ufeff'])
    expect(parseGlobalSearchQuery({ queries: ['a'.repeat(63) + 'ß', 'a'.repeat(63) + 'ss'] }).queries)
      .toEqual(['a'.repeat(63) + 'ß', 'a'.repeat(63) + 's'])
  })
  it('Python归一化经过实际查询，去重影响AND结果且FEFF不被错误删除', async () => {
    const created = await core.transaction(dataContext(owner), async data => [
      await data.projects.create({ name: 'Straße' }), await data.projects.create({ name: 'STRASSE' }),
    ])
    const first = await search({ queries: ['Straße', 'STRASSE'], mode: 'AND', types: 'project' })
    expect(first.queries).toEqual(['Straße'])
    expect(first.groups[0]!.items.map(row => row.id)).toEqual([created[0]!.id])
    const reverse = await search({ queries: ['STRASSE', 'Straße'], mode: 'AND', types: 'project' })
    expect(reverse.groups[0]!.items.map(row => row.id)).toEqual([created[1]!.id])
    expect(await search({ q: '\u001calpha\u0085', types: 'project' })).toMatchObject({ query: 'alpha', total: 4 })
    expect(await search({ q: '\ufeffalpha\ufeff', types: 'project' })).toMatchObject({ query: '\ufeffalpha\ufeff', total: 0 })
    expect(await search({ q: '\u001c\u0085', types: 'project' })).toMatchObject({ query: '', queries: [], total: 0 })
  })
  it('搜索parser保留短语入口、大小写去重与8词64码点限制', () => {
    const parsed = parseGlobalSearchQuery({ q: '不覆盖queries', queries: [' Alpha ', 'ALPHA', '😀'.repeat(65), '中文短语', '其他短语', '4', '5', '6', '7', '8'] })
    expect(parsed.queries).toEqual(['Alpha', '😀'.repeat(64), '中文短语', '其他短语', '4', '5', '6', '7'])
    expect(parsed.queries).toHaveLength(8)
  })
  it('三来源分组投影、owner/软删过滤、null字段及日期倒序', async () => {
    const result = await search({ q: 'alpha' }, owner.toUpperCase())
    expect(result.groups.map(group => group.type)).toEqual(['project', 'event', 'client'])
    expect(result.groups.find(group => group.type === 'event')!.items).toEqual([
      { id: 2, title: 'alpha活动', date: '2026-11-16', subtitle: '2026-11-16' },
      { id: 1, title: 'alpha活动', date: '2026-11-14', subtitle: '2026-11-14' },
    ])
    expect(result.groups.find(group => group.type === 'client')!.items).toContainEqual(expect.objectContaining({ title: 'alpha联系人', subtitle: '' }))
    const projects = result.groups.find(group => group.type === 'project')!.items
    expect(projects.map(row => row.id).sort()).toEqual([ids.exact, ids.prefix, ids.contains, ids.multi].sort())
    expect(JSON.stringify(result)).not.toContain('他人')
    expect(JSON.stringify(result)).not.toContain('已删除')
    const foreign = await search({ q: 'alpha' }, other)
    expect(foreign.groups.find(group => group.type === 'project')!.items.map(item => item.id)).toEqual([ids.foreign])
  })
  it('命中关键词数优先，然后首词精确/前缀排名，AND/OR和每类limit保留', async () => {
    const ranked = await search({ queries: ['alpha', 'beta'], types: 'project', per_type: '2' })
    expect(ranked.groups[0]!.items.map(row => row.id)).toEqual([ids.multi, ids.exact])
    const all = await search({ queries: ['alpha', 'beta'], types: 'project', mode: 'and' })
    expect(all.groups[0]!.items.map(row => row.id)).toEqual([ids.multi])
    const single = await search({ q: 'alpha', types: 'project', per_type: '1' })
    expect(single.groups[0]!.items.map(row => row.id)).toEqual([ids.exact])
    const phrases = await search({ queries: ['alpha plan'], types: 'project' })
    expect(phrases.groups[0]!.items.map(row => row.id)).toEqual([ids.prefix])
    await sql`UPDATE projects SET updated_at='2025-01-01 00:00:00' WHERE id=${ids.exact}`.execute(core.db)
    await sql`UPDATE projects SET updated_at='2026-01-01 00:00:00' WHERE id=${ids.prefix}`.execute(core.db)
    await sql`UPDATE projects SET updated_at='2026-02-01 00:00:00' WHERE id=${ids.multi}`.execute(core.db)
    await sql`UPDATE projects SET updated_at='2026-03-01 00:00:00' WHERE id=${ids.contains}`.execute(core.db)
    expect((await search({ q: 'alpha', types: 'project' })).groups[0]!.items.map(row => row.id)).toEqual([ids.exact, ids.multi, ids.prefix, ids.contains])
    const crossField = await core.transaction(dataContext(owner), data => data.projects.create({ name: 'alpha跨字段', client: 'beta' }))
    expect((await search({ queries: ['alpha', 'beta'], types: 'project', mode: 'AND' })).groups[0]!.items.map(row => row.id).sort()).toEqual([ids.multi, crossField.id].sort())
    expect((await search({ q: 'alpha', per_type: '1' })).groups.every(group => group.items.length === 1)).toBe(true)
  })
  it('SQLite lowerLIKE保持非ASCII区别且查询参数不能注入SQL', async () => {
    await core.transaction(dataContext(owner), data => data.projects.create({ name: 'Änne' }))
    expect((await search({ q: 'änne', types: 'project' })).total).toBe(0)
    expect((await search({ q: "%' OR 1=1 --", types: 'project' })).total).toBe(0)
  })
  it('默认非空查询显式报告缺失能力且不执行 SQL，已选来源仍可搜索', async () => {
    const operations = createGlobalSearchOperations(sources())
    expect(operations.availableTypes).toEqual(['project', 'event', 'client'])
    expect(operations.missingTypes).toEqual(['file', 'folder', 'conversation', 'note', 'canvas_note', 'skill', 'mcp', 'scheduled_task'])
    await expect(operations.search(owner, parseGlobalSearchQuery({ q: 'alpha' }))).rejects.toMatchObject({ code: 'conflict', missingTypes: operations.missingTypes })
    expect(queries).toBe(0)
    expect(await operations.search(owner, parseGlobalSearchQuery({ q: '' }))).toMatchObject({ total: 0, groups: [] })
    expect(queries).toBe(0)
    const partial = await operations.search(owner, parseGlobalSearchQuery({ q: 'alpha', types: ['project', 'client'] })) as Result
    expect(partial.groups.map(group => group.type)).toEqual(['project', 'client'])
  })
  it('空query与未知types零SQL，已知但未装配file明确conflict', async () => {
    expect(await search({ q: '  ' })).toMatchObject({ total: 0, groups: [] })
    expect(await search({ q: 'alpha', types: 'unknown' })).toMatchObject({ total: 0, groups: [] })
    await expect(search({ q: 'alpha', types: 'file' })).rejects.toMatchObject({ code: 'conflict' })
    expect(queries).toBe(0)
  })
  it('非法参数/owner/预取消不查SQL，真实缺表错误不得假空结果', async () => {
    for (const raw of [{ queries: [1] }, { per_type: '0' }, { per_type: '201' }, { per_type: '1.5' }, { q: 1 }, { types: 1 }])
      await expect(search(raw)).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(search({ q: 'alpha' }, 'not-an-owner')).rejects.toThrow()
    const controller = new AbortController(), reason = new Error('合成预取消')
    controller.abort(reason)
    await expect(createGlobalSearchOperations(sources()).search(owner, parseGlobalSearchQuery({ q: 'alpha' }), { signal: controller.signal })).rejects.toBe(reason)
    expect(queries).toBe(0)
    await sql`DROP TABLE calendar_events`.execute(core.db)
    await expect(search({ q: 'alpha', types: 'event' })).rejects.toThrow()
  })
  it('等待真实查询结果期间原query突变不能改变后续来源的冻结查询', async () => {
    const entered = deferred(), release = deferred()
    let first = true
    const db = core.db.withPlugin({ transformQuery(args) { return args.node }, async transformResult(args) {
      if (first) { first = false; entered.resolve(); await release.promise }
      return args.result
    } })
    const original = { ...parseGlobalSearchQuery({ q: 'alpha' }), queries: ['alpha'], types: ['project', 'event', 'client'] as const }
    const pending = createGlobalSearchOperations(createKyselySqliteGlobalSearchSources(db)).search(owner, original)
    await entered.promise
    original.queries[0] = '他人'; original.q = '他人'
    release.resolve()
    const result = await pending as Result
    expect(result.queries).toEqual(['alpha'])
    expect(result.groups.map(group => group.type)).toEqual(['project', 'event', 'client'])
    expect(JSON.stringify(result)).not.toContain('他人')
  })
  it('直接来源查询取消等待真实cleanup，驱动错误不覆盖原取消原因', async () => {
    const entered = deferred(), release = deferred(), controller = new AbortController(), reason = new Error('合成搜索取消')
    let cleaned = false, settled = false
    const db = core.db.withPlugin({ transformQuery(args) { return args.node }, async transformResult() {
      entered.resolve(); await release.promise; cleaned = true; throw new Error('合成结果处理错误')
    } })
    const source = createKyselySqliteGlobalSearchSources(db).find(item => item.type === 'project')!
    const pending = source.search(owner, parseGlobalSearchQuery({ q: 'alpha' }), controller.signal)
    const observed = pending.then(() => { settled = true; return null }, error => { settled = true; return error })
    await entered.promise; controller.abort(reason); await Promise.resolve()
    expect(settled).toBe(false); expect(cleaned).toBe(false)
    release.resolve()
    expect(await observed).toBe(reason); expect(cleaned).toBe(true)
    expect((await search({ q: 'alpha', types: 'project' })).total).toBeGreaterThan(0)
  })
})

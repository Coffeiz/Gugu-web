import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { RAG_INDEX_COLUMNS, tablesSql } from '@gugu/core/data'

const ledger='gugu_node_rag_migrations',revision='rag_index_0001'
const ddl=[tablesSql('postgres').ragIndexEntries,...tablesSql('postgres').ragIndexIndexes].join(';\n').replaceAll(' IF NOT EXISTS', '')
const expectedIndexes=tablesSql('postgres').ragIndexIndexes.map(statement=>{
 const match=/^CREATE INDEX IF NOT EXISTS ([a-z0-9_]+) ON knowledge_index_entries\(([^)]+)\)$/u.exec(statement)
 if(!match)throw new Error('RAG 索引定义无效')
 return {name:match[1]!,columns:match[2]!.split(',').map(column=>column.trim())}
})
export function ragIndexDefinitionsMatch(actual:readonly {index_name:string;columns:string[];valid:boolean;ready:boolean}[]):boolean {
 return expectedIndexes.every(expected=>{
  const index=actual.find(item=>item.index_name===expected.name)
  return Boolean(index&&index.valid&&index.ready&&JSON.stringify(index.columns)===JSON.stringify(expected.columns))
 })
}
const checksum=createHash('sha256').update(revision).update('\n').update(ddl).digest('hex')
const baselineRevision = 'rag_node_baseline_0001'
// 固定首次接管的来源集合。新增来源需要独立迁移。
const baselineSources = ['calendar', 'canvas', 'conversation', 'knowledge', 'memory', 'note', 'project', 'scheduled_task']
const baselineSql = `INSERT INTO rag_index_jobs (
  user_id, source_type, source_id, pending_source_ids, version, operation, status,
  generation, completed_generation, attempts, next_attempt_at, created_at, updated_at
) SELECT u.id, source.name, '', '[]'::json, '', 'refresh', 'queued', 1, 0, 0,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM users u CROSS JOIN unnest($1::text[]) source(name)
  ORDER BY u.id, source.name
  ON CONFLICT (user_id, source_type) DO UPDATE SET
    source_id='', pending_source_ids='[]'::json, version='', operation='refresh', status='queued',
    generation=rag_index_jobs.generation+1, attempts=0, next_attempt_at=CURRENT_TIMESTAMP,
    lease_until=NULL, last_error_code=NULL, updated_at=CURRENT_TIMESTAMP`
const baselineChecksum = createHash('sha256').update(baselineRevision).update(JSON.stringify(baselineSources)).update(baselineSql).digest('hex')
export class RagIndexMigrationError extends Error {
 constructor(readonly code:'incompatible'|'unavailable'){super(code==='incompatible'?'RAG 索引迁移状态不兼容':'RAG 索引迁移失败')}
}
async function inspect(client:PoolClient):Promise<'pending'|'applied'>{
 const scope=await client.query<{valid:boolean}>(`SELECT CASE WHEN current_schema() IS NULL THEN false
   ELSE to_regclass('users') IS NOT NULL AND bool_and(to_regclass(name) IS NOT DISTINCT FROM
     to_regclass(format('%I.%I',current_schema(),name))) END AS valid
   FROM unnest($1::text[]) names(name)`,[[ledger,'users','knowledge_index_entries']])
 if(!scope.rows[0]?.valid)throw new RagIndexMigrationError('incompatible')
 const objects=await client.query<{managed:boolean;indexed:boolean}>(
  "SELECT to_regclass($1) IS NOT NULL AS managed,to_regclass('knowledge_index_entries') IS NOT NULL AS indexed",[ledger])
 const { managed, indexed }=objects.rows[0]!
 if(!managed&&!indexed)return 'pending'
 if(!managed||!indexed)throw new RagIndexMigrationError('incompatible')
 const columns=await client.query<{column_name:string;is_nullable:string}>(`SELECT column_name,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='knowledge_index_entries' ORDER BY ordinal_position`)
 const expected=RAG_INDEX_COLUMNS.map((name:string)=>`${name}:${['parent_document_id','source_updated_at','deleted_at'].includes(name)?'YES':'NO'}`)
 const actual=columns.rows.map(row=>`${row.column_name}:${row.is_nullable}`)
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw new RagIndexMigrationError('incompatible')
 const unique=await client.query<{columns:string[]}>('SELECT array_agg(a.attname::text ORDER BY u.ordinality) AS columns FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY u(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=u.attnum WHERE n.nspname=current_schema() AND t.relname=$1 AND c.contype=\'u\' GROUP BY c.conname',['knowledge_index_entries'])
 if(!unique.rows.some(row=>JSON.stringify(row.columns)===JSON.stringify(['owner_user_id','source_type','source_id','document_version','chunk_index'])))throw new RagIndexMigrationError('incompatible')
 const rows=await client.query<{revision:string;checksum:string}>(`SELECT revision,checksum FROM ${ledger}`)
 const applied = new Map(rows.rows.map(row => [row.revision, row.checksum]))
 if (applied.get(revision) !== checksum || rows.rows.some(row =>
   row.revision !== revision && (row.revision !== baselineRevision || row.checksum !== baselineChecksum))) {
   throw new RagIndexMigrationError('incompatible')
 }
 const ownerFk=await client.query<{valid:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND t.relname='knowledge_index_entries' AND c.contype='f' AND pg_get_constraintdef(c.oid) ~ 'FOREIGN KEY \\(owner_user_id\\) REFERENCES users\\(id\\) ON DELETE CASCADE') AS valid`)
 if(!ownerFk.rows[0]?.valid)throw new RagIndexMigrationError('incompatible')
 const indexes=await client.query<{index_name:string;columns:string[];valid:boolean;ready:boolean}>(`SELECT index_class.relname AS index_name,array_agg(attribute.attname::text ORDER BY key.ordinality) AS columns,index_data.indisvalid AS valid,index_data.indisready AS ready
  FROM pg_class table_class JOIN pg_namespace table_schema ON table_schema.oid=table_class.relnamespace
  JOIN pg_index index_data ON index_data.indrelid=table_class.oid JOIN pg_class index_class ON index_class.oid=index_data.indexrelid
  CROSS JOIN LATERAL unnest(index_data.indkey) WITH ORDINALITY AS key(attnum,ordinality)
  JOIN pg_attribute attribute ON attribute.attrelid=table_class.oid AND attribute.attnum=key.attnum
  WHERE table_schema.nspname=current_schema() AND table_class.relname='knowledge_index_entries' AND index_class.relname=ANY($1::text[])
  GROUP BY index_class.relname,index_data.indisvalid,index_data.indisready`,[expectedIndexes.map(index=>index.name)])
  if(!ragIndexDefinitionsMatch(indexes.rows))throw new RagIndexMigrationError('incompatible')
 return 'applied'
}
export async function checkRagIndexMigration(pool:Pick<Pool,'connect'>):Promise<'pending'|'applied'>{
 let client:PoolClient;try{client=await pool.connect()}catch{throw new RagIndexMigrationError('unavailable')}
 try{await client.query('BEGIN READ ONLY');const result=await inspect(client);await client.query('COMMIT');return result}
 catch(error){await client.query('ROLLBACK').catch(()=>undefined);if(error instanceof RagIndexMigrationError)throw error;throw new RagIndexMigrationError('unavailable')}
 finally{client.release()}
}
/** 显式建立 Node 派生索引；来源记录由可信 Node Worker 重建。 */
export async function applyRagIndexMigration(pool:Pick<Pool,'connect'>):Promise<'applied'|'unchanged'>{
 let client:PoolClient;try{client=await pool.connect()}catch{throw new RagIndexMigrationError('unavailable')}
 try{
  await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='10s'");await client.query("SET LOCAL statement_timeout='60s'")
  await client.query('SELECT pg_advisory_xact_lock($1,$2)',[1196779349,1380011593])
  if(await inspect(client)==='applied'){await client.query('COMMIT');return 'unchanged'}
  await client.query(`CREATE TABLE ${ledger}(revision text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  await client.query(ddl)
  await client.query(`ALTER TABLE knowledge_index_entries ADD CONSTRAINT fk_knowledge_index_owner FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE`)
  await client.query(`INSERT INTO ${ledger}(revision,checksum) VALUES($1,$2)`,[revision,checksum])
  if(await inspect(client)!=='applied')throw new RagIndexMigrationError('incompatible')
  await client.query('COMMIT');return 'applied'
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);if(error instanceof RagIndexMigrationError)throw error;throw new RagIndexMigrationError('unavailable')}
 finally{client.release()}
}

/** 首次切换 Node Worker 时补建所有现有用户。此命令只入队，正文由授权 Worker 投影。 */
export async function queueNodeRagCutoverBaseline(
 pool: Pick<Pool, 'connect'>,
): Promise<{ status: 'queued' | 'unchanged'; jobs: number }> {
 let client: PoolClient
 try { client = await pool.connect() } catch { throw new RagIndexMigrationError('unavailable') }
 try {
   await client.query('BEGIN')
   await client.query("SET LOCAL lock_timeout='10s'")
   await client.query("SET LOCAL statement_timeout='60s'")
   await client.query('SELECT pg_advisory_xact_lock($1,$2)', [1196779349, 1380011593])
   if (await inspect(client) !== 'applied') throw new RagIndexMigrationError('incompatible')
   const record = await client.query(`SELECT 1 FROM ${ledger} WHERE revision=$1`, [baselineRevision])
   if (record.rowCount === 1) {
     await client.query('COMMIT')
     return { status: 'unchanged', jobs: 0 }
   }
   const scoped = await client.query<{ valid: boolean }>(`SELECT to_regclass('rag_index_jobs') IS NOT NULL
     AND to_regclass('rag_index_jobs') = to_regclass(format('%I.rag_index_jobs',current_schema())) AS valid`)
   if (!scoped.rows[0]?.valid) throw new RagIndexMigrationError('incompatible')
   const queued = await client.query(baselineSql, [baselineSources])
   await client.query(`INSERT INTO ${ledger}(revision,checksum) VALUES($1,$2)`, [baselineRevision, baselineChecksum])
   await client.query('COMMIT')
   return { status: 'queued', jobs: queued.rowCount ?? 0 }
 } catch (error) {
   await client.query('ROLLBACK').catch(() => undefined)
   if (error instanceof RagIndexMigrationError) throw error
   throw new RagIndexMigrationError('unavailable')
 } finally {
   client.release()
 }
}

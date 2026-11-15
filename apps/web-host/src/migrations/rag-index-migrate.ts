import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { RAG_INDEX_COLUMNS, tablesSql } from '@gugu/core/data'

const ledger='gugu_node_rag_migrations',revision='rag_index_0001'
const ddl=[tablesSql('postgres').ragIndexEntries,...tablesSql('postgres').ragIndexIndexes].join(';\n')
const checksum=createHash('sha256').update(revision).update('\n').update(ddl).digest('hex')
export class RagIndexMigrationError extends Error {
 constructor(readonly code:'incompatible'|'unavailable'){super(code==='incompatible'?'RAG 索引迁移状态不兼容':'RAG 索引迁移失败')}
}
async function inspect(client:PoolClient):Promise<'pending'|'applied'>{
 const scope=await client.query<{valid:boolean}>(`SELECT current_schema() IS NOT NULL AND bool_and(to_regclass(name) IS NOT DISTINCT FROM to_regclass(format('%I.%I',current_schema(),name))) AS valid FROM unnest($1::text[]) names(name)`,[[ledger,'users']])
 if(!scope.rows[0]?.valid)throw new RagIndexMigrationError('incompatible')
 const found=await client.query<{name:string|null}>('SELECT to_regclass($1)::text AS name',[ledger])
 const table=await client.query<{name:string|null}>('SELECT to_regclass($1)::text AS name',['knowledge_index_entries'])
 if(!found.rows[0]?.name&&!table.rows[0]?.name)return 'pending'
 if(table.rows[0]?.name){
  const columns=await client.query<{column_name:string;is_nullable:string}>(`SELECT column_name,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='knowledge_index_entries' ORDER BY ordinal_position`)
  const expected=RAG_INDEX_COLUMNS.map((name:string)=>`${name}:${['parent_document_id','source_updated_at','deleted_at'].includes(name)?'YES':'NO'}`)
  const actual=columns.rows.map(row=>`${row.column_name}:${row.is_nullable}`)
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw new RagIndexMigrationError('incompatible')
  const unique=await client.query<{columns:string[]}>('SELECT array_agg(a.attname ORDER BY u.ordinality) AS columns FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY u(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=u.attnum WHERE n.nspname=current_schema() AND t.relname=$1 AND c.contype=\'u\' GROUP BY c.conname',['knowledge_index_entries'])
  if(!unique.rows.some(row=>JSON.stringify(row.columns)===JSON.stringify(['owner_user_id','source_type','source_id','document_version','chunk_index'])))throw new RagIndexMigrationError('incompatible')
  const ownerFk=await client.query<{valid:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND t.relname='knowledge_index_entries' AND c.contype='f' AND pg_get_constraintdef(c.oid) ~ 'FOREIGN KEY \\(owner_user_id\\) REFERENCES users\\(id\\) ON DELETE CASCADE') AS valid`)
  if(found.rows[0]?.name&&!ownerFk.rows[0]?.valid)throw new RagIndexMigrationError('incompatible')
  if(!found.rows[0]?.name)return 'pending' // 校验过的 Python 表可由本迁移认领。
 }
 if(!found.rows[0]?.name)throw new RagIndexMigrationError('incompatible')
 const rows=await client.query<{revision:string;checksum:string}>(`SELECT revision,checksum FROM ${ledger}`)
 if(rows.rows.length!==1||rows.rows[0]?.revision!==revision||rows.rows[0]?.checksum!==checksum)throw new RagIndexMigrationError('incompatible')
 const ownerFk=await client.query<{valid:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND t.relname='knowledge_index_entries' AND c.contype='f' AND pg_get_constraintdef(c.oid) ~ 'FOREIGN KEY \\(owner_user_id\\) REFERENCES users\\(id\\) ON DELETE CASCADE') AS valid`)
 if(!ownerFk.rows[0]?.valid)throw new RagIndexMigrationError('incompatible')
 return 'applied'
}
export async function checkRagIndexMigration(pool:Pick<Pool,'connect'>):Promise<'pending'|'applied'>{
 let client:PoolClient;try{client=await pool.connect()}catch{throw new RagIndexMigrationError('unavailable')}
 try{await client.query('BEGIN READ ONLY');const result=await inspect(client);await client.query('COMMIT');return result}
 catch(error){await client.query('ROLLBACK').catch(()=>undefined);if(error instanceof RagIndexMigrationError)throw error;throw new RagIndexMigrationError('unavailable')}
 finally{client.release()}
}
/** 显式执行；可认领列/唯一键兼容的旧 Python 索引表，不回填正文或改写来源数据。 */
export async function applyRagIndexMigration(pool:Pick<Pool,'connect'>):Promise<'applied'|'unchanged'>{
 let client:PoolClient;try{client=await pool.connect()}catch{throw new RagIndexMigrationError('unavailable')}
 try{
  await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='10s'");await client.query("SET LOCAL statement_timeout='60s'")
  await client.query('SELECT pg_advisory_xact_lock($1,$2)',[1196779349,1380011593])
  if(await inspect(client)==='applied'){await client.query('COMMIT');return 'unchanged'}
  await client.query(`CREATE TABLE ${ledger}(revision text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  await client.query(ddl)
  const ownerFk=await client.query<{valid:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='knowledge_index_entries'::regclass AND contype='f' AND pg_get_constraintdef(oid) ~ 'FOREIGN KEY \\(owner_user_id\\) REFERENCES users\\(id\\) ON DELETE CASCADE') AS valid`)
  if(!ownerFk.rows[0]?.valid)await client.query(`ALTER TABLE knowledge_index_entries ADD CONSTRAINT fk_knowledge_index_owner FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE`)
  await client.query(`INSERT INTO ${ledger}(revision,checksum) VALUES($1,$2)`,[revision,checksum])
  if(await inspect(client)!=='applied')throw new RagIndexMigrationError('incompatible')
  await client.query('COMMIT');return 'applied'
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);if(error instanceof RagIndexMigrationError)throw error;throw new RagIndexMigrationError('unavailable')}
 finally{client.release()}
}

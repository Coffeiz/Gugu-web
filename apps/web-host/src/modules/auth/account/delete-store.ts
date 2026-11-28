import {createHash} from 'node:crypto'
import bcrypt from 'bcryptjs'
import path from 'node:path'
import type {Pool,PoolClient} from 'pg'
import { createAccountDeleter } from './delete-account.js'
import {CoreError} from '@gugu/core'
import {removeLocalTree} from '@gugu/fs/node'
import {withPostgresTransaction} from '../../../adapters/database/postgres-transaction.js'
import {deleteOwnerThumbnailCache} from '../../files/content.js'

type Attachment={storage_key:string}

export function createPostgresAccountPasswordVerifier(pool:Pick<Pool,'query'>){
  return async(ownerId:string,password:string):Promise<boolean>=>{
    const result=await pool.query<{hashed_password:string}>('SELECT hashed_password FROM users WHERE id=$1',[ownerId])
    return bcrypt.compare(password,result.rows[0]?.hashed_password??'')
  }
}

/** Production PostgreSQL, local-storage and Redis adapters for the shared Core deletion use case. */
export function createPostgresAccountDeleter(
  pool:Pick<Pool,'query'|'connect'>,
  storageRoot:string,
  clearLegacyAttachments:(ownerId:string)=>Promise<readonly string[]>,
  publishAuthStateChanged:(ownerId:string)=>Promise<unknown>,
) {
  const root=path.resolve(storageRoot)
  return createAccountDeleter({
    async accountExists(ownerId){
      const user=await pool.query('SELECT id FROM users WHERE id=$1',[ownerId])
      return user.rows.length > 0
    },
    async removeThumbnails(ownerId){deleteOwnerThumbnailCache(ownerId)},
    async removeStoragePrefixes(ownerId){
      const normal=await removeLocalTree(root,ownerId)
      const legacy=await removeLocalTree(root,`u/${ownerId}`)
      return normal+legacy
    },
    async clearEphemeralData(ownerId){
      const storageKeys=await withPostgresTransaction(pool,async client=>{
        const rows=await client.query<Attachment>(
          "SELECT storage_key FROM chat_attachments WHERE user_id=$1 AND state='draft' FOR UPDATE",[ownerId])
        await client.query("DELETE FROM chat_attachments WHERE user_id=$1 AND state='draft'",[ownerId])
        return [...new Set(rows.rows.map(row=>row.storage_key))]
      })
      for(const key of storageKeys){
        try{
          await withPostgresTransaction(pool,async client=>{
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
              `chat-attachment:${ownerId}:${key}`])
            const stillReferenced=await client.query(
              'SELECT 1 FROM chat_attachments WHERE user_id=$1 AND storage_key=$2 LIMIT 1',[ownerId,key])
            if(!stillReferenced.rows.length)await removeLocalTree(root,key)
          })
        }catch{/* Python 兼容语义：暂存物理对象清理失败不阻止注销。 */}
      }
      const legacyKeys=await clearLegacyAttachments(ownerId)
      for(const key of legacyKeys){
        try{await removeLocalTree(root,key)}catch{/* 单个历史对象失败不阻止其他清理。 */}
      }
    },
    async deleteDatabaseUser(ownerId){
      return withPostgresTransaction(pool,async(client:PoolClient)=>{
        const deleted=await client.query('DELETE FROM users WHERE id=$1 RETURNING id',[ownerId])
        return deleted.rowCount===1
      })
    },
    publishAuthStateChanged,
    onStorageCleanupFailure(error,ownerId){
      const ownerFingerprint=createHash('sha256').update(ownerId).digest('hex').slice(0,12)
      const errorType=error instanceof Error?error.name:'UnknownError'
      console.warn(`[account-deletion] 存储清理失败 owner=${ownerFingerprint} error=${errorType}`)
    },
  })
}

export function createPostgresAdminAccountDeleter(
  pool:Pick<Pool,'query'>,
  remove:(ownerId:string)=>Promise<number>,
) {
  return async(ownerId:string):Promise<{username:string;storageObjectsRemoved:number}>=>{
    const user=await pool.query<{username:string|null}>('SELECT username FROM users WHERE id=$1',[ownerId])
    const username=user.rows[0]?.username
    if(username===undefined)throw new CoreError('not_found','用户不存在')
    const storageObjectsRemoved=await remove(ownerId)
    return {username:username??'',storageObjectsRemoved}
  }
}

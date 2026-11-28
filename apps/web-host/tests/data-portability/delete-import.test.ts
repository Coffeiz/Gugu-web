import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDataImportDeleter } from '@gugu/core/data-portability/delete-import'
import { createDataImportCanceler } from '@gugu/core/data-portability/cancel-import'
import { createLocalDataImportArtifactRemover } from '../../src/modules/data-portability/archive.js'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/modules/auth/session/token.js'

const ownerA = '00000000-0000-4000-8000-000000000011'
const ownerB = '00000000-0000-4000-8000-000000000012'
const readyId = '00000000-0000-4000-8000-000000000001'
const activeId = '00000000-0000-4000-8000-000000000002'
const otherId = '00000000-0000-4000-8000-000000000003'
const failId = '00000000-0000-4000-8000-000000000004'
const queuedId = '00000000-0000-4000-8000-000000000005'

test('导入取消只接受 owner 的排队任务，先写入终态并清令牌，暂存清理失败不伪报失败', async () => {
  const secret='synthetic-import-cancel-host-secret'
  const events:string[]=[]
  const jobs=new Map([
    [queuedId,{owner:ownerA,status:'queued',stagingKey:`${ownerA.replaceAll('-', '')}/.data-portability/imports/${queuedId.replaceAll('-', '')}.gupi`,importTokenHash:'synthetic-token-hash'}],
    [activeId,{owner:ownerA,status:'running',stagingKey:null,importTokenHash:'synthetic-running-token'}],
    [otherId,{owner:ownerB,status:'queued',stagingKey:'foreign/staging.gupi',importTokenHash:'synthetic-foreign-token'}],
  ])
  const cancel=createDataImportCanceler({async transaction(work){return work({
    async findOwnedForUpdate(owner,id){const row=jobs.get(id);return row?.owner===owner?{status:row.status,stagingKey:row.stagingKey}:null},
    async cancelQueued(owner,id){const row=jobs.get(id);assert.equal(row?.owner,owner);assert.equal(row?.status,'queued');row.status='canceled';row.importTokenHash=null;events.push('commit')},
  })}})
  const app=createApp({
    appName:'导入取消测试应用',isReady:async()=>true,cancelDataImport:cancel,
    cleanupDataImportStaging:async(_owner,_job,key)=>{events.push(`cleanup:${key}`);throw new Error('synthetic cleanup failure')},
    portabilityJobs:{async getImport(owner,id){const row=jobs.get(id);if(row?.owner!==owner)throw new Error('missing');return {id,status:row.status,stage:row.status,mode:'preflight',progress_current:0,progress_total:null,error_code:null,preview:null,created_at:null,expires_at:null,rollback_expires_at:null}}} as never,
    userAuth:{secret,async lookupUser(id){return [ownerA,ownerB].includes(id)?{
      id,username:'sample',displayName:'小北',email:'sample@example.invalid',avatarUrl:null,createdAt:null,timezone:null,
      emailSubscribed:false,imChannels:[],isActive:true,securityVersion:1,
    }:null}},
  })
  try{
    const headers={authorization:`Bearer ${createUserToken(ownerA,1,secret)}`}
    assert.equal((await app.inject({method:'POST',url:`/api/v1/data-portability/imports/${queuedId}/cancel`})).statusCode,401)
    const response=await app.inject({method:'POST',url:`/api/v1/data-portability/imports/${queuedId}/cancel`,headers:{...headers,'x-user-id':ownerB}})
    assert.equal(response.statusCode,200,response.body)
    assert.equal(response.json().status,'canceled')
    assert.deepEqual(events,['commit',`cleanup:${ownerA.replaceAll('-', '')}/.data-portability/imports/${queuedId.replaceAll('-', '')}.gupi`])
    assert.equal(jobs.get(queuedId)?.importTokenHash,null)
    assert.equal((await app.inject({method:'POST',url:`/api/v1/data-portability/imports/${activeId}/cancel`,headers})).statusCode,409)
    assert.equal((await app.inject({method:'POST',url:`/api/v1/data-portability/imports/${otherId}/cancel`,headers})).statusCode,404)
  }finally{await app.close()}
})

test('导入删除只清理 owner 的终态任务文件，清理失败或活动任务时保留任务', async () => {
  const secret='synthetic-import-delete-host-secret'
  const deletedFiles: string[] = []
  const jobs = new Map([
    [readyId, { owner: ownerA, status: 'failed', stagingKey: `${ownerA.replaceAll('-', '')}/.data-portability/imports/${readyId.replaceAll('-', '')}.gupi`, rollbackKey: `${ownerA.replaceAll('-', '')}/.data-portability/imports/${readyId.replaceAll('-', '')}.rollback.gupi` }],
    [activeId, { owner: ownerA, status: 'running', stagingKey: null, rollbackKey: null }],
    [otherId, { owner: ownerB, status: 'failed', stagingKey: null, rollbackKey: null }],
    [failId, { owner: ownerA, status: 'failed', stagingKey: `${ownerA.replaceAll('-', '')}/.data-portability/imports/${failId.replaceAll('-', '')}.gupi`, rollbackKey: `${ownerA.replaceAll('-', '')}/.data-portability/imports/${failId.replaceAll('-', '')}.rollback.gupi` }],
  ])
  const remove = createDataImportDeleter({
    async transaction(work) {
      return work({
        async findOwnedForUpdate(owner, id) {
          const row = jobs.get(id)
          return row?.owner === owner ? { status: row.status, stagingKey: row.stagingKey, rollbackKey: row.rollbackKey } : null
        },
        async deleteOwned(_owner, id) { jobs.delete(id) },
      })
    },
  }, async (_owner, _job, key) => {
    deletedFiles.push(key)
    if (key.includes(failId.replaceAll('-', ''))) throw new Error('synthetic storage failure')
  })
  const app = createApp({
    appName:'导入删除测试应用',isReady:async()=>true,deleteDataImport:remove,
    userAuth:{secret,async lookupUser(id){return [ownerA,ownerB].includes(id)?{
      id,username:'sample',displayName:'小北',email:'sample@example.invalid',avatarUrl:null,createdAt:null,timezone:null,
      emailSubscribed:false,imChannels:[],isActive:true,securityVersion:1,
    }:null}},
  })
  try {
    const headers = { authorization: `Bearer ${createUserToken(ownerA,1,secret)}` }
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/data-portability/imports/${readyId}` })).statusCode, 401)
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/data-portability/imports/not-a-uuid', headers })).statusCode, 422)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/data-portability/imports/${readyId}`, headers: { ...headers, 'x-user-id': ownerB } })).statusCode, 204)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/data-portability/imports/${activeId}`, headers })).statusCode, 409)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/data-portability/imports/${otherId}`, headers })).statusCode, 404)
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/data-portability/imports/${failId}`, headers })).statusCode, 503)
    assert.deepEqual(deletedFiles, [
      `${ownerA.replaceAll('-', '')}/.data-portability/imports/${readyId.replaceAll('-', '')}.gupi`,
      `${ownerA.replaceAll('-', '')}/.data-portability/imports/${readyId.replaceAll('-', '')}.rollback.gupi`,
      `${ownerA.replaceAll('-', '')}/.data-portability/imports/${failId.replaceAll('-', '')}.gupi`,
    ])
    assert.equal(jobs.has(readyId), false)
    assert.equal(jobs.has(failId), true)
    assert.equal(jobs.has(otherId), true)
  } finally { await app.close() }
})

test('导入归档清理拒绝符号链接目录，不会触碰 owner 根目录外文件', async () => {
  if (process.platform !== 'linux') return
  const root = await mkdtemp(join(tmpdir(), 'gugu-import-delete-'))
  const outside = await mkdtemp(join(tmpdir(), 'gugu-import-outside-'))
  const ownerHex = ownerA.replaceAll('-', '')
  const jobHex = readyId.replaceAll('-', '')
  const relative = `${ownerHex}/.data-portability/imports/${jobHex}.gupi`
  try {
    await mkdir(join(outside, 'imports'), { recursive: true })
    await writeFile(join(outside, 'imports', `${jobHex}.gupi`), '保留的外部暂存文件')
    await mkdir(join(root, ownerHex, '.data-portability'), { recursive: true })
    await symlink(outside, join(root, ownerHex, '.data-portability', 'imports'))
    const remove = createLocalDataImportArtifactRemover(root)
    await assert.rejects(remove(ownerA, readyId, relative))
    assert.equal(await readFile(join(outside, 'imports', `${jobHex}.gupi`), 'utf8'), '保留的外部暂存文件')
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

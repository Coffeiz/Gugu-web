import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import test from 'node:test'
import {Pool} from 'pg'
import {tablesSql} from '../../../../packages/core/src/data/schema.js'
import {createNotificationBroadcaster} from '../../../../packages/core/src/notifications/broadcast.js'
const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('通知先持久化再发布，渠道独立、TTL和失败无回滚且无效目标不投递', {skip:!url&&'需要隔离PG'},async()=>{
 const schema=`broadcast_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`}),delivered:unknown[]=[]
 try{
  await pool.query(tablesSql('postgres').siteNotifications)
  const broadcast=createNotificationBroadcaster((sql,params)=>pool.query(sql,params),async(target,note)=>{
   assert.equal((await pool.query('SELECT id FROM site_notifications WHERE id=$1',[note.id])).rows.length,1)
   delivered.push([target,note]);throw new Error('合成投递失败')
  },()=>new Date('2026-01-01T00:00:00Z'))
  const defaults={title:'',content:'合成通知',color:'#abc',target:'all',bubble:true,persist:false,bubble_ttl_hours:2}
  const result=await broadcast(defaults);assert.equal(result.ok,true)
  assert.equal(delivered.length,1)
  assert.equal((await pool.query('SELECT bubble_expire_at FROM site_notifications WHERE id=$1',[result.id])).rows[0].bubble_expire_at.toISOString(),'2026-01-01T02:00:00.000Z')
  await assert.rejects(broadcast({...defaults,title:' ',content:' '}),/标题和内容不能同时为空/)
  await assert.rejects(broadcast({...defaults,bubble:false,persist:false}),/至少选一个/)
  await broadcast({...defaults,target:'not-a-user',bubble:false,persist:true});assert.equal(delivered.length,1)
  await broadcast({...defaults,target:'00000000000040008000000000000001',bubble_ttl_hours:0})
  assert.equal((delivered[1] as unknown[])[0],'00000000-0000-4000-8000-000000000001')
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM site_notifications')).rows[0].count,3)
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

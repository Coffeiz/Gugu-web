import assert from 'node:assert/strict'
import test from 'node:test'
import {signExportDownloadTicket,verifyExportDownloadTicket} from '../../src/modules/data-portability/download-ticket.js'
const owner='00000000-0000-4000-8000-000000000001',job='00000000-0000-4000-8000-000000000002'
test('下载票据绑定任务和到期时间，在有效期内可复用且不把密钥放进URL',()=>{
 const ticket=signExportDownloadTicket('synthetic-ticket-secret',owner,job,100)
 assert.equal(verifyExportDownloadTicket('synthetic-ticket-secret',ticket,job,100),owner)
 assert.equal(verifyExportDownloadTicket('synthetic-ticket-secret',ticket.replace(':100:',':+100:'),job,100),owner)
 assert.equal(verifyExportDownloadTicket('synthetic-ticket-secret',ticket,job,100),owner)
 assert.equal(verifyExportDownloadTicket('synthetic-ticket-secret',ticket,job,101),null)
 assert.equal(verifyExportDownloadTicket('synthetic-ticket-secret',ticket,owner,100),null)
 assert.equal(verifyExportDownloadTicket('synthetic-ticket-secret',ticket+'x',job,100),null)
 assert.equal(ticket.includes('synthetic-ticket-secret'),false)
})

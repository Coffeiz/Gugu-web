import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID,createHmac} from 'node:crypto'
import {createUserBotBindingCodeIssuer} from '@gugu/core/im/binding-code'
test('绑定码按owner平台隔离、已绑定拒绝，HMAC合约分平台且不保存明文',async()=>{
 const owner=randomUUID(),saved:{key:string,value:string,ttl:number}[]=[],messages:string[]=[]
 let row:Record<string,unknown>|undefined={owner_platform_user_id:null}
 const issue=createUserBotBindingCodeIssuer({query:async()=>({rows:row?[row]:[]}),save:async(key,value,ttl)=>{saved.push({key,value,ttl})},generateCode:()=> '000042',generateChallenge:()=> 'synthetic-challenge',sign:message=>{messages.push(message);return createHmac('sha256','synthetic-secret').update(message).digest('hex')}})
 for(const platform of ['qq','telegram'] as const){assert.deepEqual(await issue(owner,31,platform),{code:'000042',expires_in:600});assert.equal(saved.at(-1)?.key,`im:${platform}-binding:31`);assert.equal(saved.at(-1)?.ttl,600);assert.equal(Object.values(JSON.parse(saved.at(-1)!.value)).includes('000042'),false)}
 assert.deepEqual(messages,[`31:${owner}:000042`,`telegram:31:${owner}:000042`])
 row={owner_platform_user_id:'synthetic-owner'};await assert.rejects(issue(owner,31,'qq'),{statusCode:409})
 row=undefined;await assert.rejects(issue(owner,31,'qq'),{statusCode:404});assert.equal(saved.length,2)
})

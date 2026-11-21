import test from 'node:test'
import assert from 'node:assert/strict'
import {createMcpToolDirectory} from '../../../../../../packages/core/src/mcp/tool-directory.js'

test('按用户配置命中快照；配置变化重发现且失败不覆盖旧快照',async()=>{
 let config='v1',discoveries=0,writes=0,fail=false
 const state:{snapshot:{digest:string;tools:readonly {name:string;description_short:string;description:string;input_schema:Record<string,unknown>;server_id:string;server_name:string;tool_name:string}[]}|null}={snapshot:null}
 const make=createMcpToolDirectory({enabled:()=>true,configs:async owner=>[{id:owner,version:config}],digest:configs=>configs[0]!.version,read:async()=>state.snapshot,discover:async()=>{discoveries++;return {tools:[{name:'mcp_demo_read',description_short:'读取',description:'读取',input_schema:{type:'object'},server_id:'00000000-0000-4000-8000-000000000002',server_name:'demo',tool_name:'read'}],complete:!fail}},writeIfCurrent:async(_owner,digest,tools)=>{writes++;state.snapshot={digest,tools}}})
 const a=await make('00000000-0000-4000-8000-000000000061');assert.equal(a[0]?.name,'mcp_demo_read');assert.equal(discoveries,1);assert.equal(writes,1)
 await make('00000000-0000-4000-8000-000000000061');assert.equal(discoveries,1)
 config='v2';fail=true;await make('00000000-0000-4000-8000-000000000061');assert.equal(discoveries,2);assert.equal(writes,1);assert.equal(state.snapshot?.digest,'v1')
})

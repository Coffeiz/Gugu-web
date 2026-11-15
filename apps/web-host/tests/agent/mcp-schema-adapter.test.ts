import test from 'node:test'
import assert from 'node:assert/strict'
import {descriptionForProvider,descriptionShortOf,prefixedToolName,sanitizeInputSchema,validateInputSchema} from '../../../../packages/core/src/mcp/schema-adapter.js'

test('MCP 工具名按服务命名空间限定并拒绝非法工具名',()=>{
 const romanize=(value:string)=>value==='高德'?'gaode':value
 assert.equal(prefixedToolName('weather','get_forecast',romanize),'mcp_weather_get_forecast')
 assert.equal(prefixedToolName('my server','go',romanize),'mcp_my_server_go')
 assert.equal(prefixedToolName('高德','weather',romanize),'mcp_gaode_weather')
 for(const name of ['get-forecast','a b','','t'.repeat(70)])assert.equal(prefixedToolName('weather',name,romanize),null)
})

test('MCP schema 只接受对象，并保留普通参数契约',()=>{
 assert.notEqual(validateInputSchema('nope'),null)
 assert.notEqual(validateInputSchema({type:'string'}),null)
 assert.notEqual(validateInputSchema({type:'object',properties:[]}),null)
 const schema={type:'object',properties:{city:{type:'string',description:'城市'}},required:['city']}
 assert.equal(validateInputSchema(schema),null)
 assert.deepEqual(sanitizeInputSchema(schema),schema)
})

test('MCP schema 展开本地引用，循环引用降级而不递归溢出',()=>{
 const schema={type:'object',$defs:{node:{type:'object',properties:{city:{type:'string'},child:{$ref:'#/$defs/node'}}}},properties:{root:{$ref:'#/$defs/node'}}}
 const value=sanitizeInputSchema(schema) as any
 assert.equal(value.properties.root.properties.city.type,'string')
 assert.equal(value.properties.root.properties.child.type,'string')
 assert.equal('$defs' in value,false)
})

test('MCP schema 降级组合类型并移除不支持的关键词',()=>{
 const schema={type:'object',$schema:'synthetic',properties:{target:{oneOf:[{type:'null'},{type:'object',properties:{id:{type:'string'}}},{type:'string'}]},thing:{allOf:[{type:'object',properties:{a:{type:'string'}},required:['a']},{type:'object',properties:{b:{type:'integer'}},required:['b']}]},odd:{type:'string',discriminator:{x:1}}}}
 const value=sanitizeInputSchema(schema) as any
 assert.equal(value.properties.target.type,'object')
 assert.equal('oneOf' in value.properties.target,false)
 assert.deepEqual(Object.keys(value.properties.thing.properties).sort(),['a','b'])
 assert.deepEqual(value.properties.thing.required.sort(),['a','b'])
 assert.equal('discriminator' in value.properties.odd,false)
 assert.equal('$schema' in value,false)
})

test('目录短描述截取首个非空行，模型仍收到完整说明',()=>{
 const description='第一行说明\n第二行参数约束\n'+'详细说明'.repeat(80)
 assert.equal(descriptionShortOf(description),'第一行说明')
 assert.equal(descriptionForProvider(description,'默认说明'),description)
 assert.equal(descriptionForProvider('  \n','默认说明'),'默认说明')
 assert.equal(descriptionShortOf(null),'')
 assert.equal(descriptionShortOf('长'.repeat(250)),'长'.repeat(99)+'…')
})

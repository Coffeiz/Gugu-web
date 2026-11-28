import {describe,expect,it} from 'vitest'
import { validateInputArguments } from '../../src/mcp/schema-adapter.js'

describe('MCP 工具参数校验',()=>{
 it('按已发现 schema 的必填、类型、范围和额外字段边界拒绝输入',()=>{
  const schema={type:'object',properties:{address:{type:'string',minLength:2}},required:['address'],additionalProperties:false}
  expect(validateInputArguments('mcp_gaode_geocode',schema,{address:'杭州'})).toEqual({success:true,data:{address:'杭州'}})
  expect(validateInputArguments('mcp_gaode_geocode',schema,{})).toMatchObject({success:false,error:{error:'tool_input_invalid',tool:'mcp_gaode_geocode'}})
  expect(validateInputArguments('mcp_gaode_geocode',schema,{address:'杭'})).toMatchObject({success:false,error:{error:'tool_input_invalid',issues:[{path:'address',rule:'minLength'}]}})
  expect(validateInputArguments('mcp_gaode_geocode',schema,{address:'杭州',owner_id:'other'})).toMatchObject({success:false,error:{error:'tool_input_invalid',issues:[{path:'$',rule:'additionalProperties'}]}})
 })
 it('对无效 schema 和非对象输入生成 Python 兼容错误且不回显输入',()=>{
  expect(validateInputArguments('mcp_gaode_lookup',{type:'string'},{private:'input'})).toMatchObject({success:false,error:{error:'tool_input_invalid'}})
  expect(validateInputArguments('mcp_gaode_lookup',{type:'object'},[])).toMatchObject({success:false,error:{error:'tool_input_invalid',issues:[{path:'$',rule:'type'}]}})
  const invalid=validateInputArguments('mcp_gaode_lookup',{type:'object',properties:{value:{type:'unrecognized'}}},{value:'private'})
  expect(invalid).toMatchObject({success:false,error:{error:'tool_input_invalid'}})
  expect(JSON.stringify(invalid)).not.toContain('private')
 })
 it('先按 MCP schema 兼容规则归一化再校验',()=>{
  expect(validateInputArguments('mcp_gaode_lookup',{type:'object',properties:{query:{type:'string'}},required:['query']},{query:123})).toEqual({success:true,data:{query:'123'}})
 })
})

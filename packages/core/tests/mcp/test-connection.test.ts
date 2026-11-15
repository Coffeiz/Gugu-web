import {describe,expect,it} from 'vitest'
import {filterMcpConnectionTools} from '../../src/mcp/test-connection.js'

describe('MCP 连接测试工具投影',()=>{
  it('只返回可加载工具名，遵循白名单并忽略无效声明',()=>{
    const tools=filterMcpConnectionTools([
      {name:'echo',inputSchema:{type:'object'}},
      {name:'private',inputSchema:{type:'object'}},
      {name:'bad_schema',inputSchema:{type:'string'}},
      {name:'bad-name',inputSchema:{type:'object'}},
      null,
    ],{maxTools:4,allowlist:['echo']})
    expect(tools).toEqual(['echo'])
  })

  it('有效工具超过单 server 限额时整体拒绝，不返回部分工具',()=>{
    expect(()=>filterMcpConnectionTools([
      {name:'one',inputSchema:{type:'object'}},
      {name:'two',inputSchema:{type:'object'}},
    ],{maxTools:1})).toThrow('MCP server 工具数量 2 超出单个 server 上限 1')
  })

  it('重复工具名只计一次，避免重复声明绕过数量约束',()=>{
    expect(filterMcpConnectionTools([
      {name:'echo',inputSchema:{type:'object'}},
      {name:'echo',inputSchema:{type:'object'}},
    ],{maxTools:1})).toEqual(['echo'])
  })
})

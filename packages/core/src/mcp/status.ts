/** 平台MCP入口状态不触发工具发现、连接或凭据读取。 */
export function createMcpStatusReader(readEnabled:()=>unknown){
 return async()=>({enabled:readEnabled()})
}

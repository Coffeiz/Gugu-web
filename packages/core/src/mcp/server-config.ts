export interface McpCredentialSlot {id:string;label:string;target:'header'|'query';name:string;prefix:string}

/** Python MCP 配置接口中稳定的名称规则。 */
export function normalizeMcpServerName(raw:string):string {
 const name=raw.trim()
 if(!/^[\p{L}\p{N}_-]{1,64}$/u.test(name))throw new Error('名称只能包含中文、字母、数字、下划线和连字符（1-64 位）')
 return name
}

/** 校验外部地址形状；字面 IP 的公网判定由 Host 网络适配提供。 */
export function validateMcpEndpoint(raw:string,isPublicLiteral:(host:string)=>boolean):string {
 const endpoint=raw.trim();let parsed:URL
 if(!/^https?:\/\/[^/\s?#]+(?:[/?#]|$)/i.test(endpoint))throw new Error('endpoint URL 格式无效')
 try{parsed=new URL(endpoint)}catch{throw new Error('endpoint URL 格式无效')}
 if(!['http:','https:'].includes(parsed.protocol)||!parsed.hostname)throw new Error('endpoint 必须是包含主机名的 HTTP/HTTPS URL')
 if(parsed.username||parsed.password)throw new Error('endpoint 不能包含内嵌账号或密码')
 if(parsed.port){const port=Number(parsed.port);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('endpoint 端口无效')}
 const host=parsed.hostname.replace(/^\[|\]$/g,'')
 if((host.includes(':')||/^\d+(?:\.\d+){3}$/.test(host))&&!isPublicLiteral(host))throw new Error('endpoint 不能指向内网或本机地址')
 return endpoint
}

export interface McpCommonSettings {confirm_mode:string;timeout_seconds:number;tool_allowlist:readonly string[]}
export function validateMcpCommon<T extends McpCommonSettings>(value:T,maxTools:number):T {
 if(!['auto','confirm_all'].includes(value.confirm_mode))throw new Error('确认模式只支持 auto / confirm_all')
 if(!Number.isInteger(value.timeout_seconds)||value.timeout_seconds<1||value.timeout_seconds>300)throw new Error('超时秒数需在 1-300 之间')
 if(value.tool_allowlist.length>maxTools)throw new Error(`工具白名单最多 ${maxTools} 个工具`)
 if(value.tool_allowlist.some(tool=>typeof tool!=='string'||!tool.trim()))throw new Error('白名单工具名不能为空')
 return value
}

/** 保存前校验槽位，避免把非法 Header 或未声明的值带入外呼。 */
export function normalizeMcpSlots(raw:readonly Record<string,unknown>[]):McpCredentialSlot[] {
 if(raw.length>16)throw new Error('credential_slots 必须是最多 16 项的 JSON 数组')
 const seen=new Set<string>()
 return raw.map(item=>{
  if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('credential_slots 的每一项必须是 JSON 对象')
  const id=String(item.id||'').trim(),label=String(item.label||id).trim(),target=String(item.target||'').trim().toLowerCase(),name=String(item.parameter_name||item.name||'').trim(),prefix=String(item.prefix||'')
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)||seen.has(id))throw new Error('凭据槽位 id 无效或重复')
  if((target!=='header'&&target!=='query')||!name||name.length>256)throw new Error('凭据槽位必须指定 header 或 query 及字段名')
  if(target==='header'&&!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))throw new Error('HTTP Header 名称格式无效，请使用 ASCII 字母、数字或合法标点')
  if(!label||label.length>120||prefix.length>120)throw new Error('凭据槽位标签或前缀过长')
  seen.add(id)
  return {id,label,target,name,prefix}
 })
}

export function validateMcpCredentialValues(slots:readonly McpCredentialSlot[],values:Record<string,string>):Record<string,string> {
 const cleaned:Record<string,string>={}
 for(const [key,value] of Object.entries(values)) {
  const id=key.trim(),slot=slots.find(item=>item.id===id)
  if(!slot)throw new Error(`凭据值包含未知槽位：${id}`)
  if(value.length>4096)throw new Error('单个凭据值不能超过 4096 字符')
  if(!value)continue
  if(slot.target==='header'){
   const injected=slot.prefix+value
   if(/[^\x00-\x7f]/.test(injected))throw new Error('HTTP Header 凭据只能使用 ASCII 字符；请检查密钥值和前缀')
   if(/[\x00-\x1f\x7f]/.test(injected))throw new Error('HTTP Header 凭据不能包含换行或控制字符')
  }
  cleaned[id]=value
 }
 return cleaned
}

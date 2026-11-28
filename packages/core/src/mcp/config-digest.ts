export interface McpDigestConfig {id:string;name:string;transport:string;updated_at:string|null;allowlist:readonly string[]}
/** 输出与Python json.dumps(sort_keys=True,separators=(',',':'),ensure_ascii=True)相同的摘要输入。 */
export function mcpConfigDigestPayload(configs:readonly McpDigestConfig[]):string {
 const canonical=configs.map(config=>({allowlist:config.allowlist,id:config.id,name:config.name,transport:config.transport,updated_at:config.updated_at||''}))
 return JSON.stringify(canonical).replace(/[\u007f-\uffff]/g,char=>`\\u${char.charCodeAt(0).toString(16).padStart(4,'0')}`)
}

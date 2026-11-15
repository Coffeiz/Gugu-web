export type AnalyticsQuery = (sql:string,params:unknown[])=>Promise<{rows:Record<string,unknown>[]}>
const developerFilter = (alias:string) => ` AND ${alias}.user_id NOT IN (SELECT id FROM users WHERE is_developer)`
export async function readSessionDepth(query:AnalyticsQuery,excludeDev:boolean) {
 const rows=(await query(`SELECT s.user_id,MAX(t.turns)::int AS max_turns FROM (SELECT session_id,COUNT(*) AS turns FROM conversation_messages WHERE role='user' GROUP BY session_id) t JOIN conversation_sessions s ON s.id=t.session_id WHERE TRUE ${excludeDev?developerFilter('s'):''} GROUP BY s.user_id`,[])).rows
 const buckets=[{label:'1',users:0},{label:'2-3',users:0},{label:'4-10',users:0},{label:'11-30',users:0},{label:'30+',users:0}]
 for(const row of rows) {const n=Number(row.max_turns);const index=n<=1?0:n<=3?1:n<=10?2:n<=30?3:4; buckets[index]!.users++}
 return {buckets,total_users:rows.length}
}
export async function readChatFunnel(query:AnalyticsQuery,excludeDev:boolean) {
 const row=(await query(`SELECT COUNT(DISTINCT user_id) FILTER(WHERE event='chat_open') AS chat_opened,COUNT(DISTINCT user_id) FILTER(WHERE event='chat_message') AS chat_msg_1,COUNT(DISTINCT user_id) FILTER(WHERE event='chat_message' AND (properties->>'turn')::int>=3) AS chat_msg_3,COUNT(DISTINCT user_id) FILTER(WHERE event='chat_expanded') AS chat_expanded FROM frontend_events e WHERE TRUE ${excludeDev?developerFilter('e'):''}`,[])).rows[0]!
 return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Number(value)]))
}
export async function readToolDistribution(query:AnalyticsQuery,excludeDev:boolean,includeByok:boolean) {
 const rows=(await query(`SELECT elem AS tool_name,COUNT(*)::int AS calls FROM agent_usage a,jsonb_array_elements_text(tools_used::jsonb) AS elem WHERE tools_used IS NOT NULL AND jsonb_typeof(tools_used::jsonb)='array' ${excludeDev?developerFilter('a'):''} ${includeByok?'':'AND NOT is_byok'} GROUP BY elem ORDER BY calls DESC LIMIT 20`,[])).rows
 return rows.map(row=>({tool:row.tool_name,calls:Number(row.calls)}))
}
export async function readActiveDimensions(query:AnalyticsQuery,excludeDev:boolean,includeByok:boolean,now:Date) {
 const dimensions=[['chat','聊天用户','agent_usage','created_at',includeByok?'':' AND is_byok IS FALSE'],['project','项目用户','projects','updated_at',''],['calendar','日历用户','calendar_events','created_at',''],['file','文件用户','files','updated_at',' AND deleted_at IS NULL'],['reminder','提醒用户','scheduled_tasks','last_run_at','']]
 const since=new Date(now.getTime()-7*86400000)
 const results=[]
 for(const [key,label,table,time,extra] of dimensions) {
  const row=(await query(`SELECT COUNT(DISTINCT user_id) AS users FROM ${table} t WHERE ${time}>=$1 ${extra} ${excludeDev?developerFilter('t'):''}`,[since])).rows[0]!
  results.push({key,label,users:Number(row.users)})
 }
 return {window_days:7,dimensions:results}
}

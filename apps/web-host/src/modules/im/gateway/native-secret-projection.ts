import { createHash,randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import type { ImPreflightScope } from '@gugu/core/im/inbound-preflight'
import { lockAgentRunSession } from '../../agent-sessions/persistence/agent-run-startup-postgres.js'
import { projectInteractionPromptLocked } from '../../agent-sessions/persistence/agent-interaction-projection-postgres.js'
const fail=()=>new Error('IM 凭据交互暂不可用')
/** 调用方已验证真实v3/全部锚点/pending/owner；不放宽通用Web敏感表单投影。 */
export async function projectPrivateImSecretPromptLocked(client:PoolClient,identity:RunIdentity,interactionId:string,scope:ImPreflightScope){
  if(scope.chatType!=='c2c'||scope.chatId!==null||scope.ownerId!==identity.ownerId||!await lockAgentRunSession(client,identity))throw fail()
  const row=(await client.query(`SELECT p.id,p.schema_json,p.expires_at FROM interaction_prompts p JOIN agent_interaction_bindings b
    ON b.prompt_id=p.id AND b.user_id=p.user_id AND b.session_id=p.session_id
    WHERE b.user_id=$1 AND b.session_id=$2 AND b.run_id=$3 AND b.interaction_id=$4 AND p.status='active' AND p.expires_at>clock_timestamp() FOR UPDATE OF p`,
  [identity.ownerId,identity.sessionId,identity.runId,interactionId])).rows[0]
  if(!row)throw fail()
  const stage=(await client.query(`SELECT i.status FROM mcp_secret_inputs i JOIN user_mcp_servers m ON m.id=i.server_id AND m.user_id=i.user_id AND m.scope='user'
    WHERE i.prompt_id=$1 AND i.user_id=$2 AND i.session_id=$3 AND i.platform=$4 AND i.bot_id=$5 AND i.platform_user_id=$6
      AND i.chat_type='c2c' AND i.chat_id IS NULL AND i.status IN ('pending_choice','awaiting_secret') AND i.expires_at>clock_timestamp()
      AND i.server_id::text=$7 FOR UPDATE OF i`,
  [row.id,scope.ownerId,identity.sessionId,scope.platform,scope.botId,scope.platformUserId,row.schema_json?.context?.secret_target?.server_id])).rows[0]
  if(!stage||row.schema_json?.source!=='agent'||row.schema_json?.context?.secret_target?.kind!=='mcp_credentials'||!row.schema_json?.secret_fields?.length)throw fail()
  const choices=[{id:'input_credentials',label:'输入凭据',action_type:'choice'},{id:'cancel',label:'取消',action_type:'choice'}]
  const schema={...row.schema_json,options:choices}
  await client.query('UPDATE interaction_prompts SET schema_json=$2 WHERE id=$1',[row.id,JSON.stringify(schema)])
  for(const choice of choices){
    if(choice.id==='input_credentials'&&stage.status!=='pending_choice')continue
    // 同prompt行锁下只创建缺失的可信动作；重发只轮换pending，不复活consumed。
    const existing=await client.query('SELECT id FROM interaction_actions WHERE prompt_id=$1 AND option_id=$2',[row.id,choice.id])
    if(existing.rowCount)continue
    const token=randomBytes(24).toString('base64url')
    await client.query(`INSERT INTO interaction_actions(prompt_id,token_hash,action_type,option_id,context_json,status,expires_at,created_at)
      VALUES($1,$2,'choice',$3,$4,'pending',$5,clock_timestamp())`,[row.id,createHash('sha256').update(token).digest('hex'),choice.id,JSON.stringify(schema.context),row.expires_at])
  }
  const projected=await projectInteractionPromptLocked(client,identity,interactionId,undefined,true)
  // 平台仅接收start/cancel按钮；不接收或渲染任何私密表单字段/输入值。
  return{...projected,secret_fields:[]}
}

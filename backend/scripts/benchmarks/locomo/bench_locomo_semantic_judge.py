import asyncio,json,time,argparse
from pathlib import Path
from uuid import UUID
async def main(a):
 from app.core.config import get_settings
 from app.db import session
 from app.models import User
 from agent.llm.llm_select import resolve_run_config_for_user
 from agent.llm import modelctx
 from agent.context import provider_runner
 session.ensure_engine()
 async with session._SessionLocal() as db:
  u=await db.get(User,UUID(a.user_id))
  if not u or not u.username.startswith('benchmark-locomo-'):raise RuntimeError('非测试账号')
  ai=(await resolve_run_config_for_user(get_settings(),db,u.id)).model
 await session.dispose_engine()
 settings=get_settings();preset=next(p for p in settings.ai_presets.items if p.name=='deepseek')
 ai=ai.model_copy(update=preset.model_dump(exclude={'id','name','in_pool'}));modelctx.mark_user_scope();modelctx.set_model_cfg(ai)
 root=Path(a.root);out=root/'semantic-judge.json';state=json.loads(out.read_text()) if out.exists() else {'model':ai.model,'scores':{}}
 async def call(items):
  for attempt in range(4):
   try:
    result=await provider_runner.complete_json('You are a strict impartial benchmark judge. Evaluate each answer against the reference given the question. Use correct if all essential requested facts match semantically, accepting equivalent dates and synonyms; partial if some essential facts are correct but others missing or contradicted; incorrect if wrong, unsupported or unknown. Ignore harmless extra explanations. Return JSON {"grades":[{"id":"...","verdict":"correct|partial|incorrect"}]}.',json.dumps(items,ensure_ascii=False),settings,max_tokens=3500,thinking='disabled')
    grades=result.get('grades',[]) if isinstance(result,dict) else []
    mapping={str(g.get('id')):g.get('verdict') for g in grades if isinstance(g,dict)}
    if set(mapping)=={x['id'] for x in items} and all(v in {'correct','partial','incorrect'} for v in mapping.values()):return mapping
   except Exception as e:
    if type(e).__name__!='RateLimitError':raise
   print(json.dumps({'stage':'retry','attempt':attempt+1}),flush=True);await asyncio.sleep(10*(attempt+1))
  raise RuntimeError('评分格式或请求失败')
 for i in range(10):
  p=root/f'sample-{i:02d}';data=json.loads((p/'dataset.json').read_text())[0];s=json.loads((p/'state.json').read_text());items=[]
  for key,r in s['answers'].items():
   id=f'{i}:{key}'
   if id not in state['scores']:items.append({'id':id,'question':data['qa'][int(key)]['question'],'reference':r['answer'],'answer':r['prediction']})
  for offset in range(0,len(items),12):
   batch=items[offset:offset+12];state['scores'].update(await call(batch));tmp=out.with_suffix('.tmp');tmp.write_text(json.dumps(state,ensure_ascii=False));tmp.chmod(0o600);tmp.replace(out)
   print(json.dumps({'sample':i,'completed':len(state['scores'])}),flush=True)
 print('ALL_DONE',flush=True)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--allow-real-llm',action='store_true');p.add_argument('--user-id',required=True);p.add_argument('--root',required=True);a=p.parse_args()
 if not a.allow_real_llm:p.error('须允许真实模型')
 asyncio.run(main(a))

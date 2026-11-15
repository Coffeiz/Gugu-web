"""LoCoMo 单对话模拟反思 + 生产 Cython BM25 评测，严格串行。"""
import asyncio,json,time,logging,argparse
from pathlib import Path
from uuid import UUID
async def main(a):
 from app.core.config import get_settings
 from app.db import session
 from app.models import User
 from agent.llm.llm_select import resolve_run_config_for_user
 from agent.llm import modelctx
 from agent.context import provider_runner
 from agent.rag.cython_runtime import ensure_cython_native_loaded
 from agent.rag.cython_backend import build_text_index,search_text,fuse_hybrid_candidates
 from agent.memory import embedding
 import hashlib
 root=Path(a.output);root.mkdir(parents=True,exist_ok=True);root.chmod(0o700)
 session.ensure_engine()
 async with session._SessionLocal() as db:
  u=await db.get(User,UUID(a.user_id))
  if not u or not u.username.startswith('benchmark-locomo-'):raise RuntimeError('非测试账号')
  ai=(await resolve_run_config_for_user(get_settings(),db,u.id)).model
 await session.dispose_engine()
 s=get_settings()
 preset=next(p for p in s.ai_presets.items if p.name=='deepseek')
 ai=ai.model_copy(update=preset.model_dump(exclude={'id','name','in_pool'}))
 modelctx.mark_user_scope();modelctx.set_model_cfg(ai)
 data=json.load(open(a.dataset))[0];conv=data['conversation'];path=root/'state.json'
 state=json.loads(path.read_text()) if path.exists() else {'memories':{},'answers':{},'model':ai.model,'sample_id':data['sample_id'],'method':'LLM simulated memory extraction; production Cython BM25 top12; batched independent QA; categories1-4'}
 def save():
  tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(state,ensure_ascii=False));tmp.chmod(0o600);tmp.replace(path)
 async def call(sys,user,cap):
  for attempt in range(3):
   try:
    out=await asyncio.wait_for(provider_runner.complete_json(sys,user,s,max_tokens=cap,thinking='disabled'),180)
    if out:return out
    if attempt==2:raise RuntimeError('empty_output')
    print(json.dumps({'stage':'empty_retry','attempt':attempt+1}),flush=True)
   except Exception as e:
    if type(e).__name__!='RateLimitError' or attempt==2:raise
    print(json.dumps({'stage':'rate_limit','attempt':attempt+1}),flush=True)
   await asyncio.sleep(30*(attempt+1))
 for key in sorted([k for k in conv if isinstance(conv[k],list)],key=lambda k:int(k.split('_')[1])):
  if key in state['memories']:continue
  text='Date: '+conv[key+'_date_time']+'\n'+'\n'.join(t['speaker']+': '+t['text']+(' Image: '+t['blip_caption'] if t.get('blip_caption') else '') for t in conv[key])
  start=time.monotonic()
  out=await call('Extract durable factual memories from this conversation in English. Preserve who did what, dates, places, preferences and relationships. Each fact must name its subject. Resolve relative dates using the session date. Do not invent facts. Return JSON {"facts":["fact",...]}.',text,3500)
  facts=out.get('facts');
  if not isinstance(facts,list) or not facts:raise RuntimeError('invalid memory schema')
  state['memories'][key]={'facts':[conv[key+'_date_time']+' '+f for f in facts if isinstance(f,str)],'seconds':round(time.monotonic()-start,2)};save()
  print(json.dumps({'stage':'memory','session':key,'facts':len(facts)}),flush=True)
 await ensure_cython_native_loaded()
 docs=[f for v in state['memories'].values() for f in v['facts']];index=build_text_index(docs)
 s.embedding.enabled=True
 vectorfile=root/'vectors.json'
 version=embedding.model_tag()
 digest=hashlib.sha256(json.dumps(docs,ensure_ascii=False).encode()).hexdigest()
 vecstate=json.loads(vectorfile.read_text()) if vectorfile.exists() else {'version':version,'digest':digest,'vectors':{},'seconds':0}
 if vecstate['version']!=version or vecstate['digest']!=digest:raise RuntimeError('vector index identity mismatch')
 for j,doc in enumerate(docs):
  if str(j) in vecstate['vectors']:continue
  start=time.monotonic();v=await embedding.embed(doc)
  if not v:raise RuntimeError('document embedding failed')
  vecstate['vectors'][str(j)]=v;vecstate['seconds']+=time.monotonic()-start
  tmp=vectorfile.with_suffix('.tmp');tmp.write_text(json.dumps(vecstate));tmp.chmod(0o600);tmp.replace(vectorfile)
  if (j+1)%24==0:print(json.dumps({'stage':'index','done':j+1,'total':len(docs)}),flush=True)
 dims={len(v) for v in vecstate['vectors'].values()}
 if len(dims)!=1 or len(vecstate['vectors'])!=len(docs):raise RuntimeError('incomplete vector index')
 state['embedding_index']={'model':s.embedding.model,'dimensions':next(iter(dims)),'documents':len(docs),'build_seconds':vecstate['seconds'],'digest':digest}
 state['method']='simulated memory; production Cython BM25 top50 candidates + production hybrid RRF 0.45 lexical/0.55 vector; top12; dsflash; serial'
 save();print(json.dumps({'stage':'index_ready',**state['embedding_index']}),flush=True)
 qs=[(i,q) for i,q in enumerate(data['qa']) if q['category']!=5 and str(i) not in state['answers']]
 for offset in range(0,len(qs),8):
  batch=qs[offset:offset+8];requests=[]
  for i,q in batch:
   start=time.monotonic();hits=search_text(index,q['question'],limit=50);lexical_ms=(time.monotonic()-start)*1000
   start=time.monotonic();qvec=await embedding.embed(q['question']);embedding_ms=(time.monotonic()-start)*1000
   if not qvec:raise RuntimeError('query embedding failed')
   start=time.monotonic();fused,status=fuse_hybrid_candidates([{'chunk_id':str(j),'score':score} for j,score in hits],qvec,vecstate['vectors'],limit=12);fusion_ms=(time.monotonic()-start)*1000
   if status['fusion']!='hybrid-rrf':raise RuntimeError('hybrid did not activate')
   state.setdefault('retrieval',{})[str(i)]={'lexical_ms':lexical_ms,'embedding_ms':embedding_ms,'fusion_ms':fusion_ms,'ids':[h['chunk_id'] for h in fused]}
   requests.append({'id':i,'question':q['question'],'memories':[docs[int(h['chunk_id'])] for h in fused]})
  start=time.monotonic()
  out=await call('Answer each question independently using only its own memories. Answer in English, briefly without explanation. If not supported say unknown. Return JSON {"answers":[{"id":0,"answer":"..."}]}.',json.dumps(requests,ensure_ascii=False),2500)
  replies={str(x['id']):x['answer'] for x in out.get('answers',[]) if isinstance(x,dict) and 'id' in x and 'answer' in x}
  if any(str(i) not in replies for i,q in batch):raise RuntimeError('incomplete answers')
  for i,q in batch:state['answers'][str(i)]={'prediction':replies[str(i)],'answer':q['answer'],'category':q['category']}
  save();print(json.dumps({'stage':'answers','done':len(state['answers']),'seconds':round(time.monotonic()-start,2)}),flush=True)
 print(json.dumps({'stage':'done','memories':len(docs),'questions':len(state['answers'])}),flush=True)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--allow-real-llm',action='store_true');p.add_argument('--user-id',required=True);p.add_argument('--dataset',required=True);p.add_argument('--output',required=True);a=p.parse_args()
 if not a.allow_real_llm:p.error('必须显式允许真实模型')
 logging.disable(logging.CRITICAL)
 asyncio.run(main(a))

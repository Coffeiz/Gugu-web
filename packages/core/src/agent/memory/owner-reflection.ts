import type { Json } from '../models.js'

type Row=Record<string,Json>
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v)
const text=(v:unknown)=>typeof v==='string'?v.trim():''
const list=(v:unknown):Json[]=>Array.isArray(v)?v:[]
const norm=(v:unknown)=>Array.from(text(v).replace(/^-+/u,'').trim().toLowerCase()).filter(c=>/[\p{L}\p{N}]/u.test(c)).join('')
const grams=(v:unknown)=>{const chars=Array.from(norm(v));return new Set(chars.length<2?[chars.join('')]:chars.slice(0,-1).map((c,i)=>c+chars[i+1]))}
function similar(a:unknown,b:unknown,threshold=.7):boolean{
  const na=norm(a),nb=norm(b);if(!na||!nb)return false;if(na===nb)return true
  const short=Array.from(na).length<=Array.from(nb).length?na:nb,long=short===na?nb:na
  if(Array.from(short).length>=6&&long.includes(short))return true
  const ga=grams(a),gb=grams(b),union=new Set([...ga,...gb]);return [...ga].filter(x=>gb.has(x)).length/union.size>=threshold
}
const types=new Set(['name','address','pronoun','background','preference','note'])
function lensSimilar(a:unknown,b:unknown):boolean{
  if(norm(a)===norm(b))return !!norm(a)
  const trigger=(v:unknown)=>norm(/「([^」]+)」/u.exec(text(v))?.[1]??''),ta=trigger(a),tb=trigger(b)
  if(ta&&tb){const short=Array.from(ta).length<=Array.from(tb).length?ta:tb,long=short===ta?tb:ta
    return ta===tb||Array.from(short).length>=2&&long.includes(short)}
  return similar(a,b,.5)
}
const number=(v:unknown,fallback:number)=>typeof v==='number'&&Number.isFinite(v)?v:fallback
/** Python owner reflection增量规则；仅纯数据，Host负责授权、墓碑、文件CAS与重试幂等。 */
export function applyOwnerReflectionOutput(input:{current:Readonly<Record<string,Json>>;output:Json;now:number;date:string;nextId():string}):Record<string,Json>{
  if(!Number.isFinite(input.now)||!/^\d{4}-\d{2}-\d{2}$/u.test(input.date)||!object(input.output))throw new Error('反思记忆增量无效')
  const current=structuredClone(input.current),out=input.output,result:Record<string,Json>={}
  const profile=list(current.profile).flatMap(raw=>{const item=typeof raw==='string'?{text:raw,type:'note'}:object(raw)?raw:null
    if(!item||!text(item.text))return[];return[{text:text(item.text),type:types.has(text(item.type))?text(item.type):'note',ts:item.ts??null}]})
  const removed=list(out.profile_remove).map(raw=>text(object(raw)?raw.text:raw)).filter(Boolean),staged:string[]=[]
  let profiles:Row[]=profile.filter(item=>!removed.some(value=>similar(item.text,value)))
  for(const raw of list(out.profile_add)){
    const item=typeof raw==='string'?{text:raw,type:'note'}:object(raw)?raw:null;if(!item||!text(item.text))continue
    const body=text(item.text),kind=types.has(text(item.type))?text(item.type):'note'
    if(/最近|刚|这阵子|这几天|这周|本周|目前|现在|近期/u.test(body)){staged.push(body);continue}
    const hit=profiles.find(row=>similar(row.text,body));if(hit){hit.ts=input.now;hit.type=kind;if(Array.from(body).length>Array.from(String(hit.text)).length)hit.text=body}
    else profiles.push({type:kind,text:body,ts:input.now})
  }
  if(out.profile_add!==undefined||out.profile_remove!==undefined)result.profile=profiles
  let patterns:Row[]=list(current.pattern).filter(object).filter(p=>text(p.text))
  const removals=list(out.pattern_remove).map(raw=>text(object(raw)?raw.text:raw)).filter(Boolean)
  patterns=patterns.filter(p=>!removals.some(value=>similar(p.text,value)))
  const additions=out.pattern_add!==undefined?list(out.pattern_add):list(out.facts)
  for(const raw of additions){const item=object(raw)?raw:{text:text(raw)},body=text(item.text);if(!body)continue
    const kind=item.kind==='observed'?'observed':'inferred',importance=Math.trunc(number(item.importance,3)),hit=patterns.find(p=>similar(p.text,body))
    if(hit){hit.conf=Math.min(.97,number(hit.conf,.6)+.1);hit.ts=input.now;if(kind==='observed')hit.kind=kind
      if(Array.from(body).length>Array.from(String(hit.text)).length)hit.text=body;if(item.importance)hit.imp=importance}
    else patterns.push({id:input.nextId(),text:body,kind,conf:kind==='observed'?.9:.6,imp:importance,ts:input.now})
  }
  if(out.pattern_add!==undefined||out.pattern_remove!==undefined||out.facts!==undefined)result.pattern=patterns
  if(text(out.summary))result.summary={text:text(out.summary),ts:input.now}
  let daily=text(out.daily);const stagedNew=staged.filter(value=>!daily.includes(value));if(stagedNew.length)daily=[daily,...stagedNew].filter(Boolean).join('；')
  if(daily){const old=typeof current.daily==='string'?current.daily:'',heading=`## ${input.date}`
    result.daily=old.trimStart().startsWith(heading)?`${heading}\n- ${daily}\n${old.trimStart().slice(heading.length).trimStart()}`:`${heading}\n- ${daily}\n${old.trim()?`\n${old.trim()}\n`:''}`}
  const perception=object(out.perception)?out.perception:{}
  if(text(perception.intent))result.stance={stance:text(perception.intent),ts:input.now}
  const lens=object(current.lens)?current.lens:{},rules=list(lens.rules).filter(object).filter(r=>number(r.confidence,0)*.5**(Math.max(0,input.now-number(r.last_seen,input.now))/86400/30)>=.25)
  const candidates=list(lens.candidates).filter(object).filter(c=>(input.now-number(c.last_seen,input.now))/86400<=21),hint=text(out.lens_hint)
  if(hint&&Array.from(norm(hint)).length>=4){
    const hit=rules.find(r=>lensSimilar(r.rule,hint)),candidate=candidates.find(c=>lensSimilar(c.rule,hint))
    if(hit){hit.confidence=Math.min(.95,number(hit.confidence,.6)+.1);hit.last_seen=input.now;hit.hits=number(hit.hits,0)+1}
    else if(candidate){candidate.count=number(candidate.count,1)+1;candidate.last_seen=input.now
      if(Number(candidate.count)>=2){candidates.splice(candidates.indexOf(candidate),1);rules.push({rule:text(candidate.rule)||hint,confidence:.6,last_seen:input.now,hits:1})}}
    else candidates.push({rule:hint,count:1,last_seen:input.now})
  }
  rules.sort((a,b)=>number(b.confidence,0)*.5**(Math.max(0,input.now-number(b.last_seen,input.now))/86400/30)-number(a.confidence,0)*.5**(Math.max(0,input.now-number(a.last_seen,input.now))/86400/30))
  if(current.lens!==undefined||hint)result.lens={rules:rules.slice(0,12),candidates}
  return result
}

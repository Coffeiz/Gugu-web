import type { AttentionMessage, AttentionSnapshot } from './types.js'
import { normalizeAttentionText } from './normalization.js'
import { visibleAttentionUnits } from './visible-units.js'

const unitLimit = 64
const grammarChars = new Set(Array.from('我你您他她它咱俺吾们人谁各众全群这那此该其某哪啥个些种样事物前后上下里外内旁边左右什么怎何为几多少否可能是还或与吗呢吧啊呀哦嘛请帮替给让使叫快先再试务必不没无别勿莫非未要想愿会应得需肯敢了过着正在已曾将刚又起来去的地得把被对向跟同但而就才因所既并及如咋'))
const points = (value: string) => Array.from(value)

export function attentionDecay(age: number): number {
  if (age < 0 || age >= 600) return 0
  const end = 2 ** (-600 / 360)
  return Math.max(0, Math.min(1, (2 ** (-age / 360) - end) / (1 - end)))
}

export function hasValidTopicAnchor(message: AttentionMessage, snapshot: AttentionSnapshot): boolean {
  const anchor = snapshot.latestAcceptedFinal
  if (!snapshot.complete || !anchor?.accepted || !anchor.finalText) return false
  const age = (message.eventReceivedMs - anchor.sentAtMs) / 1000
  return age >= 0 && age < 600
}

function commonSubstring(a: string[], b: string[]): number {
  let prev = new Array(b.length + 1).fill(0), best = 0
  for (const char of a) {
    const row = new Array(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) if (char === b[j - 1]) { row[j] = prev[j - 1] + 1; best = Math.max(best, row[j]) }
    prev = row
  }
  return best
}

export function topicCpSimilarity(current: string, candidate: string): [number, number, number] {
  const a = points(normalizeAttentionText(current)), b = points(normalizeAttentionText(candidate))
  if (!a.length || !b.length) return [0, 0, 0]
  const left = a.join(''), right = b.join('')
  if (left.includes(right)) { const coverage = b.length / a.length; return [.5 * coverage + .5 * (1 - Math.exp(-Math.max(0, b.length - 3) / 4)), coverage, b.length] }
  if (/^[\x00-\x7f]+$/u.test(left) && /^[\x00-\x7f]+$/u.test(right) && ![...left].some(char => right.includes(char))) return [0, 0, 0]
  const common = sequenceMatchSize(a, b), longest = commonSubstring(a, b)
  return [.5 * common / a.length + .5 * (1 - Math.exp(-Math.max(0, longest - 3) / 4)), common / a.length, longest]
}

function longestMatch(a: string[], a0: number, a1: number, b: string[], b0: number, b1: number): [number, number, number] {
  let bestI=a0,bestJ=b0,bestSize=0, previous=new Map<number,number>()
  for(let i=a0;i<a1;i++){
    const current=new Map<number,number>()
    for(let j=b0;j<b1;j++)if(a[i]===b[j]){
      const size=(previous.get(j-1)??0)+1;current.set(j,size)
      if(size>bestSize){bestI=i-size+1;bestJ=j-size+1;bestSize=size}
    }
    previous=current
  }
  return [bestI,bestJ,bestSize]
}

/** Python SequenceMatcher(autojunk=False) 的 matching-block 长度和。 */
function sequenceMatchSize(a:string[],b:string[]):number {
  const queue:Array<[number,number,number,number]>=[[0,a.length,0,b.length]],blocks:Array<[number,number,number]>=[]
  while(queue.length){const [a0,a1,b0,b1]=queue.pop()!,[i,j,size]=longestMatch(a,a0,a1,b,b0,b1);if(size){blocks.push([i,j,size]);if(a0<i&&b0<j)queue.push([a0,i,b0,j]);if(i+size<a1&&j+size<b1)queue.push([i+size,a1,j+size,b1])}}
  return blocks.reduce((sum,item)=>sum+item[2],0)
}

function levenshtein(left:string[],right:string[]):number {
 if(left.length<right.length)[left,right]=[right,left]
 let previous=Array.from({length:right.length+1},(_,i)=>i)
 for(let i=1;i<=left.length;i++){const current=[i];for(let j=1;j<=right.length;j++)current.push(Math.min(current[j-1]!+1,previous[j]!+1,previous[j-1]!+Number(left[i-1]!==right[j-1])));previous=current}
 return previous.at(-1)!
}

function effectiveEditText(value:string[]):string[] {const result=[...value];while(result.length&&['啊','呀','呢','吧'].includes(result.at(-1)!))result.pop();return result.length?result:value}

export function topicEditSimilarity(current:string,candidate:string):[number,[number,number]|null] {
 const left=points(normalizeAttentionText(current)),right=points(normalizeAttentionText(candidate))
 if(!left.length||!right.length||left.join('').includes(right.join(''))||right.join('').includes(left.join('')))return [0,null]
 const effective=effectiveEditText(left);if(!effective.length)return [0,null]
 const ngrams=new Map<string,number[]>();for(let j=0;j<right.length-1;j++){const key=right.slice(j,j+2).join(''),list=ngrams.get(key)??[];list.push(j);ngrams.set(key,list)}
 const anchors:Array<[number,number]>=[]
 for(let i=0;i<left.length-1;i++){const matches=ngrams.get(left.slice(i,i+2).join(''));if(!matches?.length)continue;const count=Math.min(3,matches.length),sampled=new Set<number>();for(let k=0;k<count;k++)sampled.add(matches[Math.round(k*(matches.length-1)/Math.max(1,count-1))]!);for(const j of [...sampled].sort((a,b)=>a-b))anchors.push([i,j]);if(anchors.length>=24)break}
 const pairs=new Set<string>()
 for(const [i,j] of anchors){for(let length=3;length<=12;length++){if(length/Math.max(1,effective.length)<.5)continue;for(let other=Math.max(3,length-2);other<=Math.min(12,length+2);other++){
  for(let ls=Math.max(0,i-length+2);ls<=Math.min(i,left.length-length);ls++)for(let rs=Math.max(0,j-other+2);rs<=Math.min(j,right.length-other);rs++){pairs.add(`${ls},${ls+length},${rs},${rs+other}`);if(pairs.size>=256)break}
  if(pairs.size>=256)break
 }if(pairs.size>=256)break}if(pairs.size>=256)break}
 let best=0,bestLengths:[number,number]|null=null
 for(const tuple of [...pairs].map(x=>x.split(',').map(Number) as [number,number,number,number]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]||a[3]-b[3])){
  const [ls,le,rs,re]=tuple,a=left.slice(ls,le),b=right.slice(rs,re),distance=levenshtein(a,b),max=Math.max(a.length,b.length)
  if(distance<1||distance>2||max>12)continue
  const aa=a.join(''),bb=b.join('');if(aa.includes(bb)||bb.includes(aa)||aa.startsWith(bb)||bb.startsWith(aa)||aa.endsWith(bb)||bb.endsWith(aa))continue
  const common=new Set(a.filter(char=>b.includes(char)));if(common.size&&[...common].every(char=>grammarChars.has(char)))continue
  const score=1-distance/max;if(score>best){best=score;bestLengths=[a.length,b.length]}
 }
 return [best,bestLengths]
}

function pairRank(current:string,candidate:string):[number,number]{const a=new Set(Array.from({length:Math.max(0,Array.from(current).length-1)},(_,i)=>Array.from(current).slice(i,i+2).join(''))),b=new Set(Array.from({length:Math.max(0,Array.from(candidate).length-1)},(_,i)=>Array.from(candidate).slice(i,i+2).join('')));return [[...a].filter(item=>b.has(item)).length,[...new Set(Array.from(current))].filter(item=>candidate.includes(item)).length]}

export function attentionTopicUnits(text: string): string[] {
  const all = visibleAttentionUnits(text).units.flatMap(unit => {
    const chars = points(normalizeAttentionText(unit.text)), chunks: string[] = []
    for (let i=0;i<chars.length;i+=unitLimit) chunks.push(chars.slice(i,i+unitLimit).join(''))
    return chunks
  })
  if (all.length <= 4) return all
  return [...new Set(Array.from({length:4},(_,i)=>Math.round(i*(all.length-1)/3)))].sort((a,b)=>a-b).map(i=>all[i]!)
}

export function attentionTopicEvidence(message: AttentionMessage, snapshot: AttentionSnapshot): [number, number, string | null, [number, number] | null] {
  const anchor=snapshot.latestAcceptedFinal
  if(!hasValidTopicAnchor(message,snapshot)||!anchor) return [0,0,null,null]
  const age=(message.eventReceivedMs-anchor.sentAtMs)/1000,decay=attentionDecay(age)
  if(!decay) return [0,0,null,null]
  const timeline=new Map<string,AttentionMessage>()
  for(const item of snapshot.messages) if(item.platform===message.platform&&item.botId===message.botId&&item.groupId===message.groupId&&item.eventId!==message.eventId&&item.senderIsBot!==true&&item.eventReceivedMs<message.eventReceivedMs) timeline.set(item.eventId,item)
  let anchorMessage: AttentionMessage | undefined
  for(const fact of snapshot.acceptedOutboundFacts?.length?snapshot.acceptedOutboundFacts:[anchor]) {
    if(!fact.accepted||!fact.finalText||fact.sentAtMs>message.eventReceivedMs) continue
    const id=fact.deliveryId||fact.platformMessageId||('outbound-'+fact.sentAtMs)
    const item:AttentionMessage={eventId:id,platform:message.platform,botId:message.botId,groupId:message.groupId,platformMessageId:fact.platformMessageId||null,senderId:null,eventReceivedMs:fact.sentAtMs,platformSentMs:fact.sentAtMs,rawText:fact.finalText,mediaOnly:false,mediaKinds:[],processableMedia:null,mentionedCurrentBot:false,mentionedOtherBot:false,mentionedOtherMember:false,hasUnresolvedMention:false,replyToPlatformMessageId:null,replyTargetSenderId:null,replyTargetIsBot:null,quoteText:null,senderIsBot:true,candidateText:fact.finalText}
    timeline.set(id,item); if(fact.deliveryId===anchor.deliveryId||fact.platformMessageId===anchor.platformMessageId) anchorMessage=item
  }
  if(!anchorMessage)return [0,0,null,null]
  const ordered=[...timeline.values()].sort((a,b)=>a.eventReceivedMs-b.eventReceivedMs||a.eventId.localeCompare(b.eventId)),index=ordered.findIndex(x=>x.eventId===anchorMessage!.eventId)
  if(index<0)return [0,0,null,null]
  const candidates=[...ordered.slice(Math.max(0,index-5),index),anchorMessage,...ordered.slice(index+1,index+6)],current=attentionTopicUnits(message.candidateText||message.rawText)
  let best=0,id:string|null=null,lengths:[number,number]|null=null
  for(const candidate of candidates){const candidateUnits=attentionTopicUnits(candidate.candidateText||candidate.rawText)
    const pairs=current.flatMap((a,ci)=>candidateUnits.map((b,bi)=>({a,b,ci,bi,rank:pairRank(a,b)})))
      .sort((x,y)=>y.rank[0]-x.rank[0]||y.rank[1]-x.rank[1]||x.ci-y.ci||x.bi-y.bi).slice(0,4)
    for(const pair of pairs){const [cp]=topicCpSimilarity(pair.a,pair.b),[edit,editLengths]=topicEditSimilarity(pair.a,pair.b),score=Math.max(cp,edit);if(score>best){best=score;id=candidate.eventId;lengths=score===edit?editLengths:null}}
  }
  return [best*decay**.25,best,id,lengths]
}

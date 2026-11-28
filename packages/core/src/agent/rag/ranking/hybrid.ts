/** 旧版先取词法候选，再以余弦和 RRF 对命中候选融合；不扩展授权范围。 */
export function hybridFuseScores(
 hits:readonly {chunk_id:string}[],queryVector:readonly number[],vectors:ReadonlyMap<string,readonly number[]>,
 lexicalWeight=0.45,vectorWeight=0.55,rrfK=60,
) {
 const vectorScores=new Map<string,number>()
 for(const hit of hits){
  const vector=vectors.get(hit.chunk_id)
  if(!vector?.length)continue
  if(vector.length!==queryVector.length){vectorScores.set(hit.chunk_id,0);continue}
  let dot=0,queryNorm=0,vectorNorm=0
  for(let i=0;i<queryVector.length;i++){
   const a=queryVector[i]!,b=vector[i]!
   dot+=a*b;queryNorm+=a*a;vectorNorm+=b*b
  }
  vectorScores.set(hit.chunk_id,queryNorm===0||vectorNorm===0?0:dot/(Math.sqrt(queryNorm)*Math.sqrt(vectorNorm)))
 }
 const fusedScores=new Map<string,number>()
 if(!vectorScores.size)return {fusedScores,vectorScores}
 const ranked=[...vectorScores.keys()].sort((a,b)=>vectorScores.get(b)!-vectorScores.get(a)!||(a<b?-1:a>b?1:0))
 const ranks=new Map(ranked.map((id,index)=>[id,index+1]))
 const rrf=(rank:number,weight:number)=>weight*((rrfK+1)/(rrfK+Math.max(1,rank)))
 for(const [index,hit] of hits.entries()){
  const vectorRank=ranks.get(hit.chunk_id)
  fusedScores.set(hit.chunk_id,rrf(index+1,lexicalWeight)+(vectorRank===undefined?0:rrf(vectorRank,vectorWeight)))
 }
 return {fusedScores,vectorScores}
}

import { openLocalFile } from '@gugu/fs/node'
import { normalizeOwnerId } from '../../../adapters/owner-context.js'

const vectorFiles = {
 memory: '.agent/memory_vec.json',
 knowledge: '.agent/knowledge/vectors.json',
 pattern: '.agent/pattern_vec.json',
} as const
const maxCharacters = 50_000_000

/** 由可信 Host 绑定存储根与 owner，模型不得控制两者。 */
export function createOwnerRagVectorSource(root:string,ownerId:string) {
 const owner=normalizeOwnerId(ownerId)
 return async (kind:keyof typeof vectorFiles,signal?:AbortSignal):Promise<string|null>=>{
  signal?.throwIfAborted()
  if(!Object.hasOwn(vectorFiles,kind))throw new Error('RAG 向量来源无效')
  const file=await openLocalFile(root,`${owner}/${vectorFiles[kind]}`)
  if(!file)return null
  try{
   if(file.size>maxCharacters*4)throw new Error('RAG 向量文件过大')
   const value=await file.handle.readFile({encoding:'utf8',signal})
   signal?.throwIfAborted()
   if(value.length>maxCharacters)throw new Error('RAG 向量文件过大')
   return value
  }finally{await file.handle.close()}
 }
}

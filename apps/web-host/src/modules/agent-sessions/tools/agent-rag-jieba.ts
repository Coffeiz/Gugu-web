import { Jieba } from '@node-rs/jieba'
import { dict } from '@node-rs/jieba/dict.js'
import type { RagJieba } from '@gugu/core/agent/rag'

let instance: RagJieba | undefined

/** 与 1.7.7 相同，使用包内词典并固定 HMM=false。 */
export function getAgentRagJieba(): RagJieba {
  instance ??= Jieba.withDict(dict)
  return instance
}

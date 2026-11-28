import type { JsonObject } from '../contracts.js'

export const qwenResponsesSearchSchema: JsonObject = {
  "type": "object",
  "properties": {
    "input": {
      "type": "string",
      "minLength": 1,
      "description": "需要联网检索的问题。"
    },
    "max_output_tokens": {
      "type": "integer",
      "minimum": 1,
      "maximum": 2048,
      "default": 1200,
      "description": "限制本次搜索回答的输出 token 数。"
    }
  },
  "required": [
    "input"
  ],
  "additionalProperties": false
}

import type { JsonObject } from '../contracts.js'

export const minimaxSearchSchema: JsonObject = {
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "description": "搜索查询。"
    }
  },
  "required": [
    "query"
  ],
  "additionalProperties": false
}

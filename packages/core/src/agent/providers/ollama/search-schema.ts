import type { JsonObject } from '../contracts.js'

export const ollamaSearchSchema: JsonObject = {
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "description": "搜索查询。"
    },
    "max_results": {
      "type": "integer",
      "minimum": 1,
      "maximum": 10,
      "default": 5
    }
  },
  "required": [
    "query"
  ],
  "additionalProperties": false
}

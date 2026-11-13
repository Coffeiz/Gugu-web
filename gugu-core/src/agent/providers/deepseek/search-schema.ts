import type { JsonObject } from '../contracts.js'

export const deepseekSearchSchema: JsonObject = {
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "pattern": "\\S",
      "description": "搜索词，支持 site:、lang:、after:、before: 等搜索语法。"
    },
    "count": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "default": 10
    },
    "ori_question": {
      "type": [
        "string",
        "null"
      ],
      "minLength": 1,
      "maxLength": 128,
      "description": "可选原始问题，用于理解搜索意图。"
    },
    "localization": {
      "type": "string",
      "description": "用于优先返回本地化搜索结果的 IP 地址，默认空字符串。"
    },
    "need_content": {
      "type": "boolean",
      "default": false,
      "description": "是否返回网页正文。"
    }
  },
  "required": [
    "query"
  ],
  "additionalProperties": false
}

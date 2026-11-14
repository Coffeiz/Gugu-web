import type { JsonObject } from '../contracts.js'

export const qwenChatSearchSchema: JsonObject = {
  "type": "object",
  "properties": {
    "messages": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "properties": {
          "role": {
            "type": "string",
            "enum": [
              "system",
              "user",
              "assistant"
            ]
          },
          "content": {
            "type": "string"
          }
        },
        "required": [
          "role",
          "content"
        ],
        "additionalProperties": false
      },
      "description": "百炼搜索请求的文本消息，包含要检索的问题。"
    },
    "search_options": {
      "type": "object",
      "properties": {
        "forced_search": {
          "type": "boolean",
          "default": true
        },
        "search_strategy": {
          "type": "string",
          "description": "百炼检索策略，需符合所选模型支持范围。"
        }
      },
      "additionalProperties": false
    }
  },
  "required": [
    "messages"
  ],
  "additionalProperties": false
}

import type { JsonObject } from '../contracts.js'

export const mimoSearchSchema: JsonObject = {
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
      }
    },
    "tools": {
      "type": "array",
      "minItems": 1,
      "maxItems": 1,
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "web_search"
            ]
          },
          "max_keyword": {
            "type": "integer",
            "minimum": 1,
            "description": "每轮最大搜索关键词数量，影响调用次数和费用。"
          },
          "force_search": {
            "type": "boolean",
            "description": "是否强制联网搜索。"
          },
          "limit": {
            "type": "integer",
            "minimum": 1
          },
          "user_location": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "approximate"
                ]
              },
              "country": {
                "type": "string"
              },
              "region": {
                "type": "string"
              },
              "city": {
                "type": "string"
              }
            },
            "required": [
              "type"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "type"
        ],
        "additionalProperties": false
      }
    },
    "max_completion_tokens": {
      "type": "integer",
      "minimum": 1,
      "maximum": 2048,
      "default": 1024
    }
  },
  "required": [
    "messages",
    "tools"
  ],
  "additionalProperties": false
}

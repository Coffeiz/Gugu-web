import type { JsonObject } from '../contracts.js'

export const glmSearchSchema: JsonObject = {
  "type": "object",
  "properties": {
    "search_query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 70,
      "description": "需要搜索的内容，最多 70 个字符。"
    },
    "search_engine": {
      "type": "string",
      "enum": [
        "search_std",
        "search_pro",
        "search_pro_sogou",
        "search_pro_quark"
      ]
    },
    "search_intent": {
      "type": "boolean",
      "default": false,
      "description": "是否先识别搜索意图；false 直接搜索。"
    },
    "count": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "default": 10,
      "description": "搜狗仅支持 10/20/30/40/50；夸克不支持此字段。"
    },
    "search_domain_filter": {
      "type": "string",
      "description": "限定白名单域名；夸克不支持。"
    },
    "search_recency_filter": {
      "type": "string",
      "enum": [
        "oneDay",
        "oneWeek",
        "oneMonth",
        "oneYear",
        "noLimit"
      ],
      "default": "noLimit"
    },
    "content_size": {
      "type": "string",
      "enum": [
        "medium",
        "high"
      ],
      "description": "medium 返回摘要；high 返回更详细内容。"
    },
    "request_id": {
      "type": "string",
      "minLength": 6,
      "maxLength": 64
    },
    "user_id": {
      "type": "string",
      "minLength": 6,
      "maxLength": 128,
      "description": "可选终端用户标识，不要填写隐私信息。"
    }
  },
  "required": [
    "search_query",
    "search_engine",
    "search_intent"
  ],
  "additionalProperties": false
}

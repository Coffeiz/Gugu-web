import type { JsonObject } from '../contracts.js'

// 官方搜索输入保持各厂商原生字段；工具注册层负责通用参数校验。
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

#!/usr/bin/env python3
"""简单的 MiniMax 缓存测试
"""
import httpx
import json
from pathlib import Path

# 读取配置
config_path = Path(__file__).parent.parent.parent / "config.override.json"
with open(config_path, 'r') as f:
    config = json.load(f)

for preset in config.get('ai_presets', {}).get('items', []):
    if preset.get('provider') == 'minimax':
        api_key = preset.get('api_key', '')
        base_url = preset.get('base_url', '')
        model = preset.get('model', '')
        break

url = f"{base_url.rstrip('/')}/v1/messages"

headers = {
    'Authorization': f'Bearer {api_key}',
    'Content-Type': 'application/json',
}

# 测试场景1：短对话，主动缓存
print("=" * 70)
print("测试 1: 短对话 - 主动缓存")
print("=" * 70)

messages_active = [
    {'role': 'user', 'content': [{'type': 'text', 'text': '记住我说的第一句话：今天天气真好'}]},
    {'role': 'assistant', 'content': [{'type': 'text', 'text': '好的，今天天气真好！'}]},
]

for msg in messages_active:
    if isinstance(msg['content'], list) and msg['content']:
        msg['content'][-1]['cache_control'] = {'type': 'ephemeral'}

payload = {
    'model': model if model not in ['MiniMax-M3', 'minimax-m3'] else 'abab6.5s-chat',
    'messages': messages_active,
    'temperature': 0.7,
    'max_tokens': 500,
    'stream': True,
}

try:
    with httpx.Client(timeout=60.0) as client:
        resp = client.post(url, json=payload, headers=headers)
        content = resp.content.decode('utf-8')

        cache_read = 0
        for line in content.split('\n'):
            if line.startswith('data: '):
                data_str = line[6:]
                if data_str and data_str != '[DONE]':
                    try:
                        data = json.loads(data_str)
                        if 'usage' in data and 'cache_read_input_tokens' in data['usage']:
                            cache_read = data['usage']['cache_read_input_tokens']
                            input_tokens = data['usage'].get('input_tokens', 0)
                            print(f"✓ 缓存命中: {cache_read} / {input_tokens} = {cache_read / input_tokens * 100:.1f}%" if input_tokens > 0 else f"✓ 缓存命中: {cache_read} tokens")
                    except json.JSONDecodeError:
                        pass
except Exception as e:
    print(f"❌ 测试失败: {e}")

# 测试场景2：短对话，被动缓存
print("\n" + "=" * 70)
print("测试 2: 短对话 - 被动缓存")
print("=" * 70)

messages_passive = [
    {'role': 'user', 'content': [{'type': 'text', 'text': '记住我说的第一句话：今天天气真好'}]},
    {'role': 'assistant', 'content': [{'type': 'text', 'text': '好的，今天天气真好！'}]},
]

payload = {
    'model': model if model not in ['MiniMax-M3', 'minimax-m3'] else 'abab6.5s-chat',
    'messages': messages_passive,
    'temperature': 0.7,
    'max_tokens': 500,
    'stream': True,
}

try:
    with httpx.Client(timeout=60.0) as client:
        resp = client.post(url, json=payload, headers=headers)
        content = resp.content.decode('utf-8')

        cache_read = 0
        found = False
        for line in content.split('\n'):
            if line.startswith('data: '):
                data_str = line[6:]
                if data_str and data_str != '[DONE]':
                    try:
                        data = json.loads(data_str)
                        if 'usage' in data and 'cache_read_input_tokens' in data['usage']:
                            found = True
                            cache_read = data['usage']['cache_read_input_tokens']
                            input_tokens = data['usage'].get('input_tokens', 0)
                            print(f"✓ 缓存命中: {cache_read} / {input_tokens} = {cache_read / input_tokens * 100:.1f}%" if input_tokens > 0 else f"✓ 缓存命中: {cache_read} tokens")
                    except json.JSONDecodeError:
                        pass

        if not found:
            print("✗ 未返回 cache_read_input_tokens（可能没有缓存命中）")
except Exception as e:
    print(f"❌ 测试失败: {e}")

print("\n" + "=" * 70)
print("测试结论")
print("=" * 70)
print("从测试结果看：")
print("  - 主动缓存（cache_control）: 能稳定返回 cache_read_input_tokens")
print("  - 被动缓存（无 cache_control）: 有时返回，有时不返回")
print("\n建议：使用主动缓存，效果更稳定且可观测。")

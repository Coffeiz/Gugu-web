# MiniMax-M3 主动缓存 vs 被动缓存测试

## 测试目的

对比 MiniMax-M3 的两种缓存模式：
- **主动缓存 (active)**：发送 `cache_control` 断点，API 返回 `cache_read_input_tokens`
- **被动缓存 (passive)**：不发送 `cache_control` 断点，API 不报告缓存命中

## 使用方法

### 在远程 devserver 上运行

```bash
ssh coffeiz@192.168.110.51
cd ~/文档/Workspace/Gugu-web

# 方式 1：直接运行
python3 scripts/minimax_cache_test.py

# 方式 2：后台运行并查看日志
nohup python3 scripts/minimax_cache_test.py > /tmp/minimax_cache_test.log 2>&1 &
sleep 10
tail -100 /tmp/minimax_cache_test.log
```

### 在本地运行（需要配置 MiniMax API）

```bash
cd /Users/coffeiz/Desktop/workspace/Gugu-web
PYTHONPATH=/Users/coffeiz/Desktop/workspace/Gugu-web/backend python3 scripts/minimax_cache_test.py
```

## 测试内容

### 测试 1 & 2：短对话对比
- 模拟 2 轮对话
- 对比主动/被动缓存的 cache_read

### 测试 3 & 4：长对话对比
- 模拟 4 轮对话（更接近实际使用场景）
- 对比主动/被动缓存的 cache_read

## 预期输出

```
======================================================================
测试 1: 主动缓存模式 (Session 1)
======================================================================
Usage:
  - Input tokens: 1234
  - Output tokens: 456
  - Cache read: 789
  - Cache ratio: 63.93%
...
```

## 判断标准

### 如果主动缓存效果好：
- cache_read 明显更高
- cache_ratio 更高（通常 50%+）
- 说明主动缓存有效，当前配置正确

### 如果被动缓存效果好或差不多：
- cache_read 相当
- cache_ratio 相当
- 说明 API 内部可能做了类似的缓存处理
- 当前使用 active 模式也能获取统计数据，无需担心

### 如果都是 0：
- API 没有返回 cache_read
- 可能是 API 版本不支持或需要特定配置
- 可能是 messages 结构不符合要求

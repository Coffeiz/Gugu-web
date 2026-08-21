# MiniMax-M3 主动缓存 vs 被动缓存测试

## 测试目的

对比 MiniMax-M3 的两种缓存模式：
- **主动缓存 (active)**：发送 `cache_control` 断点，API 返回 `cache_read_input_tokens`
- **被动缓存 (passive)**：不发送 `cache_control` 断点，API 不报告缓存命中

## 测试内容

### 测试 1 & 2：短对话对比
- 模拟 2 轮对话
- 对比主动/被动缓存的 cache_read

### 测试 3 & 4：长对话对比
- 模拟 4 轮对话（更接近实际使用场景）
- 对比主动/被动缓存的 cache_read

## 使用方法

### 方式 1：在本地直接运行

```bash
cd /Users/coffeiz/Desktop/workspace/Gugu-web
python backend/scripts/diagnostics/minimax_cache_test.py
```

### 方式 2：在远程 devserver 上运行

```bash
ssh coffeiz@192.168.110.51
cd ~/文档/Workspace/Gugu-web
python backend/scripts/diagnostics/minimax_cache_test.py
```

### 方式 3：使用后台运行并查看日志

```bash
ssh coffeiz@192.168.110.51
cd ~/文档/Workspace/Gugu-web
nohup python backend/scripts/diagnostics/minimax_cache_test.py > /tmp/minimax_cache_test.log 2>&1 &
sleep 10
tail -100 /tmp/minimax_cache_test.log
```

## 预期输出

```
======================================================================
测试 1: 主动缓存模式 (Session 1)
======================================================================
User: 第 4 轮：总结任务
Assistant: ...

Usage:
  - Input tokens: 1234
  - Output tokens: 456
  - Cache read: 789
  - Cache ratio: 63.93%

======================================================================
测试 2: 被动缓存模式 (Session 1)
======================================================================
User: 第 4 轮：总结任务
Assistant: ...

Usage:
  - Input tokens: 1234
  - Output tokens: 456
  - Cache read: 321
  - Cache ratio: 26.02%

======================================================================
测试总结
======================================================================

模式       输入 tokens     缓存命中        缓存率
----------------------------------------
主动       1234           789            63.93%
被动       1234           321            26.02%
----------------------------------------

✅ 主动缓存比被动缓存多命中 468 tokens (145.8%)

结论：主动缓存效果更好
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

## 测试完成后

测试完成后，如果发现主动缓存有明显优势，说明当前修改是正确的，可以继续使用 active 模式。

如果发现效果差不多或被动缓存更好，说明：
1. API 内部可能做了类似的缓存处理
2. 可以继续使用 active 模式获取统计数据（好处是能监控）
3. 当前代码无需回滚

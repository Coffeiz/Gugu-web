# 测试维护配置

## 新增测试元数据

新增测试文件必须在 `test-metadata.json` 增加同路径条目：

```json
{
  "frontend/test/example.test.ts": {
    "domain": "frontend-ui",
    "layer": "L0",
    "owner": "frontend/frontend-ui",
    "productionEntry": "被测模块或入口",
    "keyBehavior": "关键回归行为",
    "ci": "test:fast"
  }
}
```

`test:metadata` 只阻断真正新增的测试文件；改名或修改已有测试仍由自动清单维护，避免一次性改写全部旧文件。

## Skip 策略

`skip-policy.json` 中每个实际 skip 都必须有 owner、原因、替代验收路径和到期日期。月度维护入口会阻断缺失、失联或到期的 skip。

---
name: 天气
description_short: 用户询问天气、温度、降雨、风力或出行建议时使用。
description_long: "使用 Open-Meteo 查询全球城市的当前天气和未来预报。"
category: weather
related_tools: http_get
emoji: 🌤️
---

# 天气查询技能

使用 Open-Meteo 查询指定地点的当前天气和预报。天气数据来自数值天气模型，回复时只陈述接口实际返回的内容，不把预报说成确定事实。

## 适用范围

适用于：

- 当前天气、温度、体感温度、湿度、风力
- 今天、明天、后天或未来几天的天气
- 降雨概率和基础出行建议
- 全球城市天气查询

不适用于：

- 历史天气、气候分析或长期趋势
- 官方极端天气预警
- 空气质量、紫外线、潮汐等未请求的指标

## 执行流程

### 第一步：解析地点

用户只给城市名时，先用 `http_get` 请求地理编码接口：

```text
https://geocoding-api.open-meteo.com/v1/search?name=南京&count=5&language=zh&format=json
```

调用约定：

- 工具参数必须是 `{"url": "完整 URL"}`，不要发送 `curl` 命令。
- 优先选择名称精确、行政区和国家符合用户语境的结果。
- 同名城市无法判断时，列出简短候选并询问用户，不要猜经纬度。
- 地理编码结果中的 `latitude`、`longitude`、`name`、`country`、`admin1` 可用于下一步查询。
- 用户已经提供经纬度时跳过地理编码。

### 第二步：查询天气

当前天气使用：

```text
https://api.open-meteo.com/v1/forecast?latitude=32.0603&longitude=118.7969&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m&timezone=auto
```

未来预报使用：

```text
https://api.open-meteo.com/v1/forecast?latitude=32.0603&longitude=118.7969&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max&timezone=auto&forecast_days=3
```

请求规则：

- 使用地理编码返回的坐标替换示例坐标。
- 始终带 `timezone=auto`，按地点当地时间解释结果。
- 简单当前天气只请求 `current`，不要额外请求完整 hourly 数据。
- 用户问逐小时变化时，再请求 `hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m`。
- 用户问一周天气时设置 `forecast_days=7`；没有明确要求时默认 3 天。
- 同一次请求只取完成回答所需字段，避免返回过大的 JSON。

## 字段解释

常用字段：

- `temperature_2m`：当前气温
- `apparent_temperature`：体感温度
- `relative_humidity_2m`：相对湿度
- `wind_speed_10m`：当前风速
- `wind_speed_10m_max`：当天最大风速
- `precipitation_probability_max`：当天最高降水概率
- `temperature_2m_max` / `temperature_2m_min`：当天最高/最低温度
- `weather_code`：WMO 天气代码

WMO 天气代码转中文：

```text
0       晴
1       基本晴
2       局部多云
3       阴
45,48   雾
51-57   毛毛雨
61-67   雨
71-77   雪
80-82   阵雨
85-86   阵雪
95      雷暴
96,99   雷暴伴冰雹
```

如果代码不在列表中，使用“天气状况代码为 X”，不要自行编造天气描述。

## 输出格式

当前天气示例：

```text
南京现在：多云，26°C，体感 28°C。
湿度 78%，风速 10 km/h。
```

多日预报示例：

```text
南京未来 3 天：

今天：多云，24–30°C，降水概率 20%
明天：小雨，23–28°C，降水概率 65%
后天：阴，22–29°C，降水概率 35%
```

出行建议只能基于实际字段：

- 降水概率较高：建议带伞。
- 温度较高：提醒防晒和补水。
- 风速较高：提醒注意户外活动。
- 温度较低：提醒保暖。

不要在没有对应字段时推断空气质量、紫外线、台风预警或官方灾害预警。

## 错误处理

- 地理编码没有结果：请用户补充省份、国家或更完整的城市名。
- Open-Meteo 请求失败：最多重试一次，仍失败就说明暂时无法获取天气。
- 返回缺少某个字段：只输出实际获取到的字段。
- 不要切换回 wttr.in。
- 不要把 `web_search` 当作普通天气查询的替代方案。
- 不要为了修复解析问题反复更换参数或请求完整历史数据。
- 不要编造天气结果、天气预警或接口没有返回的数值。

## 数据来源

回复可以简短注明“数据来源：Open-Meteo”。数据采用 CC BY 4.0，需要保留适当归属说明。免费接口适用于当前低频、非商业场景；调用频率由服务方限制，避免循环请求。

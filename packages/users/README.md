# @gugu/users

负责用户资料、头像引用和账号状态。资料写入使用宿主认证后的用户 ID。头像文件由宿主的对象存储适配器管理，用户资料保存关联的存储引用。

当前公开入口是 `@gugu/users`。Web Host 已使用该入口处理资料字段。账号创建、停用和注销由 Web Host 的账号用例协调 Auth、Users 和资源清理能力。管理员接口按账号管理需求单独定义。

[Monorepo 账号架构与 API](../../docs/architecture/account-api.md)

## 已接入的 API

| 接口 | 契约 |
| --- | --- |
| `prepareProfilePatch(input, isValidTimezone)` | 规范化显示名和时区，保留订阅布尔值。省略字段保持原有值，时区无效时抛出 `InvalidProfileTimezoneError` |
| `profileTimezoneChanged(patch, currentTimezone)` | 比较规范化后的时区与事务内读取的当前值，供宿主判断是否刷新上下文 |
| `isAvatarMediaType(mediaType)`、`avatarFileExtension(mediaType)`、`AVATAR_MAX_BYTES` | 头像上传允许的媒体类型、扩展名及大小上限 |

Web Host 在开启事务前验证资料字段，在事务内读取当前时区并原子写入。凭据校验与改密归 Auth。

## 已接入的服务 API

| 接口 | 契约 |
| --- | --- |
| `getProfile(user)` | 将可信账号记录投影为公开资料 DTO，可复用认证时已经加载的数据 |
| `updateProfile(userId, input, ports)` | 提交资料更新，时区变更时通知宿主刷新上下文，再读取并返回最新资料。用户不存在时返回空值或传播存储端口的错误 |
| `setAvatar(userId, { mediaType, data }, upload)` | 校验头像格式和大小，调用宿主上传端口，返回更新后的资料 |

宿主从认证会话取得 `userId`。头像文件由宿主校验和存储，资料写入成功后再清理旧对象。能用于登录或找回密码的标识通过 Auth 的验证入口更新。

Web Host 已提供 `GET /api/v1/users/me` 和 `PATCH /api/v1/users/me`。读取返回现有账号资料 DTO，更新接受 `displayName`、`timezone` 和 `emailSubscribed`。设置页的资料更新已切到新入口。会话检查继续使用 `GET /api/v1/auth/me`。头像设置已使用 `PUT /api/v1/users/me/avatar`，接收 multipart 的 `file` 字段并返回更新后的资料。公开头像读取使用 `GET /api/v1/users/:user_id/avatar`。

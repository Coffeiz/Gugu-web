# Agent 安全控制方案


> **状态**：✅ 完成
> **分类**：技术实现
> **最后更新**：2026-06-17
> **关联文档**：[03-Agent架构设计](./03-Agent架构设计.md)

---

> 创建时间：2026-06-16
> 项目：gugugu.site

---

## 一、问题背景

### 1.1 潜在风险

```
用户让 Agent 执行危险操作：
  → 「帮我删掉服务器所有文件」
  → 「执行这个脚本」
  → 「ssh 到其他服务器」

Agent 可能造成的危害：
  → 数据删除
  → 数据泄露
  → 服务器被控制
  → 其他用户数据被访问
```

### 1.2 chroot 的局限性

```
chroot 只改根目录，存在逃逸风险：
├── 如果有 sudo → 可以逃逸
├── 如果有 ssh → 可以外部连接
├── 如果有写权限 → 可以修改环境
└── 脚本执行 → 风险取决于命令白名单
```

---

## 二、安全控制层级

| 层级 | 措施 | 防护目标 |
|------|------|---------|
| 1 | System Prompt 限制 | AI 层面禁止危险操作 |
| 2 | 命令白名单 | 执行层面过滤 |
| 3 | 权限控制 | 系统层面限制 |
| 4 | 沙箱隔离 | 资源层面隔离 |
| 5 | 二次确认 | 用户层面把关 |
| 6 | 审计日志 | 事后追溯 |

---

## 三、System Prompt 限制

```python
AGENT_RULES = """
## 禁止行为
- 绝对不能执行删除命令（rm, del, unlink）
- 不能执行格式化命令（format, mkfs）
- 不能执行危险脚本
- 不能 ssh/远程连接其他服务器
- 不能访问其他用户的数据
- 所有删除/覆盖操作必须经过用户确认

## 允许行为
- 查看文件（cat, ls, find）
- 读取配置
- 查询状态
"""

# 注入到 System Prompt
system_prompt = f"""
{AGENT_RULES}

## 当前用户上下文
{user_memory}
"""
```

---

## 四、命令白名单

### 4.1 安全命令列表

```python
# 只允许安全的命令
ALLOWED_COMMANDS = [
    # 文件查看
    'ls', 'pwd', 'cd', 'cat', 'head', 'tail',
    'wc', 'sort', 'uniq', 'grep', 'find', 'file',
    # 文件操作（限制）
    'mkdir', 'cp', 'mv',  # 禁止 rm
    # 文本处理
    'echo', 'printf', 'sed', 'awk',
    # 系统查询
    'ps', 'top', 'df', 'du', 'free', 'uname',
    'netstat', 'ss', 'ip', 'ifconfig',
    # 其他
    'date', 'cal', 'history',
]
```

### 4.2 危险命令黑名单

```python
FORBIDDEN_PATTERNS = [
    # 删除操作
    'rm -rf', 'rm -rf /', 'rm -rf /*',
    'del /f /s /q', 'rmdir',
    # 格式化/分区
    'mkfs', 'fdisk', 'parted', 'format',
    # 网络连接
    'ssh', 'scp', 'sftp', 'telnet',
    'wget', 'curl', 'nc', 'ncat',
    # 提权
    'sudo', 'su', 'chmod 777',
    # 系统控制
    'shutdown', 'reboot', 'halt', 'init',
    'kill -9', 'killall',
    # 危险操作
    'dd', 'mkfs', ':(){ :|:& };:',  # fork炸弹
    '> /dev/sd', 'cat /dev/sd',
    # 下载执行
    'curl | sh', 'wget | sh', 'bash <(curl',
]
```

### 4.3 命令校验函数

```python
import re

def is_command_safe(command: str) -> tuple[bool, str]:
    """检查命令是否安全"""
    
    # 检查黑名单
    for pattern in FORBIDDEN_PATTERNS:
        if pattern in command:
            return False, f"危险命令: {pattern}"
    
    # 检查是否在白名单
    first_word = command.strip().split()[0] if command.strip() else ""
    if first_word not in ALLOWED_COMMANDS:
        return False, f"命令不在白名单: {first_word}"
    
    return True, "允许"

def validate_input(user_input: str) -> bool:
    """验证用户输入"""
    # 防止注入
    dangerous_chars = [';', '&&', '||', '|', '`', '$(']
    for char in dangerous_chars:
        if char in user_input:
            return False
    return True
```

---

## 五、权限控制

### 5.1 SSH 权限限制

```bash
# 禁止 agent 用户 ssh 登录
echo "DenyUsers agent" >> /etc/ssh/sshd_config
systemctl restart sshd

# 或者
usermod -s /usr/sbin/nologin agent_user
```

### 5.2 限制 shell

```bash
# 使用受限 bash
usermod -s /bin/rbash agent_user

# 或创建白名单 shell
chsh -s /usr/local/bin/allowed_shell agent
```

### 5.3 取消 sudo

```bash
# 从 sudo 组移除
deluser agent sudo

# 确认
groups agent
# 不应该显示 sudo 组
```

### 5.4 只读挂载

```bash
# 用户目录只读挂载
mount --bind -o ro /storage/user_a /home/agent_a/workspace
```

### 5.5 用户命名空间隔离

```python
import subprocess

def create_user_namespace(user_id):
    """为用户创建独立的命名空间"""
    
    user_storage = f"/storage/{user_id}"
    
    subprocess.run([
        'unshare',
        '--user',              # 用户命名空间
        '--map-root-user',      # 映射 root
        '--mount',             # 挂载命名空间
        'bash', '-c',
        f'mount --bind {user_storage} /workspace && bash'
    ])
```

---

## 六、沙箱隔离

### 6.1 Docker 容器隔离（推荐）

```python
def get_user_container(user_id):
    """为每个用户创建隔离的 Docker 容器"""
    
    container_name = f"user_{user_id}_workspace"
    
    container = docker_client.containers.run(
        "workspace-image",
        name=container_name,
        user=f"{uid}:{gid}",
        volumes={
            f"/storage/{user_id}": {"bind": "/workspace", "mode": "rw"}
        },
        network_mode="none",      # 断网
        mem_limit="512m",         # 内存限制
        cpu_period=100000,
        cpu_quota=50000,          # 50% CPU
        read_only=True,           # 根目录只读
        tmpfs=["/tmp"],           # 临时文件在内存
        detach=True,
    )
    
    return container
```

```yaml
# docker-compose.yml 示例
services:
  agent:
    image: agent-workspace:latest
    user: "1000:1000"
    read_only: true
    tmpfs:
      - /tmp
    volumes:
      - ./storage/${USER_ID}:/workspace:ro
    network_mode: "none"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
```

### 6.2 文件路径隔离

```python
def safe_path(user_id: str, requested_path: str) -> str:
    """确保路径在用户目录内"""
    
    base_dir = f"/storage/{user_id}"
    real_path = os.path.realpath(requested_path)
    
    if not real_path.startswith(base_dir):
        raise PermissionError("越权访问：路径不在用户目录下")
    
    return real_path

def safe_file_operation(user_id: str, operation: str, path: str):
    """安全的文件操作"""
    
    safe_path = safe_path(user_id, path)
    
    # 危险操作检查
    if operation in ['delete', 'remove', 'unlink']:
        raise PermissionError("删除操作需要二次确认")
    
    # 执行操作
    return execute_operation(operation, safe_path)
```

---

## 七、危险操作二次确认

### 7.1 确认流程

```python
DANGEROUS_OPERATIONS = [
    'delete', 'remove', 'rm', 'unlink',
    'overwrite', 'replace', 'truncate',
    'execute', 'run_script', 'bash',
]

async def execute_with_confirmation(user_id: str, command: str):
    """执行命令前检查是否需要确认"""
    
    is_dangerous = check_dangerous(command)
    
    if is_dangerous:
        # 发送确认请求
        await bot.send(
            f"⚠️ 检测到危险操作，需要确认：\n\n"
            f"命令：{command}\n\n"
            f"回复「确认」执行\n"
            f"回复其他内容取消"
        )
        
        # 等待用户回复
        response = await wait_for_confirmation(user_id, timeout=60)
        
        if response.lower() != '确认':
            return {"status": "cancelled", "reason": "用户取消"}
    
    # 执行命令
    return await safe_execute(command)
```

### 7.2 确认消息模板

```
⚠️ 危险操作确认

命令：rm -rf /tmp/test_files
操作：删除文件
影响：3 个文件将被永久删除

风险说明：
  - 删除后无法恢复
  - 建议先备份重要文件

请回复「确认」执行此操作
回复其他内容将取消
```

---

## 八、权限分级

### 8.1 用户等级

```python
class UserLevel:
    READ_ONLY = 1      # 只读用户
    NORMAL = 2         # 普通用户
    TRUSTED = 3        # 信任用户（可执行脚本）
    ADMIN = 4          # 管理员

# 权限配置
PERMISSION_MAP = {
    UserLevel.READ_ONLY: {
        'allowed_commands': ['ls', 'cat', 'find', 'pwd'],
        'can_write': False,
        'can_delete': False,
        'can_execute': False,
    },
    UserLevel.NORMAL: {
        'allowed_commands': ['ls', 'cat', 'find', 'pwd', 'mkdir', 'cp', 'mv'],
        'can_write': True,
        'can_delete': False,
        'can_execute': False,
    },
    UserLevel.TRUSTED: {
        'allowed_commands': '*',  # 所有安全命令
        'can_write': True,
        'can_delete': True,       # 需二次确认
        'can_execute': True,      # 需二次确认
    },
}
```

### 8.2 权限检查

```python
def check_permission(user_id: str, command: str) -> bool:
    """检查用户是否有权限执行命令"""
    
    user_level = get_user_level(user_id)
    perms = PERMISSION_MAP[user_level]
    
    # 管理员全部允许
    if user_level == UserLevel.ADMIN:
        return True
    
    # 只读用户只能看
    if user_level == UserLevel.READ_ONLY:
        return command in perms['allowed_commands']
    
    # 检查命令是否在白名单
    if perms['allowed_commands'] != '*':
        return command in perms['allowed_commands']
    
    return True
```

---

## 九、审计日志

### 9.1 日志记录

```python
import logging
from datetime import datetime

class AuditLogger:
    def __init__(self):
        self.logger = logging.getLogger('agent_audit')
        handler = logging.FileHandler('/var/log/agent_audit.log')
        self.logger.addHandler(handler)
    
    def log(self, user_id: str, command: str, 
            result: str, dangerous: bool, 
            confirmed: bool = None):
        
        entry = {
            "timestamp": datetime.now().isoformat(),
            "user_id": user_id,
            "command": command,
            "result": result,
            "dangerous": dangerous,
            "confirmed": confirmed,
        }
        
        self.logger.info(json.dumps(entry))
    
    def get_user_history(self, user_id: str, 
                         start: datetime, 
                         end: datetime) -> list:
        """查询用户操作历史"""
        # 从日志中筛选
        pass
```

### 9.2 日志内容

```json
{
  "timestamp": "2024-06-16T10:30:00",
  "user_id": "u123",
  "command": "rm -rf /tmp/test",
  "result": "cancelled",
  "dangerous": true,
  "confirmed": false,
  "ip": "192.168.1.100",
  "session_id": "sess_abc123"
}
```

---

## 十、架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    用户请求                                  │
│                   「删掉这些文件」                          │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   安全检查层                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │
│  │ System Prompt│  │ 命令白名单  │  │ 权限分级   │       │
│  │   限制      │  │   校验      │  │   检查     │       │
│  └─────────────┘  └─────────────┘  └─────────────┘       │
│                          │                                 │
│                          ▼                                 │
│               ┌─────────────────┐                         │
│               │   危险操作？    │                         │
│               └────────┬────────┘                         │
│                        │                                  │
│                        ▼                                  │
│               ┌─────────────────┐                         │
│               │   二次确认     │ ← 需要用户确认           │
│               │   (等待回复)    │                         │
│               └────────┬────────┘                         │
│                        │                                  │
│         ┌─────────────┴─────────────┐                     │
│         ▼                           ▼                     │
│    「确认」                      「取消」                  │
│         │                           │                     │
└─────────┼───────────────────────────┼─────────────────────┘
          │                           │
          ▼                           ▼
┌─────────────────┐         ┌─────────────────┐
│   沙箱执行      │         │     取消       │
│  (Docker/NS)   │         │   返回结果     │
│                 │         │               │
│  用户隔离环境  │         │               │
└────────┬────────┘         └───────────────┘
         │
         ▼
┌─────────────────┐
│   审计日志     │
│  记录所有操作  │
└─────────────────┘
```

---

## 十一、总结

### 安全控制清单

```
✅ System Prompt 明确禁止危险操作
✅ 命令白名单过滤
✅ 权限分级控制
✅ 危险操作二次确认
✅ 沙箱隔离执行环境
✅ 文件路径校验（防止越权）
✅ 操作审计日志
✅ 禁止 ssh/远程连接
✅ 取消 sudo 权限
```

### 推荐配置

```
入门级：System Prompt + 命令白名单 + 二次确认
进阶级：+ 权限分级 + 路径校验
企业级：+ Docker 沙箱 + 审计日志 + 完整隔离
```

---

*本文档供 Agent 安全控制参考，实现时根据实际需求选择方案。*

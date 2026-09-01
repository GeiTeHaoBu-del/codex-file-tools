# Codex File Tools (MCP)

一套基于 MCP（Model Context Protocol）的文件操作工具，供 Codex agent 使用。解决了 Codex 原生 `apply_patch` / `shell_command` 在 Windows 上编辑文件时常见的 **CRLF 换行符、UTF-8 BOM、中文编码** 问题。

## 目录

```
D:\programs\neww\codex-file-tools\
├── server.mjs          ← MCP 服务器主程序（勿改）
├── package.json
├── node_modules/       ← 依赖
├── config.toml         ← 配置模板（拷贝到 .codex 目录用）
└── README.md           ← 本文档
```

## 6 个工具一览

| 工具名 | 功能 | 核心参数 |
|--------|------|----------|
| `read_file` | 读文件/目录内容（带行号） | `filePath`, `offset?`, `limit?` |
| `write_file` | 创建/覆盖文件（自动建目录） | `filePath`, `content` |
| `edit_file` | 精确字符串替换（唯一匹配校验） | `filePath`, `oldString`, `newString` |
| `search_file` | 跨文件搜索（regex/literal） | `rootPath`, `pattern`, `fileGlob?`, `mode?`, `maxResults?` |
| `list_dir` | 目录列表（支持递归+过滤） | `dirPath`, `recursive?`, `maxDepth?`, `fileGlob?` |
| `move_file` | 移动/重命名 | `oldPath`, `newPath` |

---

## 配置方法（给 Codex）

### 方式一：全局配置（所有项目生效）

打开 `C:\Users\Administrator\.codex\config.toml`，添加：

```toml
[mcp_servers.file-tools]
command = 'D:\env\node\node.exe'
args = ['D:\programs\neww\codex-file-tools\server.mjs']
startup_timeout_sec = 120
```

> `command` 填你的 node.exe 绝对路径（`where node` 可查）。**不要用裸 `node`**，Codex 沙箱环境可能找不到。

### 方式二：项目级配置（仅当前项目生效）

在项目根目录创建 `.codex\config.toml`：

```toml
[mcp_servers.file-tools]
command = 'D:\env\node\node.exe'
args = ['D:\programs\neww\codex-file-tools\server.mjs']
startup_timeout_sec = 120
```

### 验证是否生效

重启 Codex 后运行：

```
codex exec -s read-only "列出你有哪些mcp工具"
```

如果看到 `mcp__file_tools__read_file` 等 6 个工具，说明连接成功。

---

## Agent 使用规则（写入 AGENTS.md 或 system prompt）

### 推荐的工具选择顺序

1. **搜索代码** → `search_file`（regex/literal 两种模式）
2. **读文件确认** → `read_file`（带行号，支持 offset/limit 分段）
3. **改几行代码** → `edit_file`（精确替换，oldString 必须唯一）
4. **创建新文件/重写大段** → `write_file`（自动建目录，中文无乱码）
5. **看目录结构** → `list_dir`（带文件大小，支持递归）
6. **移动/重命名** → `move_file`

### 常见场景示例

```
# 找某个函数定义
search_file(rootPath="D:\\projects\\myapp", pattern="def login", fileGlob="*.py")

# 搜索中文关键词（用 literal 模式，避免正则转义问题）
search_file(rootPath="D:\\projects\\myapp", pattern="拦截", mode="literal")

# 读文件指定行段
read_file(filePath="D:\\projects\\myapp\\src\\main.ts", offset=100, limit=50)

# 改一行代码（oldString 必须与文件内容完全一致，含缩进）
edit_file(
  filePath="D:\\projects\\myapp\\src\\main.ts",
  oldString="const port = 3000",
  newString="const port = 8080"
)

# 创建新文件
write_file(filePath="D:\\projects\\myapp\\src\\utils.py", content="..." )
```

### 关键注意事项

- **`edit_file` 的 `oldString` 必须精确匹配**：包括缩进、空行、换行。不确定时先 `read_file` 复制原文。
- **换行符**：`oldString`/`newString` 统一用 `\n`（LF）。工具内部会自动适配文件的 CRLF/LF，写回时保留原格式。
- **BOM**：工具自动剥离/保留 UTF-8 BOM，无需手动处理。
- **`edit_file` 唯一匹配**：如果 `oldString` 在文件中出现多次，会报错要求提供更多上下文。这是特性——防止改错位置。
- **路径用绝对路径**：所有工具要求绝对路径。

### 禁止用法

- ❌ 不要用 `apply_patch` 编辑文件（格式挑剔，中文易出错）
- ❌ 不要用 `shell_command` / `powershell` 传中文内容编辑文件（GBK 编码破坏）
- ❌ 不要用 `python -c "含中文"` 写文件（编码问题）

---

## 独立测试（不经过 Codex）

直接向 MCP 服务器发请求验证工具是否正常：

```powershell
echo {"jsonrpc":"2.0","id":1,"method":"tools/list"} | D:\env\node\node.exe D:\programs\neww\codex-file-tools\server.mjs
```

应返回 6 个工具的 JSON 定义。

---

## 故障排查

| 现象 | 原因 | 解决 |
|------|------|------|
| Codex 说 "unsupported call" | MCP 服务器未启动/连接失败 | 确认 config.toml 里 `command` 是 node.exe 绝对路径；`startup_timeout_sec` 加大 |
| 工具列表为空 | 服务器进程启动报错 | 用上文的"独立测试"手动验证 server.mjs 能否跑通 |
| `edit_file` 报 not found | oldString 与文件内容不完全一致 | 先 `read_file` 精确复制要替换的文本（含缩进和换行） |
| `edit_file` 报 multiple matches | oldString 出现多次 | 补充更多上下文行让匹配唯一 |

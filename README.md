# DSH CC-HAHA Memory

一个面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的第三方持久记忆插件，参考并复刻 [CC-HAHA](https://github.com/NanmiCoder/cc-haha) 的项目记忆使用体验。

> [!IMPORTANT]
> 本项目不是 CC-HAHA 官方组件，也不隶属于 CC-HAHA 或 DeepSeek。记忆理念与交互流程参考 CC-HAHA，插件代码使用 DSH 原生事件、工具、LLM 和 Web UI 接口独立实现。

## 能做什么

- **真实记住**：用户明确说“记住”时，DSH 会先读取记忆索引，再显示 `memory_remember` 工具调用；只有返回 `saved: true` 后才确认已记住。
- **独立文件**：每条记忆保存为单独的 Markdown 文件，并由 `MEMORY.md` 维护简洁索引。
- **项目隔离**：每次只注入“通用 + 当前项目”，不会把所有项目记忆一次性塞进上下文。
- **新会话召回**：按当前问题选择最多 5 条相关记忆正文，无需每次手动搜索。
- **自动记录**：按回合评审值得长期保存的信息，失败时保留缓冲，不把模型错误伪装成“没有记忆”。
- **安全更新**：同主题通过明确记忆 ID 更新；禁止模糊标题猜测覆盖，更新和删除前保存历史版本。
- **管理界面**：会话页上方提供“记忆”标签、项目文件夹、搜索、新建、编辑和删除。
- **Claude 记忆导入**：可非破坏地导入现有 Claude Code 记忆；重复启动只跳过，不覆盖 DSH 中已更新的内容。

## DSH 插件标识

仓库根目录的 `package.json` 包含 DSH 原生插件声明：

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime"]
    }
  }
}
```

`cordis.patch.yml` 负责挂载 host 插件，`lib/client.js` 负责加载会话页记忆 UI。

## 安装

要求：已经安装并能正常启动 DSH。

```powershell
dsh plugin --profile web add github:yihefeikong-rgb/dsh-cc-haha-memory
```

安装后重启 DSH Web：

```powershell
dsh web
```

进入任意会话后，顶部应出现“记忆”标签。首次验证可以发送：

```text
请记住：这个项目使用 Rust 和 Tauri。
```

正常轨迹应包含：

```text
Read MEMORY.md → memory_remember → saved: true
```

记忆文件默认位于：

```text
~/.dsh/memory/
├── MEMORY.md
├── 通用/
└── <当前项目>/
    └── <主题>.md
```

## 配置

默认配置位于 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-memory
      name: dsh-memory
      config:
        reviewEnabled: true
        reviewInterval: 5
```

主要选项：

| 选项 | 默认值 | 说明 |
|---|---:|---|
| `reviewEnabled` | `true` | 是否启用回合后自动评审 |
| `reviewInterval` | `5` | 每多少回合评审一次 |
| `reviewTimeoutMs` | `120000` | 后台评审总超时 |
| `recallMaxBytes` | `25000` | 注入索引最大字节数 |
| `recallRelevantMaxBytes` | `16000` | 相关正文最大字节数 |

## 记忆工具

插件注册 8 个工具：

- `memory_remember`：显式“记住”的单次可见入口。
- `memory_write`：新建记忆。
- `memory_read`：读取完整记忆。
- `memory_update`：按 ID 更新并保存历史版本。
- `memory_delete`：删除并保存历史版本。
- `memory_search`：当前作用域全文搜索。
- `memory_list`：列出当前作用域索引。
- `memory_suggest_tags`：推荐已有标签。

## 隐私与安全边界

- 仓库和安装包不包含任何用户记忆、会话、日志、API Key 或本机 profile。
- 项目写入无法确认当前工作区时会失败，不会静默写进“通用”。
- Web API 运行在 DSH 本地同源信任边界内，不应把 DSH Web 端口暴露到不可信网络。
- 当前实现是单 DSH 进程内串行写入；不建议多个 DSH 实例同时共享同一个记忆目录。

## 本地开发

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run build
```

构建输出：

- `lib/index.js`：DSH host 插件。
- `lib/client.js`：DSH Web UI 插件。

## 与 CC-HAHA 的关系

本项目重点参考了 CC-HAHA 的以下记忆设计：

- 每条记忆使用独立文件，`MEMORY.md` 只保存短索引。
- 用户明确要求记住时必须真实访问记忆系统。
- 写入前检查已有记忆，优先更新而不是制造重复项。
- 记忆只保存跨会话仍有价值的信息，计划和一次性任务不应写入长期记忆。
- 用户要求忽略记忆时，本轮按空记忆处理。

参考基线：`NanmiCoder/cc-haha`，本地审查提交 `d52bbec707246f807416c2bc6b1cd67445cfe622`，相关设计位于其 `src/memdir/`。

感谢 CC-HAHA 作者与贡献者提供优秀的记忆交互设计。完整署名与许可证见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 验证状态

- 自动化测试：50 项。
- 已验证：显式写入、真实文件路径、重复更新、新会话召回、跨项目隔离、后台评审终态、非破坏导入与连续重启幂等。
- 已验证平台：Windows + DSH Web。

## License

[MIT](./LICENSE)

---

## English summary

An unofficial persistent-memory plugin for DeepSeek Harness, inspired by the project-memory workflow of CC-HAHA. It stores memories as project-scoped Markdown files, exposes visible memory tool calls, injects only global plus current-project context, and includes a Web UI memory tab.

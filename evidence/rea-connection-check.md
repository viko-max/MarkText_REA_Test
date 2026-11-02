# REA MCP 独立进程连通性检查

- 检查时间：2026-11-02 18:20（本地）
- 检查类型：**独立进程 MCP stdio 连通性测试**，不经过 Kimi Code Desktop 的 MCP 客户端
- 重要：**这不代表当前 Kimi 会话已连接 REA**。当前会话无法动态注册新增的项目 MCP，需按下方"重连"步骤在新会话核实。
- 原始 JSON：`evidence/rea-binary-session.json`（约 12.5 MB，含完整 `tools/list` schema 与全部 JSON-RPC 报文）
- 测试脚本：`.cache/mcp-check.mjs`（临时文件，保留在 `.cache` 内）
- stderr：空（0 字节，`.cache/mcp-check-stderr.log`）

## 1. 启动方式

| 项目 | 值 |
| --- | --- |
| command | `C:/Users/14698/Desktop/MarkText_REA_Test/tools/node/node.exe` |
| args | `C:/Users/14698/Desktop/MarkText_REA_Test/tools/rea/node_modules/rea-agents/scripts/rea.mjs`，`mcp` |
| cwd | `C:/Users/14698/Desktop/MarkText_REA_Test` |
| env | `REA_MCP_INPUT_SCHEMA_PROFILE=compact`；`TEMP/TMP/npm_config_cache/HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG_CACHE_HOME` 全部指向 `.cache/` 子目录 |
| 传输 | stdio，换行分隔 JSON-RPC 2.0 |
| 协议 | 请求 `2025-06-18`，服务端协商结果 `2025-06-18` |

执行命令：

```bash
cd C:/Users/14698/Desktop/MarkText_REA_Test
./tools/node/node.exe .cache/mcp-check.mjs
```

退出码 0，stderr 为空。

## 2. 服务身份（initialize 结果）

| 字段 | 值 |
| --- | --- |
| `serverInfo.name` | `rea` |
| `serverInfo.version` | `6.8.0` |
| `protocolVersion` | `2025-06-18` |
| capabilities | `tools`（listChanged）、`prompts`（listChanged）、`completions` |
| 包根路径 | `C:\Users\14698\Desktop\MarkText_REA_Test\tools\rea\node_modules\rea-agents` |
| MCP SDK | server/client/core 均 `2.3.1` |
| Skill 声明 | `reverse-engineer-anything` expected_version 49 |
| 目录统计 | CLI 命令 175、MCP 工具 **229**、MCP prompts 6 |
| catalog 摘要 | tools `a98940ba…e5e9`，prompts `96093794…e680b7`，combined `fe938a7c…da0b` |
| 客户端身份（本次测试） | `rea-local-connection-check` 0.0.0 |

## 3. tools/list

- 单页返回，**共 229 个工具**，`nextCursor` 不存在。
- 任务点名的工具全部**真实出现**在 `tools/list`：

| 工具 | 是否在 tools/list | binary_session 报告的可用性 |
| --- | --- | --- |
| `binary_session` | ✅ | `surface=session`，available |
| `analyze_javascript_application` | ✅ | `surface=electron-provider`，available |
| `inspect_analysis_view` | ✅ | `surface=application`，available |
| `trace_application_feature` | ✅ | `surface=application`，available |
| `trace_javascript_semantics` | ✅ | `surface=application`，available |
| `export_evidence_bundle` | ✅ | `surface=session`，available |

其他与后续 MarkText（Electron）分析相关的可用面：
- `electron-provider` 4/4 可用（`analyze_javascript_application`、`capture_electron_scenario`、`inspect_electron_page`、`list_electron_targets`）
- `browser-provider` 5/5 可用
- `application` 6/7 可用；唯一不可用为 `recover_javascript_sources`（`unsupported_host`）
- `runtime-provider` 1/1、`managed-provider` 1/1、`pcap-provider` 1/1 可用
- `native-provider` 14/19 可用，其余 `unsupported_host`
- 原生反编译器后端均未配置：`ghidra`（未设 `GHIDRA_INSTALL_DIR`）、`hopper`、`ida`、`kuna` 均为 `unavailable`
- `adb`/`apktool`/`jeb`/`android` 等移动端 provider 不可用（`provider_unavailable` / `provider_missing`）

> `tools/list` 中出现 ≠ 当前无需 target 即可执行；上表"可用性"来自 `binary_session({})` 返回的 `tool_availability`，它区分了 `available`、`target_required`、`unsupported_host`、`provider_missing`。

## 4. tools/call → binary_session({})

- 结果：**成功**，无 JSON-RPC error，耗时约 **1055 ms**。
- 结构化结果要点：
  - `open: false` —— 当前无打开的分析目标（预期，工作区尚无被测 app）
  - `cleanup_pending: false`
  - `analysis_provider_binding: null`；`analysis_provider_candidates` 为 ghidra/hopper/ida/kuna，均 unavailable
  - `client_features`：elicitation / roots / sampling 均未启用（本测试客户端未声明）
  - 返回了完整能力清单（`capabilities`）与 77 个工具可用性分组
  - `server_identity.package.version` = 6.8.0，`server.command_path` 指向 `tools/rea/.../scripts/rea.mjs`
- 返回内容带 `_meta.provenance.untrusted_content = true`（REA 将目标内容视为不可信输入，属预期安全标记）。

原始报文（4 条 client→server、3 条 server→client）见 `evidence/rea-binary-session.json` 的 `transcript` 数组。

## 5. 配置驱动的二次校验

另用 `.cache/validate-mcp-json.mjs` **直接读取 `.kimi-code/mcp.json`**（而不是复制参数）启动同一服务，验证 command/args/cwd/env 路径全部存在：

- 服务身份：`rea` 6.8.0，协议 `2025-06-18`
- `tools/list`：229 个工具，无分页
- `binary_session({})`：`open=false`、`cleanup_pending=false`
- 退出码 0，stderr 为空
- 结果：`.cache/mcp-config-validation.json`（`ok: true`）

## 6. 限制与未做的事

- 未运行 `rea setup`，未配置 Ghidra/IDA/Hopper 等原生后端；本次只验证 MCP 协议与会话入口。
- 未打开任何真实 binary，因此 `binary_session` 的 `open` 为 `false`；也未执行 `analyze_javascript_application` 等需要 target 的分析。
- 未通过 Kimi Code Desktop 的 MCP 客户端连接；`/mcp` 状态需在新会话确认。
- `toolTimeoutMs: 900000` 仅是客户端等待上限，不是 REA 内部分析时限。
- 本次检查启动的 node 进程已结束，未发现残留 `MarkText_REA_Test` 相关进程。

## 7. 新会话重连（必须执行）

1. 在 Kimi Code Desktop 以 `C:/Users/14698/Desktop/MarkText_REA_Test` 为工作目录**新建会话**。
2. 信任该项目，启用项目级 MCP（新增 MCP 只在**新会话**注册）。
3. `/mcp` 查看 `rea` 状态。
4. 在新会话里实际调用 `binary_session({})` 核实，不要仅凭 `/mcp` 显示判断。

## 8. 2026-11-02 18:29 复核

- 再次执行 `./tools/node/node.exe .cache/mcp-check.mjs`，进程正常结束，退出码 0。
- `initialize`：REA 6.8.0，协议 `2025-06-18`。
- `tools/list`：仍为 229 个工具。
- `tools/call binary_session({})`：成功，耗时约 1152 ms；原始 JSON 已刷新至 `evidence/rea-binary-session.json`。
- 本次仍是独立进程检查；REA 工具未注册到当前 Kimi 会话，不能据此宣称当前会话已直连 REA。

## 9. 2026-11-02 新会话直连复核

- 在以本工作区打开的新 Kimi Code Desktop 会话中，已实际调用 `mcp__rea__binary_session({})` 并成功返回。
- 返回确认：`open=false`、`cleanup_pending=false`，服务版本为 REA 6.8.0。
- 本次是经过 Kimi Code Desktop MCP 客户端的真实调用，不再只是第 1–8 节的独立进程检查。
- 调用时 `app/` 尚无分析目标，因此 `open=false` 属于预期状态。

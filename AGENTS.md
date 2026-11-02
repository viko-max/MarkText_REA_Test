# MarkText REA 测试工作区 — AGENTS.md

本文件是本目录的权威说明。任何新增脚本、命令、目录用途变化，都要同步更新本文件。

## 1. 目录用途

| 路径 | 用途 | 是否可写 |
| --- | --- | --- |
| `tools/` | 任务自带的隔离工具链：`tools/node/`（Node.js v24.22.1 解压版）、`tools/rea/`（本地 npm 项目，固定 `rea-agents@6.8.0`） | 可写（仅工具安装） |
| `reference/` | MarkText 原始参考材料；当前为 `marktext-win-x64-0.23.0/` 官方 Windows x64 免安装发行目录 | **原始材料只读**，不得修改/覆盖 |
| `evidence/` | 环境记录、MCP 连通性检查结果、REA 原始证据与简短调查记录 | 可写（只追加/修订结论） |
| `app/` | 新轻量 Markdown 编辑器的源代码、项目依赖、测试与构建产物 | 可写；**应用代码只能由子代理编写/修改** |
| `fixtures/` | 后续测试夹具（当前为空） | 可写 |
| `.cache/` | npm cache、TEMP/TMP、隔离 HOME/APPDATA、下载的 Node zip、MCP 检查脚本与日志 | 可写，**可随时清理** |
| `.kimi-code/` | 项目级 Kimi 配置，当前只有 `mcp.json`（REA MCP 服务声明） | 仅按需修改 |
| `AGENTS.md` | 本说明 | 可写 |

## 2. 边界与硬性规则

1. **不得全局安装**：只用 `tools/node/` + `tools/rea/` 的本地安装；不要 `npm i -g`，不要写用户级 npm 前缀（`%APPDATA%\npm`）。
2. **不得把任务文件写到本工作目录之外**：npm cache / TEMP / TMP / HOME / USERPROFILE / APPDATA / LOCALAPPDATA / XDG_CACHE_HOME / GNUPGHOME 全部指向 `.cache/` 下。
3. **不修改 PATH**：不写系统/用户环境变量；调用 Node 一律用绝对路径 `C:/Users/14698/Desktop/MarkText_REA_Test/tools/node/node.exe`。
4. **`reference/` 只读**：原始材料不编辑、不移动、不覆盖。
5. **不写用户级 Kimi 配置**：只使用项目级 `.kimi-code/mcp.json`。
6. 不要运行 `rea setup`（本任务明确不执行）；不要下载 MarkText 源码（后续任务另做）。
7. 不要读取 MarkText GitHub 实现源码。

## 3. 当前环境（2026-11-02 建立）

- Node（隔离）：`C:/Users/14698/Desktop/MarkText_REA_Test/tools/node/node.exe` → **v24.22.1**（官方 win-x64 zip，SHA-256 已核对）
- npm（随附）：**11.19.1**，通过 `tools/node/node_modules/npm/bin/npm-cli.js` 调用
- REA：`tools/rea/node_modules/rea-agents` → **rea-agents 6.8.0**
- `rea-agents` engines：**`^22.23.4 || ^24.22.1 || >=26.12.1`**（本地 Node v24.22.1 满足）
- MCP 入口：`tools/rea/node_modules/rea-agents/scripts/rea.mjs mcp`
- 项目 MCP 配置：`.kimi-code/mcp.json`，服务名 `rea`
- 系统 Node v24.14.0 **不满足** engines，任何命令都不要依赖 `node`/`npm` 的 PATH 解析。

## 4. 当前启动 / 验证方式

### 4.1 独立进程 MCP 连通性检查（不依赖 Kimi 会话）

```bash
cd C:/Users/14698/Desktop/MarkText_REA_Test
./tools/node/node.exe .cache/mcp-check.mjs
```

该脚本会：以 `.kimi-code/mcp.json` 同款 command/args/cwd/env 启动真实进程 → `initialize` → `tools/list`（全部分页）→ `tools/call binary_session {}`，并把原始 JSON 写入 `evidence/rea-binary-session.json`、摘要打印到 stdout。结果记录在 `evidence/rea-connection-check.md`。

> 这是**独立进程**检查，不能说明当前 Kimi 会话已连接 REA。

配置本身（`.kimi-code/mcp.json` 的 command/args/cwd/env）可单独校验：

```bash
./tools/node/node.exe .cache/validate-mcp-json.mjs   # 输出 .cache/mcp-config-validation.json，ok:true 即通过
```

### 4.2 在 Kimi Code Desktop 中使用（重连说明）

1. 在 Kimi Code Desktop 以 `C:/Users/14698/Desktop/MarkText_REA_Test` 为工作目录**新建会话**。
2. 信任该项目（启用项目级 MCP）；项目 MCP 只在**新会话**注册，当前已有会话不会动态加载。
3. 用 `/mcp` 查看 `rea` 服务状态。
4. 必须在新会话里实际调用一次 `binary_session({})` 核实（不要只看 `/mcp` 的绿点）。
5. 若失败：检查 `node.exe` 与 `rea.mjs` 路径是否存在、项目是否被信任、`.cache` 目录是否可写。

### 4.3 npm 命令（如需重装/核对）

必须同时隔离环境变量，示例：

```bash
W=C:/Users/14698/Desktop/MarkText_REA_Test
env TEMP="$W/.cache/tmp" TMP="$W/.cache/tmp" \
    HOME="$W/.cache/home" USERPROFILE="$W/.cache/home" \
    APPDATA="$W/.cache/appdata" LOCALAPPDATA="$W/.cache/localappdata" \
    XDG_CACHE_HOME="$W/.cache/xdg-cache" npm_config_cache="$W/.cache/npm-cache" \
    "$W/tools/node/node.exe" "$W/tools/node/node_modules/npm/bin/npm-cli.js" \
    --prefix "$W/tools/rea" install
```

## 5. 参考应用与新编辑器

### 5.1 MarkText 参考材料与 REA 复核

当前参考目标是官方 **MarkText v0.23.0 Windows x64** 免安装发行包，位于 `reference/marktext-win-x64-0.23.0/`；主程序为 `marktext.exe`，应用入口为 `resources/app.asar` 内的 `out/main/index.js`。没有执行安装程序，没有下载或读取 GitHub 实现源码。

原始发行包与清单保留在 `.cache/downloads/`。需要重新获取时使用：

```bash
mkdir -p .cache/downloads
curl -fL --output .cache/downloads/marktext-win-x64-0.23.0.zip \
  https://github.com/marktext/marktext/releases/download/v0.23.0/marktext-win-x64-0.23.0.zip
curl -fL --output .cache/downloads/SHA256SUMS.txt \
  https://github.com/marktext/marktext/releases/download/v0.23.0/SHA256SUMS.txt
(cd .cache/downloads && sha256sum -c SHA256SUMS.txt --ignore-missing)
```

ZIP 期望 SHA-256：`10ff69f91303f1009e7bdb1f490a4b30d716804ebc95b9e98c12b0c84cffa16f`。ASAR SHA-256：`8b5ff1efe06d907722899bffafd96189156672b336ce303d1d3741c023bef053`。

REA 分析使用 `inspect_desktop_application`、`open_binary`、`inspect_artifact` 和 `analyze_javascript_application`，选定 `package.json`、`out/main/index.js`、`out/preload/index.js`、`out/renderer/index.html` 与 `out/renderer/assets/index-mApCbCvT.js`，并检查 Electron fuses、PE 证书表和 load-config。全量 ASAR 初次分析曾在第三方 `.yarn` 插件超时，后续采用明确 `source_paths`；不得把未选文件或自动 IPC 未配对解释为功能不存在。

完整证据：`evidence/marktext-v0.23.0-rea-evidence-bundle.json`（1,161,838,867 字节；SHA-256 `acc64fae3f8d2a369a66468f9bf23c09ab4968bba25ad0dafa6bb18911254538`）。简短调查记录：`evidence/marktext-v0.23.0-investigation.md`。

`.cache/marktext-v0.23.0-entry/` 是用本地 `tools/rea/node_modules/@electron/asar` 原样提取的入口副本，仅供行列复核，可随 `.cache` 清理。证据包超过 V8 单字符串上限，不能用 `readFileSync(..., 'utf8')` + `JSON.parse` 整包读取；使用已有 `stream-json` 依赖逐令牌复核：

```bash
./tools/node/node.exe .cache/validate-marktext-evidence.mjs
```

该脚本验证完整 JSON 语法并输出顶层字段、记录数、未知头数量和最终嵌套深度，可随 `.cache` 清理后按需重建。逆向阶段未运行 MarkText，静态结论与后续动态验证分开记录。

### 5.2 新编辑器实施规则

- 新编辑器采用 **Electron + TypeScript**，位于 `app/`；架构与验收标准见 `docs/plans/2026-11-02-markdown-editor-design.md`。
- 主代理只负责架构、任务拆分、环境、验收、运行验证和 review；**所有应用代码、测试代码、脚本及脚手架均由子代理编写和修改，主代理不得直接编辑这些文件**。
- 依赖只能安装到 `app/node_modules`，不得全局安装。预览与 HTML 导出必须共用同一渲染管线；双链与图谱必须来自真实笔记索引；测试只能使用 `fixtures/` 和工作区内运行数据。
- 每次功能实施后都要运行对应构建/测试和真实界面验证，发现问题交回子代理修改并复验。

新编辑器命令（先 `cd app`，npm 本身仍使用根目录隔离 Node 与 `.cache` 环境）：

```bash
npm run dev          # 开发模式，启动 GUI
npm start            # 运行 out/ 中已构建版本
npm run typecheck    # main/preload/renderer 类型检查
npm test             # Vitest 单元与集成测试
npm run test:e2e     # 真实 Electron 行为与 MarkText 对照测试
npm run build        # 生产构建到 out/
npm run package      # 免安装打包到 dist/win-unpacked/
```

`package.json` 脚本直接调用本工作区绝对 Node；调用 npm 的完整隔离环境写法见 `app/AGENTS.md`。当前验证结果：34 个测试文件 315 用例、14 个 Electron 场景、生产构建和免安装打包全部通过；打包 EXE 已用 REA 实际启动。除既有功能外，已实测全应用浅色/深色/跟随系统与自定义壁纸（预览、导出和重启恢复一致）。产品说明见 `app/README.md`，实测与限制见 `evidence/verification.md`。

## 6. 清理规则

- `.cache/` 可整体删除（`rm -rf .cache`）：内含 Node zip 与 SHASUMS/签名、npm cache、隔离 HOME/APPDATA、gnupg 临时钥匙环、MCP 检查脚本与日志。删除后不影响已解压的 `tools/node/` 与 `tools/rea/node_modules/`。
- 若要重跑下载校验，重新下载 zip + `SHASUMS256.txt`；哈希见 `evidence/environment.md`。
- `evidence/` 不随 `.cache` 清理；只有重做验证时才覆盖对应文件。
- `reference/` 永不清理、永不改写。
- `app/.runtime/`、`app/.test-runtime/` 是隔离运行与测试数据，可删除后重建；删除前关闭应用。`app/test-results/` 是本轮验收证据，默认保留，需要重跑时可删除。
- `app/out/` 与 `app/dist/` 是构建产物，可通过 `npm run build`、`npm run package` 重建；`app/node_modules/` 不纳入日常清理。
- 早期 `app/release/` 只剩被 Windows 外部句柄锁定的旧打包文件；句柄释放后可删除，不得强杀系统进程。正式交付使用 `app/dist/`。
- 不得为了清理而删除本目录之外的任何东西。

## 7. 版本库

远程是 GitHub 私有仓库 `viko-max/MarkText_REA_Test`。只跟踪源码、文档、锁文件和小体积证据。下列内容留在本机，克隆后按本文重新获取或安装：

| 路径 | 原因 |
| --- | --- |
| `.cache/` | 可整体删除的缓存与隔离环境 |
| `reference/` | 官方免安装包。`marktext.exe` 约 216MB，`resources/app.asar` 约 170MB，都超过 GitHub 100MB 单文件限制；按第 5.1 节重新下载 |
| `tools/node/` | 官方 Node 解压包，按 `evidence/environment.md` 重新获取 |
| `tools/rea/node_modules/` | 由 `tools/rea/package-lock.json` 重装 |
| `app/node_modules/`、`app/out/`、`app/dist/`、`app/release/`、`app/.runtime/`、`app/.test-runtime/`、`app/test-results/` | 依赖、构建产物与本机运行数据 |
| `evidence/marktext-v0.23.0-rea-evidence-bundle.json` | 约 1.1GB，超过 GitHub 单文件限制。调查结论写在同目录的 markdown 里 |

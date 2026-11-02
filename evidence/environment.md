# 隔离 REA 环境记录（environment.md）

记录时间：2026-11-02 18:21（本地）
工作目录：`C:/Users/14698/Desktop/MarkText_REA_Test`
主机：Windows（MINGW64_NT-10.0-26200），`PROCESSOR_ARCHITECTURE=AMD64` → 使用 **win-x64** 构建。
系统 Node：`C:/Program Files/nodejs/node.exe` v24.14.0（**不满足** REA engines，未用于任何安装）。

## 1. Node.js v24.22.1（隔离安装，未改 PATH）

| 项目 | 值 |
| --- | --- |
| 版本 | v24.22.1 |
| 构建 | win-x64 zip |
| 下载 URL | https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip |
| 本地 zip | `.cache/node-v24.22.1-win-x64.zip`（37,748,064 字节） |
| 官方清单 | https://nodejs.org/dist/v24.22.1/SHASUMS256.txt（本地 `.cache/node-shasums.txt`） |
| zip SHA-256 | `d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5` |
| 清单中期望值 | `d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5` ✅ 一致 |
| 清单文件 SHA-256 | `fdfbffc969c0f604beff0124d409b33a43b53f5c681d6220f80023e0d6df9dc4` |
| GPG 签名 | `SHASUMS256.txt.sig` 用官方 release-keys 公钥环验证：**Good signature**，签名者 Antoine du Hamel，主密钥指纹 `5BE8 A3F6 C8A5 C01D 106C 0AD8 20B1 A390 B168 D356`（未建立信任链，gpg 报 "not certified"，仅证明清单完整性与签名者身份） |
| 解压目标 | `tools/node/`（zip 内顶层目录 `node-v24.22.1-win-x64/` 的内容） |
| 验证 | `tools/node/node.exe -v` → `v24.22.1`；随附 npm → `11.19.1` |
| PATH | **未修改**（系统/用户 PATH 与环境变量均未触碰） |

说明：GPG 验证在 `.cache/gnupg`（临时 `GNUPGHOME`）内完成，未导入用户钥匙环。解压用的临时目录 `.cache/node-extract/` 已删除；zip 与清单保留以便复核。

## 2. rea-agents 本地安装（非全局）

| 项目 | 值 |
| --- | --- |
| 项目目录 | `tools/rea/` |
| 安装方式 | `tools/node/node.exe tools/node/node_modules/npm/bin/npm-cli.js install rea-agents@6.8.0 --save-exact --no-fund --no-audit` |
| 使用 Node | `tools/node/node.exe`（v24.22.1），**未**使用系统 Node v24.14.0 |
| 已安装版本 | **rea-agents 6.8.0** |
| 安装位置 | `tools/rea/node_modules/rea-agents` |
| 实际 package.json engines | **`^22.23.4 || ^24.22.1 || >=26.12.1`** |
| 引擎判定 | Node v24.22.1 满足 `^24.22.1` 下界 ✅ |
| `bin` | `rea` / `rea-agents` → `scripts/rea.mjs` |
| 依赖锁文件 | `tools/rea/package-lock.json`（lockfileVersion **3**，`node_modules/rea-agents` = 6.8.0） |
| 隐藏锁文件 | `tools/rea/node_modules/.package-lock.json`（npm 实际安装树快照） |
| 顶层依赖 | 176 个包（含 `@modelcontextprotocol/server` 2.3.1、`@modelcontextprotocol/client` 2.3.1、`frida`、`playwright-core`、`@lydell/node-pty` 等） |
| registry 记录 | `.cache/rea-agents-6.8.0.registry.json`（用于核对 engines/tarball/integrity） |

安装使用隔离环境变量：

```
TEMP=TMP=<workdir>/.cache/tmp
HOME=USERPROFILE=<workdir>/.cache/home
APPDATA=<workdir>/.cache/appdata
LOCALAPPDATA=<workdir>/.cache/localappdata
XDG_CACHE_HOME=<workdir>/.cache/xdg-cache
npm_config_cache=<workdir>/.cache/npm-cache
```

npm cache 实际落在 `.cache/npm-cache/`（`_cacache`、`_logs`、`_prebuilds` 均在其中），未使用 `%LOCALAPPDATA%\npm-cache`。

### 安装期告警（已知限制）

- npm 11.19.1 的 allowScripts 机制跳过了 `frida@17.23.2` 的 `install: node scripts/install.js`。
- 检查结果：`tools/rea/node_modules/frida/build/frida_binding.node` 已存在（包内自带预编译 binding），本次 MCP 启动与 `binary_session({})` 不依赖该安装脚本。
- 未批准/未运行任何 install script，也未运行 `rea setup`。

### 全局安装检查

- `npm root -g` → `C:\Users\14698\AppData\Roaming\npm\node_modules`，其中**没有** `rea-agents`。
- 系统 npm 全局前缀未被写入；所有安装产物在 `tools/rea/`。

## 3. 项目级 MCP 配置

文件：`.kimi-code/mcp.json`（合法 JSON，已用 Node 解析验证）

- 服务名：`rea`
- command：`C:/Users/14698/Desktop/MarkText_REA_Test/tools/node/node.exe`
- args：`C:/Users/14698/Desktop/MarkText_REA_Test/tools/rea/node_modules/rea-agents/scripts/rea.mjs`，`mcp`
- cwd：`C:/Users/14698/Desktop/MarkText_REA_Test`
- env：`REA_MCP_INPUT_SCHEMA_PROFILE=compact`，并把 `TEMP/TMP/npm_config_cache/HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG_CACHE_HOME` 指向 `.cache/` 子目录
- `startupTimeoutMs: 60000`，`toolTimeoutMs: 900000`

`toolTimeoutMs` 只是**客户端等待上限**，不代表 REA 内部分析时限，也不保证单次分析一定在 15 分钟内完成。

## 4. 重连 / 使用说明（准确版）

1. 在 Kimi Code Desktop 以 `C:/Users/14698/Desktop/MarkText_REA_Test` 为工作目录**新建会话**。
2. 信任该项目以启用项目级 MCP（项目 MCP 只在新会话注册，已在运行的会话不会动态加载新增 MCP）。
3. 用 `/mcp` 查看 `rea` 服务状态。
4. 必须在新会话内实际调用一次 `binary_session({})` 再确认可用；`/mcp` 的状态不能替代真实调用。

**当前会话（建立本环境的会话）无法动态注册新增的项目 MCP**；本次验证是独立子进程直连，不代表当前 Kimi 会话已连接 REA。

## 5. 目录与清理

- `.cache/`（清理前约 305 MB，现约 198 MB）可整体删除；保留 `tools/node`、`tools/rea`、`evidence/` 即可继续使用。
- `reference/` 原始材料只读。
- 无任务文件写到工作目录之外：安装/验证期间因诊断命令（`npm ls`、`npm root -g`、`npm ls -g`）在 `%LOCALAPPDATA%\npm-cache\_logs\` 产生的 3 个 `2026-11-02T10_*.log` 已全部删除。未写入用户级 Kimi 配置，未修改 PATH，未做全局安装。

## 6. MarkText v0.23.0 分析目标与证据

- 官方发行页：`https://github.com/marktext/marktext/releases/tag/v0.23.0`（`releases/latest` 实测重定向到此版本）。
- 使用资产：`marktext-win-x64-0.23.0.zip`，未执行安装程序，未下载 Source code zip/tar.gz。
- ZIP：181,482,586 字节；SHA-256 `10ff69f91303f1009e7bdb1f490a4b30d716804ebc95b9e98c12b0c84cffa16f`，已通过官方 `SHA256SUMS.txt` 复核。
- 解压目录：`app/marktext-win-x64-0.23.0/`；`marktext.exe` SHA-256 `44a60d509c3981d9b147da68babeedc29716cc1dbd94138eeb390369bbd77e80`；`resources/app.asar` SHA-256 `8b5ff1efe06d907722899bffafd96189156672b336ce303d1d3741c023bef053`。
- 当前 Kimi 会话已实际调用 `binary_session({})` 成功；不再只是独立进程连通性检查。
- REA ZIP 清单：439 个中央目录条目，图含 144 节点、148 occurrence、147 条边，完整性矛盾为 0。ZIP 非条目字节不属于该清单覆盖范围。
- 全量 ASAR 初次分析在 `node_modules/@mixmark-io/domino/.yarn/plugins/@yarnpkg/plugin-version.cjs` 达到 300 秒单源时限；保留部分证据 `ev_1f3892d3c9569a155a50fece7907c6158d530e4269e3248d73d8ae077a389ed8`。后续改用明确入口范围，不将该第三方开发插件纳入主程序结论。
- 主进程/预加载入口分析：`ev_8469dfa90168425625714a9902c0c94648d2517fdd7c7fecb3973d1898c02710`；渲染入口分析：`ev_a84c5ae19c9e2cbc6b26eb99a0d3f6e478243acd21d309129eec0a150ebc3f3b`。两者均保留未选文件与语义资源上限，不能据此作全程序否定性结论。
- Electron fuses：`ev_658bf8ed0b4560c9378e21e38ceb2a0f9a478dcd7c2421916a4aeba5096530ab`；PE 证书表：`ev_7298cb1f231db6db38b99a8ab1ff8a9d66618cfdc54e37996ecd50c32d874a8d`；PE load-config：`ev_81354766391261b154087af322ad5ec38b7662b4a470f934a16bd0bb2b91cc06`。
- 完整证据包：`evidence/marktext-v0.23.0-rea-evidence-bundle.json`，22 条记录、0 个 residual unknown head，1,161,838,867 字节，SHA-256 `acc64fae3f8d2a369a66468f9bf23c09ab4968bba25ad0dafa6bb18911254538`。未知项仍保存在各分析记录内部，0 个 head 不表示全图完整。
- 本次没有运行 MarkText，所有功能与风险结论均为发行文件静态观察；运行时行为、菜单实际可达性和保存保护尚需动态场景复核。

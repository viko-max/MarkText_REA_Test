# 最终验证记录

日期：2026-11-02  
产品：`app/` 中的 Markdown Lite Studio 0.1.0

## 1. 构建与自动化结果

以下命令均由主代理在交付前独立复跑，使用工作区 Node v24.22.1 和隔离环境：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 34 个测试文件、315 个用例全部通过 |
| `npm run build` | main/preload/renderer 类型检查与 electron-vite 构建通过 |
| `npm run test:e2e` | 14 个真实 Electron 场景全部通过，约 50 秒 |
| `npm run package` | 免安装 Windows x64 构建成功，输出 `app/dist/win-unpacked/` |

免安装 EXE：`app/dist/win-unpacked/markdown-lite-studio.exe`

- SHA-256（主题与壁纸更新后）：`b1d6fc26c98cd3f25c1768bf5f6377e37f32ad9f46dab3c0a00c567348c9041d`
- 目录大小：约 370 MiB。
- REA `capture_electron_scenario` 已实际启动该最终 EXE，窗口 `Markdown Lite Studio` 可见，加载 `resources/app.asar/out/renderer/index.html`；证据 `ev_30e4b7ac13cdf6e44e0c1bed7bd573840349fb1dcad8e1397661c4e8b05c6e2d`。
- REA 的主动 IPC hook 在打包应用上报告 `hook_conflict`，因此该启动证据只用于窗口/进程观察，不用于声称完整 IPC 覆盖。

## 2. 新应用行为场景

| 场景 | 实测结果与证据 |
| --- | --- |
| E1 启动、恢复与文件树 | 自动打开隔离工作区，真实显示 5 个目标文件；已有 HTML 可预览/看源码，脚本未执行 |
| E2 中文编辑与预览 | 中文进入 CodeMirror 和预览；撤销、Ctrl+Shift+Z 重做、查找、手动及自动保存通过 |
| E3 新建、反链、图谱、重命名 | 真实新建文件；反链和图谱来自笔记链接；节点点击打开；目标引用更新，无关歧义不变，分屏保持 |
| E4 图片粘贴与重启 | 根目录和嵌套文档分别使用 `assets/`、`../assets`；哈希文件字节一致；重启后图片为内嵌资源而非临时 blob |
| E5 主题、布局与导出 | CSS 变量和根布局同步；真实 HTML 与 iframe srcdoc 完全相等；本地图片为 data URI；未导出标记正确；导出文件可重新预览 |
| E6 外部变化与失败 | conflict/missing 均阻止覆盖；可确认重载；缺失链接有标记；只读目标显示 `forbidden: file access denied`，不伪报保存成功 |
| E7 重启恢复 | 工作区、两个文档、活动文档、中文内容、主题布局和 split 均恢复 |
| E8 性能 | 启动时间、RSS 与 10 个文档后的实测值已记录，见下节 |

截图：`app/test-results/E1-startup-and-file-tree/` 至 `app/test-results/E8-performance/`。每例另有 `result.json` 和 `main.log`。

## 3. 实测性能（最终复跑）

来源：`app/test-results/performance.json`。

- 进程启动到 `firstWindow`：332.4 ms。
- 到 `#workspace-shell` 可见：528.6 ms。
- 启动稳定后主进程 RSS：103.03 MiB。
- 再打开 10 个小文档后 RSS：110.38 MiB。

这些是本轮 Windows 开发环境实测，不构成与其他应用的普遍性能结论。免安装目录约 378 MiB；“轻量”指功能和自主实现范围集中，不据此声称分发体积或内存优于 MarkText。

## 4. MarkText v0.23.0 对照

来源：`app/test-results/marktext-compare.json` 及对应截图。

### 打开与渲染：已观察

- 使用独立 `--user-data-dir` 和 `--read-only` 启动真实 MarkText。
- 中文标题、任务、表格、代码块与图片正常渲染，只读编辑器 `contenteditable=false`。
- MarkText 是 Muya WYSIWYG 内联预览；新应用是独立 iframe HTML 预览，属于主动简化。

### 真实保存：已观察

- 在隔离副本中追加中文标记并执行渲染端 `file.save` 命令，文件真实写入。
- CDP 注入的 Ctrl+S 不触发 Electron 原生菜单加速键，因此使用同一命令中心完成验证；该限制已记录。
- 两者都真实写盘；新应用额外使用 baseHash CAS 防止外部修改被静默覆盖。

### HTML 导出：渲染端已观察，主进程写盘未知

- 通过 MarkText 已知 commandCenter 打开真实导出流程，捕获其生成的 styled HTML payload：979,454 字节、5 个 style 块、无脚本。
- 本地图片为 file URL、不是 data URI，与 REA 静态证据一致；新应用使用 data URI 并保证预览/导出同源。
- MarkText 的 `EnableNodeCliInspectArguments` fuse 为 disabled，无法取得主进程句柄替换保存对话框；因此真实主进程落盘仍为 **unknown**，未计为通过。静态证据已确认其后续通道为 `mt::response-export` → `handleResponseForExport` → `dialog.showSaveDialog` → 写文件。

## 5. 行为差异与已知限制

- 新应用采用源码编辑 + 独立预览，不实现 Muya 块树、OT、跨模式哨兵光标、复杂表格/图片选区。
- 支持常用 GFM；不实现数学、Mermaid/Vega/PlantUML、Pandoc、PDF 和上传服务。
- 预览和导出主题统一是有意改进，与 MarkText 的两套主题系统不同。
- SVG 拒绝；单图最大 10 MiB；远程图片保留为外部依赖，不自动联网嵌入。
- 撤销历史不跨重启；必要文档、布局和分屏状态会恢复。
- 构建未签名，使用默认 Electron 图标。
- 早期重复打包目录 `app/release/` 中 `resources/app.asar` 仍被外部 Windows 句柄锁定，删除返回 `Device or resource busy`；正式产物在未受影响的 `app/dist/`。未强制结束系统进程。

## 5.1 修复单 02：图片兼容性

修复单：`docs/plans/2026-11-02-image-fix-02.md`。只改 `app/src/renderer/src/render/resources.ts` 的路径归一，以及（在实测确认父 CSP 阻断后）`app/src/renderer/index.html` 的根 `img-src`。

| 场景 | 修复前实测 | 修复后实测 |
| --- | --- | --- |
| `resolveWorkspaceImagePath('目录/笔记.md','../assets\\pixel.png')` | `{reason:'invalid_separator'}`，新增单测 5/6 失败 | `{path:'assets/pixel.png'}`，单测 6/6 通过 |
| `../outside\\secret.txt` 越界 | 被拒绝（`invalid_separator`） | 仍被拒绝（`outside_workspace`） |
| `C:\\secret.png` / `C:/secret.png` | `unsafe`（`blocked_scheme:c`，在绝对路径分支之前就被 scheme 检查拦下） | 不变，仍未进入本地图片流程 |
| 真实预览 `![](../assets\\pixel.png)` | iframe 中没有 `img`，只有缺失标记 | iframe `img` 为 data URI，`complete=true`、`naturalWidth=1` |
| 127.0.0.1 回环 HTTP 图片 | `img` 已生成但 `naturalWidth=0`；控制台：`violates ... "img-src 'self' data: blob:"` | `data-mdl-image="external"`、`naturalWidth=1`，无 CSP 报错；导出依赖为 `1 个远程资源` |

- 单元：`app/tests/render-resources.test.ts`（6 用例）。E2E：`app/e2e/image-compat.spec.ts`（IMG1，含本机回环 HTTP server，不访问外网）。
- 打包 EXE 实测：`.cache/verify-packaged-backslash.mjs` 通过 CDP 连接 `app/dist/win-unpacked/markdown-lite-studio.exe`，隔离工作区含 `反斜杠.md`（`assets\pixel.png`）与 `远程.md`（回环 PNG），两者均 `complete=true`、`naturalWidth=1`、`naturalHeight=1`，控制台无报错。结果 `app/test-results/packaged-backslash/packaged-verification.json`，截图 `packaged-backslash.png`、`packaged-remote.png`。
- 限制：夹具 `pixel.png` 是 1×1 像素，显示面积只有 1 px，视觉上仅为一个小点；“已显示”的证据是真实解码尺寸与 iframe 中实际存在的 `img`，不是路径解析成功。
- 远程图片的隐私语义不变：仍是外部依赖，不下载、不内嵌进导出的 HTML。

## 5.2 全应用主题与自定义壁纸

实施单：`docs/plans/2026-11-02-theme-wallpaper-orders.md`。

- T1 在 dark OS 模拟下显式浅色仍使整个外壳为白色；显式深色为深色；system 随系统双向切换。截图：`app/test-results/T1-theme-modes/theme-light.png`、`theme-dark.png`。
- T2 通过原生背景选择 IPC 读入真实 PNG，外壳和 iframe 使用相同 data URI，透明度、模糊、尺寸和位置同步；导出 HTML 与 srcdoc 逐字节一致。清除后恢复纯色，重启后模式与壁纸恢复。截图：`app/test-results/T2-theme-wallpaper/theme-wallpaper.png`。
- 壁纸只保存校验后的图像数据，不保存原文件绝对路径；支持 PNG/JPEG/GIF/WebP、最大 10 MiB，拒绝 SVG 和其他格式。
- 旧主题配置无 wallpaper 字段仍可加载；预览和导出使用同一 CSS 与资源，不把外壳主题当作预览主题。
- 最终打包 EXE 已通过 REA 启动，证据 `ev_30e4b7ac13cdf6e44e0c1bed7bd573840349fb1dcad8e1397661c4e8b05c6e2d`。

## 6. 交付证据索引

- 针对性调查：`evidence/marktext-v0.23.0-investigation.md`
- REA 原始包：`evidence/marktext-v0.23.0-rea-evidence-bundle.json`
- 架构：`docs/plans/2026-11-02-markdown-editor-design.md`
- 函数级实施：`docs/plans/2026-11-02-implementation-orders.md`
- 行为场景：`docs/plans/2026-11-02-e2e-orders.md`
- 修复：`docs/plans/2026-11-02-fix-orders-01.md`、`docs/plans/2026-11-02-image-fix-02.md`
- 主题与壁纸：`docs/plans/2026-11-02-theme-wallpaper-orders.md`
- 产品说明：`app/README.md`
- 测试与截图：`app/test-results/`
- 运行时 REA 证据：`evidence/marktext-v0.23.0-runtime-evidence.json`（6 条记录、186,609 字节；SHA-256 `a4d97316ba75c6c495c3f2a416a38b3344caba22b2f7dd5abc08807d43e340d2`）

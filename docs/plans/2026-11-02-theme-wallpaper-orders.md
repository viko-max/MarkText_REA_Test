# 实施单：全应用主题与自定义壁纸

子代理只按本单编码，不另行设计。主代理负责复验。不得修改 reference，不新增依赖。

## 1. 配置模型与向后兼容

修改 `shared/contracts.ts`、`shared/defaults.ts`、`shared/validation.ts`、`renderer/src/render/theme.ts`。

在 `ThemeConfig` 增加：

```ts
type WallpaperSize = 'cover' | 'contain' | 'repeat';
type WallpaperPosition = 'center' | 'top' | 'bottom' | 'left' | 'right';
interface WallpaperConfig {
  dataUri: string | null;
  opacity: number;       // 0–1
  blurPx: number;        // 0–20
  size: WallpaperSize;
  position: WallpaperPosition;
}
```

- `DEFAULT_THEME.wallpaper = {dataUri:null,opacity:0.35,blurPx:0,size:'cover',position:'center'}`。
- `normalizeTheme` 保留全部现有字段并规范化 wallpaper：无效 dataUri 变 null，数值 clamp，非法枚举回退默认。
- `validateThemeConfig` 对缺失 wallpaper 的旧状态使用上述默认值，不使旧配置失效。
- dataUri 只允许 null 或 `data:image/png|jpeg|gif|webp;base64,...`，最大 14,000,000 字符；拒绝 SVG、脚本和其他 MIME。
- `createDefaultWorkspaceUiState` 深复制 wallpaper，避免共享引用。

## 2. 原生壁纸选择 IPC

新增 `main/services/background-service.ts` 并接入 Services、shared channel/API、preload、main ipc。

固定 `background:choose`，无参数，主窗口 sender 校验和 noPayload 不变：

1. 原生 open dialog，只允许 png/jpg/jpeg/webp。
2. 读取用户明确选择的文件；最大 10 MiB。
3. 复用 ResourceService 的 magic-byte sniff 逻辑； sniff 与扩展必须一致，SVG/其他格式拒绝。
4. 返回 `{dataUri,mediaType,bytes,sha256}`，dataUri 为 canonical base64。
5. 取消返回 `{cancelled:true}`；成功 `{cancelled:false,wallpaper:{...}}`。
6. 不保存绝对路径，不允许 renderer 传路径。

`background-service` 可依赖窄接口 `{getWindow}`，复用 sniff 时把共享实现提取到主进程独立 image-sniff 文件，ResourceService 行为不变。

## 3. 真正的全应用浅色/深色/系统

修改 `renderer/src/main.ts`、`renderer/src/styles.css`。

新增私有 `applyThemeMode()`，在启动恢复及每次 `applyThemeLayout` 时调用：

- 根 `#app` 设置 `data-theme="light|dark|system"`。
- 根同时设置 `color-scheme: light` / `dark` / `light dark`。
- `:root` 的现有浅色变量作为 light；把当前 media dark 变量改为 `:root[data-theme='dark']` 和 `:root[data-theme='system'] @media(prefers-color-scheme:dark)` 两种规则。
- `#app[data-theme='light']` 在任何系统主题下都强制浅色，不再出现截图中的“面板写浅色但外壳深色”。
- theme accent/foreground/background 继续用现有变量；不得只改 iframe。

## 4. 壁纸 CSS 同步

修改 `renderer/src/main.ts`、`renderer/src/styles.css`、`renderer/src/render/theme.ts`。

新增 `applyWallpaper()`，在恢复及 theme change 时调用：

- `#app` 设置 `--wallpaper-image`、`--wallpaper-opacity`、`--wallpaper-blur`、`--wallpaper-size`、`--wallpaper-position`。
- `.app::before` 为绝对定位背景层，z-index 0，不接收 pointer events；顶层 UI 在 z-index 1。无 dataUri 时 `background-image:none`。
- 背景图覆盖 app 全窗口；透明度与 blur 生效；正文/面板保持可读，用现有 panel 背景，不能为显示壁纸把文字变透明。
- `buildThemeCss` 增加同名 `--mdl-wallpaper-*` 变量和 `.mdl-shell::before` 背景层，预览 iframe 与导出 HTML 使用相同 dataUri/opacity/blur/size/position；无壁纸时 HTML 与当前纯色结果一致。
- CSP 已允许 data URI，不放宽脚本。

## 5. 主题面板

修改 `renderer/src/html/theme-panel.ts` 和根 main 的 mount 调用：

- `ThemePanelOptions` 新增 `onChooseWallpaper(): Promise<WallpaperConfig['dataUri'] | null>`。
- 在背景色后增加“自定义壁纸”区：选择图片、清除、缩略预览、透明度 range(0–1, step .05)、模糊 range(0–20)、size(cover/contain/repeat)、position(center/top/bottom/left/right)。
- 根 main 的 onChooseWallpaper 调 `api.background.choose`，成功返回 dataUri，取消/失败返回 null 并保留旧壁纸；失败显示错误。
- 清除设 dataUri=null，其他设置保留。
- 所有变更仍经 validateThemeConfig 后进 onChange；同时调用 applyThemeMode/applyWallpaper、preview.setTheme 和 state.save。

## 6. 测试

新增/更新单元和 E2E：

1. 旧 theme 无 wallpaper 可校验并取默认；非法 MIME/超大 dataUri 拒绝；深复制无共享引用。
2. BackgroundService 的取消、格式、大小、真实 dataUri 和 absolute path 不进入配置。
3. `buildThemeCss` 无壁纸时保持纯色；有壁纸时包含 data URI/opacity/blur/size/position；preview/export 使用相同字符串。
4. ThemePanel 选择/清除/透明度/模糊均触发合法 onChange，非法值不进入。
5. E2E：显式 light 在 dark OS 设置下外壳仍为浅色；dark 为深色；system 随 OS。选择 fixture PNG 后外壳和 iframe 均含壁纸数据，导出 HTML 相同；清壁纸恢复纯色；重启后壁纸/模式恢复。截图保存为 `theme-light.png`、`theme-dark.png`、`theme-wallpaper.png`。

## 7. 验收

运行 `npm test`、`npm run build`、`npm run test:e2e`、`npm run package`。主代理查看真实截图和导出 HTML后确认。不得只以配置字段存在宣称功能完成。

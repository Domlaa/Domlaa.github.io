# 项目约定（Domlaa.github.io）

## 工作流偏好

- **不要在每次改动后推送 GitHub 做验证。** 用户明确要求：本地起静态服务器 + 无头浏览器（Playwright/chromium channel=chrome）把功能测完，确认无误后只做**本地提交**。
- **除非用户明确让推送，绝不主动 `git push`。** 只做本地提交即可；是否推送、何时推送由用户说了算。
- 用户要求预览时：重启本地静态服务器（后台任务）并给出本地预览地址。

## 运行与验证

- 本地预览：`python -m http.server 8123 --bind 127.0.0.1`（必须用后台任务启动，否则命令结束进程被回收）。注意 `file://` 无法加载模型。
- 验证脚本临时放在仓库外的临时目录（如 `C:\tmp\...`），不要污染站点目录；`.workbuddy/`、`.tmp*/` 已在 .gitignore 中。
- 提交前先 `node --check` 所有改动过的 JS。

## 站点结构

- 两个页面各自独立，互不依赖：`index.html`（全息拆解，armor.glb）与 `mk85.html`（实景 PBR，mk85.fbx）。
- 模型统一放 `assets/models/`；**不要用带 `+` 的文件名做 URL**（有被服务器解码成空格的风险）。
- 免构建：原生 ES Modules + importmap，third-party 全部本地化在 `lib/three/`，不引入 CDN、不引入打包步骤。

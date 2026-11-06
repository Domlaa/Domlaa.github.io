# MARK LXXXV · Web 3D 全息战甲展示系统

实时渲染的钢铁侠战甲全息投影展示页，部署于 GitHub Pages：**https://domlaa.github.io/**

![tech](https://img.shields.io/badge/Three.js-r187-7de8ff) ![tech](https://img.shields.io/badge/WebGL-2.0-7de8ff) ![tech](https://img.shields.io/badge/build-none-brightgreen)

---

## 一、这个项目做了什么

- **真实 3D 模型**：加载 `assets/models/armor.glb`（Sketchfab 钢铁侠全身精细模型，12,249 三角面），不是图片或视频。
- **单网格 → 10 个可交互模块**：原模型只有一个 mesh、节点名 `Mesh_0`，没有部件层级。系统在加载时按**顶点空间位置**把三角面切分成头盔 / 胸甲 / 能量核心 / 左右臂 / 左右手 / 左右腿 / 背部推进器，使单网格模型也能被点击、单独隐藏、拆解。
- **全息材质系统**：自定义 GLSL ShaderMaterial，含半透明青蓝基底、Fresnel 边缘发光、装甲分块网格线、从上到下的循环扫描光束、数字化显现 / 溶解、悬停与选中高亮、全息↔实体切换。
- **拆解 / 组装**：每个模块绕自身锚点位移 + 自转，位移始终基于原始位置计算（`pivot.position = basePosition + offset × 进度`），重复点击不会累积误差。
- **HUD**：系统状态、能量读数、模块列表、部件详情、底部控制栏，以及每帧投影的 SVG 指示线（跟随模型旋转，非固定屏幕坐标）。
- **性能**：单材质实例复用、补间在渲染循环内驱动（无 Vue 响应式开销）、页面隐藏暂停渲染、连续低帧率自动降级（关闭辉光、像素比降为 1）。

## 二、技术选型说明

需求文档建议 Vue 3 + TypeScript + Vite。本项目最终采用 **免构建纯静态 ES Modules**：

| 决策 | 原因 |
| --- | --- |
| 无构建步骤（不用 Vite/Vue） | 部署目标是 GitHub Pages 静态托管。免构建意味着推送到仓库即上线，不需要 Actions、不需要提交 `dist` 产物，也不会出现本地构建与线上不一致 |
| Three.js 及 addons 本地化到 `lib/three/` | 不依赖 CDN，国内访问稳定，离线可用；通过 importmap 解析 `three` 与 `three/addons/` |
| 原生 JS 模块替代 Vue 组件 | 3D 渲染循环与 HUD 更新属于高频、命令式操作；原生 DOM + 每帧投影比响应式框架更直接，也避免了"每帧触发 Vue 更新"的性能陷阱 |
| 自研 60 行补间引擎 | 替代 GSAP，去除依赖同时满足暂停 / 恢复 / 标签互斥的需求 |

模块化程度并未降低：`js/` 下按 core / model / materials / effects / animation / interaction / ui / config 分层，与需求文档的目录建议一一对应。

## 三、目录结构

```
index.html                 入口（importmap + HUD 结构）
css/hud.css                HUD 全部样式与响应式
assets/models/armor.glb    战甲模型（部署用）
lib/three/                 Three.js r187 + 本地化 addons
js/
├─ main.js                 编排：加载 → 显现 → 渲染循环
├─ config/armor.config.js  模块定义、切分阈值、拆解偏移、场景参数
├─ core/SceneManager.js    渲染器 / 相机 / OrbitControls / 辉光 / 平台网格
├─ model/
│  ├─ ModelLoader.js       GLB 加载 + 变换烘焙 + 归一化
│  ├─ ArmorSegmentation.js 三角面 → 区域切分（纯函数，可单测）
│  └─ ArmorModel.js        模块生命周期、显隐、高亮
├─ materials/HolographicMaterial.js  全息 ShaderMaterial + 线框材质
├─ effects/
│  ├─ ArcReactor.js        程序化弧光反应堆（独立模块）
│  └─ Particles.js         漂浮粒子（自定义点着色器）
├─ animation/
│  ├─ TweenEngine.js       补间引擎（可暂停 / 重置）
│  └─ ArmorExplode.js      拆解 / 组装 / 显现 / 溶解
├─ interaction/ArmorRaycaster.js  悬停与点击拾取（区分拖拽）
└─ ui/HUD.js               面板渲染 + 指示线投影 + 控制绑定
```

## 四、本地运行

纯静态，起任意静态服务器即可（需要 HTTP，`file://` 无法加载 GLB）：

```bash
npx serve .            # 或 python -m http.server 8000
```

然后打开 `http://localhost:3000`。

## 五、部署

仓库推送到 `main` 分支即生效（GitHub Pages 从根目录发布）：

```bash
git add -A && git commit -m "feat: 3D 全息战甲展示系统" && git push
```

## 六、替换为自己的模型

1. 把新的 `.glb` 放到 `assets/models/` 并修改 `armor.config.js` 中的 `MODEL_URL`；
2. 若模型姿态/比例不同，调整 `SEGMENT_THRESHOLDS`（`t = y / 高度` 的归一化阈值）；
3. 其余渲染、材质、动画、HUD 代码无需改动 —— `ArmorModel` 只对外暴露统一的模块对象集合。

切分逻辑可用 Node 单测验证：三角面守恒、各区域高度区间是否合理。

## 七、快捷键与交互

| 操作 | 效果 |
| --- | --- |
| 拖动 / 滚轮 | 旋转 / 缩放（带阻尼） |
| 点击部件 | 选中并显示技术参数，指示线高亮 |
| 点击空白 | 取消选中 |
| 悬停 | 部件高亮 |
| 底部控制栏 | 拆解 / 组装、全息 / 线框切换、扫描速度、透明度、自转速度、暂停、复位视角 |
| 左侧列表 | 点击选中；`◉` 按钮单独显示 / 隐藏该模块 |

## 八、浏览器要求

需支持 WebGL 2.0（Chrome / Edge / Firefox / Safari 15+）。不支持时会显示降级提示页。

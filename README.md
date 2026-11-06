# MARK LXXXV · Web 3D 全息战甲展示系统

实时渲染的钢铁侠战甲全息投影展示页，部署于 GitHub Pages：**https://domlaa.github.io/**

站点含两个独立页面：

| 页面 | 地址 | 模型 | 特点 |
| --- | --- | --- | --- |
| 全息拆解展示 | `/` | `assets/models/armor.glb`（1.2 万面） | 全息材质、10 模块拆解、HUD 指示线 |
| MK85 实景模型 | `/mk85.html` | `assets/models/mk85.fbx`（62 万面） | 写实 PBR 渲染、仅外部战甲（26 件）、拆解组装、材质切换、截图导出 |

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
mk85.html                  MK85 实景模型页
css/hud.css                HUD 全部样式与响应式
css/showcase.css           模型展台样式
assets/models/armor.glb    战甲模型（全息页，部署用）
assets/models/mk85.fbx     MK85 模型（实景页，19 MB）
lib/three/                 Three.js r187 + 本地化 addons
js/
├─ main.js                 编排：加载 → 显现 → 渲染循环
├─ showcase/main.js        MK85 页：FBX 加载 / 归一化 / 材质 / 取景
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

---

## 九、MK85 实景模型页（`/mk85.html`）

`assets/models/mk85.fbx` 与前一个 GLB 是两个不同来源的模型，这一页单独做，目标是**先保证稳定、正确地展示模型**，不加任何后处理特效。

### 模型情况

- 二进制 FBX 7400，19 MB，**28 个按解剖命名的部件**（`head` / `neck` / `chest` / `weist` / `hip` / `upper_arm` / `elbow` / `lower_leg` / `foot_left` …），共 624,342 三角面、187 万顶点。
- **贴图不可用**：FBX 内记录的是作者本机绝对路径（`C:\Users\jedid\Desktop\Textures\[2K]Metal002\Metal019_2K_Color.jpg`），文件未随模型提供。加载时用一张 1×1 白图顶掉这些请求，避免 404 刷屏。

### 因此做了什么

- **归一化**：按包围盒把模型缩放到统一 1.95 高度、水平居中、脚底贴地，再据此自动计算相机距离 —— 换任何尺寸单位的模型都不会跑飞或过大过小。
- **只显示外部战甲**：`inner_armor`（贯穿全身的深色内衬，64k 面）与 `neck` 属于人偶身体，默认隐藏，画面里只有 26 个装甲件（555,670 面）。拆解时看到的是纯装甲片悬浮，而不是一具黑色人偶。需要对比时点「内衬」按钮或按 `I` 可随时切换回来。
- **按部件上色**：既然贴图缺失，就利用部件名建立 `部件 → 色调` 映射（头/膝/腕/腰为金，躯干四肢为红），还原 MK85 的红金配色；另有「钢」与「哑光」两种材质用于观察造型。
- **拆解 / 组装**：26 个可见部件各自挂在锚点 `pivot` 上（`pivot.attach(mesh)` 保持世界变换，视觉零位移），拆解只改 `pivot.position`。方向按部件语义给定 —— 头向上、胸/腰/髋向前脱离、四肢向外。1.5s 缓动，位移恒基于 `base` 计算，反复拆装无累积误差（实测 3 轮偏差 0）。
- **材质与环境**：`MeshStandardMaterial` + `RoomEnvironment` 生成的 PMREM 环境贴图（金属没有环境反射会发黑），三点布光 + 方向光阴影 + 径向渐隐接影地面。
- **交互**：OrbitControls 拖拽/缩放/双击复位、自动旋转、**拆解 / 组装**、**内衬显隐**、材质切换、全屏、**保存当前画面为 PNG**（合成深色底，不含 UI）。快捷键：`空格` 旋转、`E` 拆解、`A` 组装、`M` 材质、`I` 内衬、`S` 截图、`R` 复位、`F` 全屏。
- **加载体验**：显示真实进度百分比与已下载 MB 数；失败时展示错误信息而不是白屏。
- **取景**：按「避让顶部标题、底部工具栏」后的可用区域做垂直居中（`safeTop` / `safeBottom`），窄屏自动放大留白并把工具栏改为 4 列网格（两行），窗口尺寸变化后自动重新取景。
- **加载体验**：显示真实进度百分比与已下载 MB 数；失败时展示错误信息而不是白屏。
- **取景**：窄屏（`aspect < 0.85`）自动放大留白，避免头部压住标题、脚被底部工具栏遮挡；窗口尺寸变化后自动重新取景。

### 换模型只需改两处

```js
// js/showcase/main.js 顶部
const CONFIG = { url: '../../assets/models/mk85.fbx', fileBytes: 19926540, targetHeight: 1.95, ... };

// 若新模型部件名不同，补一张映射表即可（未命中时按 leg/arm/hip 等关键词兜底）
const PART_TONE = { head: 'gold', chest: 'red', ... };

// 哪些部件属于「人偶身体」需要默认隐藏（默认是 inner_armor + neck）
const BODY_PARTS = new Set(['inner_armor', 'neck']);
```

# MARK LXXXV · Web 3D 全息战甲展示系统

实时渲染的钢铁侠战甲全息投影展示页，部署于 GitHub Pages：**https://domlaa.github.io/**

站点含两个独立页面：

| 页面 | 地址 | 模型 | 特点 |
| --- | --- | --- | --- |
| 全息拆解展示 | `/` | `assets/models/armor.glb`（1.2 万面） | 全息材质、10 模块拆解、HUD 指示线 |
| MK7 线稿渲染 | `/mk7.html` | `assets/models/armor2.glb`（14 万面） | 屏幕空间边缘检测、表面线条叠加、暗线/亮线双模式、截图导出 |

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
mk7.html                   MK VII 线稿渲染页
css/mk7.css                MK VII 页样式
css/hud.css                HUD 全部样式与响应式
assets/models/armor.glb    战甲模型（全息页，部署用）
assets/models/armor2.glb   MK VII 模型（线稿页，38 MB，含 4K PBR 贴图）
lib/three/                 Three.js r187 + 本地化 addons
js/
├─ main.js                 编排：加载 → 显现 → 渲染循环
├─ showcase7/main.js       MK7 页：三通道渲染 + 边缘检测线稿
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

## 九、MK VII 线稿渲染页（`/mk7.html`）

`assets/models/armor2.glb`（38 MB）是重新生成的模型，与前面两个都不同：**142,622 面的单件装甲**（`Iron_Man_mark_7_Subsurf_`，蒙皮网格），带 4 张 4096² 贴图。

### 这份模型的坑

- GLB 里混着三类不该渲染的东西：`Plane`（地面）、`CreationNulCrew_*`（人偶内衬）、以及 14 个躺在 x=5.2→14 的 `abbafededcd_IK_char_*`（3D 文字招牌）。不剔掉会把包围盒撑到 15 米宽，取景直接跑飞。
- **4K 贴图是 AI 生成的噪声**：法线图是杂乱划痕、基础色是红金斑块，没有连贯的装甲缝线信息。直接采样会让表面发糊、像塑料。

### 因此的渲染方案（三通道）

1. **法线通道** —— `MeshNormalMaterial` 渲染，供屏幕空间边缘检测使用
2. **颜色通道** —— `MeshStandardMaterial`，带深度纹理：
   - 反照率用 `textureLod(map, uv, 5.0)` 按 mip 降采样 → 抹掉噪声，只保留红/金色块
   - 法线贴图强度压到 0.45，只留表面起伏；再对其梯度做 UV 空间差分，压暗成刻线
   - 粗糙度随基色明度变化（金 0.21 / 深红 0.38），避免整块塑料感
3. **合成通道** —— 三重边缘检测叠加：
   - **法线边缘**：邻域法线夹角 → 硬边、装甲板缝
   - **深度边缘**：二阶差分 → 轮廓与前后遮挡
   - **亮度边缘**：贴图里烘焙的细缝
   - 再加局部对比增强，让凹槽、螺栓浮出来

暗线模式是“产品渲染 + 墨线”，亮线模式是“技术图纸 + 白描”（`L` 键切换）。线条强度与粗细都是实时滑杆。

### 其他

- **3D 空间背景（可开关，`B` 键）**：渐变穹顶 + 星尘粒子 + 环形竖向光柱 + 垂直往返扫描环（余弦缓动）+ 极坐标地面网格。背景元素全部纯加色混合、不写深度、alpha 输出为 0，法线通道中整体隐藏——合成通道用 alpha 遮罩把背景排除在亮度边缘检测与局部对比增强之外，因此背景再亮也不会产生假线稿。背景色随「线条颜色」联动。
- **流光 v2**：窄亮核 + 指数衰减拖尾；开启流光时基线线条压暗到 0.78×，脉冲峰值提到约 3.1× 线色，流光与静态线条的亮度比从约 2.1:1 拉开到约 4:1。
- **取景**：按顶部标题 / 底部工具栏的占位做垂直居中（`safeTop/safeBottom`），窄屏自动加留白；resize 后重新取景
- **接触阴影**：程序化径向渐变平面（比真实阴影干净，不受阴影视锥边界影响），法线通道中会临时隐藏
- **性能**：1440×900 @2x 下 90 FPS；连续低于 30 FPS 时自动把 DPR 降到 1
- **交互**：拖拽 / 滚轮 / 双击复位、自动旋转、线稿强度、线宽、暗线↔亮线、流光开关（G）、背景开关（B）、截图（合成深色底、不含 UI）、全屏

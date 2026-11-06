/**
 * armor.config.js — 战甲模块配置
 *
 * 分区阈值基于对 armor.glb（Sketchfab 单网格模型，高约 1.2 单位，A-pose，面向 +z）
 * 的顶点空间分析得出：t 为归一化高度 (y / H)。
 * 未来替换其他 GLB 模型时，只需在 ArmorModel 中调整 fitTuning，无需改动渲染系统。
 */

export const MODEL_URL = './assets/models/armor.glb';

export const ARMOR_NAME = 'MARK LXXXV';

/** 空间切分阈值（t = y/H，x 为左右轴，z 为前后轴，模型面向 +z） */
export const SEGMENT_THRESHOLDS = {
  helmetTop: 0.865,   // t 高于此值 → 头盔
  armX: 0.19,         // |x| 超过此值（躯干高度带内）→ 手臂区
  handTop: 0.56,      // 手臂区内 t 低于此值 → 手部（腕部切点）
  armMinT: 0.36,      // 手臂区最低高度（指尖）
  waist: 0.47,        // 躯干/大腿分界（腰部切割线）
  backZ: -0.06,       // 躯干高度带内 z 低于此值 → 背部
};

/**
 * 模块定义
 * explode: 拆解位移（相对模型总高 H 的比例），[x, y, z]
 * rotate:  拆解时的自转（弧度，绕模块锚点）
 * stagger: 拆解/显现动画的时序偏移（秒）
 */
export const MODULES = [
  {
    id: 'helmet', region: 'helmet',
    name: 'HELMET', cn: '头盔',
    desc: '钛金复合层压装甲，集成平视瞄准系统与全频段通讯阵列。面甲可在 0.3s 内完成开合。',
    stats: [
      ['装甲厚度', '4.2 mm', 0.62],
      ['抗冲击', '9.1 G', 0.91],
      ['传感器', '14 CH', 0.80],
    ],
    explode: [0, 0.34, 0], rotate: [0.16, 0, 0], stagger: 0.50,
  },
  {
    id: 'chest', region: 'chest',
    name: 'CHEST', cn: '胸甲',
    desc: '主承力装甲段，内嵌生命维持系统与飞行姿态控制器，前部搭载弧光反应堆接口。',
    stats: [
      ['装甲厚度', '6.8 mm', 0.88],
      ['结构强度', 'A级', 0.95],
      ['配重比', '18.4%', 0.55],
    ],
    explode: [0, 0.02, 0.30], rotate: [0, 0, 0], stagger: 0.30,
  },
  {
    id: 'reactor', region: null, // 程序化生成的能量核心，不从网格切分
    name: 'ARC REACTOR', cn: '能量核心',
    desc: '钯基弧光反应堆，输出功率 3.42 GJ/s，为全身装甲供能。运行时产生特征性青蓝色辉光。',
    stats: [
      ['输出功率', '3.42 GJ/s', 0.97],
      ['核心温度', '2400 K', 0.72],
      ['燃料余量', '99.2%', 0.99],
    ],
    explode: [0, 0.04, 0.46], rotate: [0, 0, 0], stagger: 0.42,
    procedural: true,
  },
  {
    id: 'armL', region: 'armL',
    name: 'LEFT ARM', cn: '左臂',
    desc: '肩肘双关节伺服驱动，臂内集成微型导弹舱与激光诱导装置。',
    stats: [
      ['伺服扭矩', '820 N·m', 0.78],
      ['响应延迟', '2.1 ms', 0.86],
      ['挂载点', '2', 0.40],
    ],
    explode: [0.30, 0.04, 0], rotate: [0, 0, -0.20], stagger: 0.18,
  },
  {
    id: 'armR', region: 'armR',
    name: 'RIGHT ARM', cn: '右臂',
    desc: '肩肘双关节伺服驱动，前臂集成掌心冲击炮导波管，峰值功率 2.1 GW。',
    stats: [
      ['伺服扭矩', '820 N·m', 0.78],
      ['冲击炮', '2.1 GW', 0.94],
      ['响应延迟', '2.1 ms', 0.86],
    ],
    explode: [-0.30, 0.04, 0], rotate: [0, 0, 0.20], stagger: 0.24,
  },
  {
    id: 'handL', region: 'handL',
    name: 'LEFT HAND', cn: '左手',
    desc: '五指全驱动灵巧手，指尖压力传感阵列可完成精细操作与武器击发。',
    stats: [
      ['自由度', '21 DOF', 0.84],
      ['握力', '1.2 kN', 0.70],
      ['触觉点', '96', 0.60],
    ],
    explode: [0.42, -0.02, 0], rotate: [0, 0, -0.32], stagger: 0.10,
  },
  {
    id: 'handR', region: 'handR',
    name: 'RIGHT HAND', cn: '右手',
    desc: '五指全驱动灵巧手，掌心集成为冲击炮发射窗口。',
    stats: [
      ['自由度', '21 DOF', 0.84],
      ['握力', '1.2 kN', 0.70],
      ['发射窗', '1', 0.90],
    ],
    explode: [-0.42, -0.02, 0], rotate: [0, 0, 0.32], stagger: 0.14,
  },
  {
    id: 'legL', region: 'legL',
    name: 'LEFT LEG', cn: '左腿',
    desc: '液压-电磁混合驱动，脚底集成辅助推进喷口与着陆缓冲结构。',
    stats: [
      ['驱动功率', '5.6 kW', 0.66],
      ['跳跃冲量', '4.8 kN·s', 0.82],
      ['装甲等级', 'B+', 0.72],
    ],
    explode: [0.19, 0, 0], rotate: [0, 0, 0.10], stagger: 0.06,
  },
  {
    id: 'legR', region: 'legR',
    name: 'RIGHT LEG', cn: '右腿',
    desc: '液压-电磁混合驱动，脚底集成辅助推进喷口与着陆缓冲结构。',
    stats: [
      ['驱动功率', '5.6 kW', 0.66],
      ['跳跃冲量', '4.8 kN·s', 0.82],
      ['装甲等级', 'B+', 0.72],
    ],
    explode: [-0.19, 0, 0], rotate: [0, 0, -0.10], stagger: 0.03,
  },
  {
    id: 'back', region: 'back',
    name: 'BACK UNIT', cn: '背部推进器',
    desc: '背负式双联推进单元，巡航推力 2×8.7 kN，集成姿态微调矢量喷口。',
    stats: [
      ['推进推力', '2×8.7 kN', 0.90],
      ['续航', '38 min', 0.58],
      ['矢量喷口', '4', 0.76],
    ],
    explode: [0, 0.02, -0.32], rotate: [-0.14, 0, 0], stagger: 0.36,
  },
];

/** 相机与场景 */
export const SCENE_CONFIG = {
  cameraFov: 40,
  cameraPos: [1.75, 1.42, 2.95],
  target: [0, 0.62, 0],
  minDistance: 1.1,
  maxDistance: 6.5,
  autoSpin: 0.18,        // 默认自转 rad/s（滑条 30/100）
  bloom: { strength: 0.42, radius: 0.55, threshold: 0.82 },
  particles: 420,
  bg: 0x030912,
};

/**
 * ArcReactor.js — 程序化能量核心
 *
 * 由于 GLB 模型是单网格（无独立核心部件），弧光反应堆由几何体 + 辉光 Sprite 程序化生成，
 * 作为一个独立模块挂载到 ArmorModel 的模块管理体系（可选中、可拆解、可显隐）。
 */
import * as THREE from 'three';
import { HolographicMaterial, WireMaterial } from '../materials/HolographicMaterial.js';

export class ArcReactor {
  /**
   * @param {THREE.Vector3} position 模型坐标中的安装位置（胸甲前方）
   */
  constructor(position) {
    const def = {
      id: 'reactor',
      name: 'ARC REACTOR',
      cn: '能量核心',
    };
    const mat = new HolographicMaterial('reactor');
    this.material = mat;
    this.def = {
      id: 'reactor',
      region: null,
      name: 'ARC REACTOR',
      cn: '能量核心',
      desc: '钯基弧光反应堆，输出功率 3.42 GJ/s，为全身装甲供能。运行时产生特征性青蓝色辉光。',
      stats: [
        ['输出功率', '3.42 GJ/s', 0.97],
        ['核心温度', '2400 K', 0.72],
        ['燃料余量', '99.2%', 0.99],
      ],
      explode: [0, 0.04, 0.46],
      rotate: [0, 0, 0],
      stagger: 0.42,
      procedural: true,
    };

    const group = new THREE.Group();

    // 主体圆盘（自发光青白）
    const discMat = new THREE.MeshBasicMaterial({
      color: 0xd9faff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.045, 40), discMat);
    group.add(disc);

    // 三角形内环（标记环）
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x8ef2ff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.052, 0.062, 10, 1), ringMat);
    group.add(ring);

    // 外圈光环
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x35d5ff,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.068, 0.085, 40), haloMat);
    group.add(halo);

    // 辉光 Sprite
    const glowTex = makeGlowTexture();
    const glowMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0x6ee6ff,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.glow = new THREE.Sprite(glowMat);
    this.glow.scale.setScalar(0.2);
    group.add(this.glow);

    // 光源（照亮周围，主要产生氛围）
    this.light = new THREE.PointLight(0x55dcff, 2.2, 1.6, 2);
    group.add(this.light);

    group.position.copy(position);

    // 挂载结构与 ArmorModel 的模块约定一致：pivot 在锚点，内容反向偏移
    const pivot = new THREE.Group();
    pivot.position.copy(position);
    group.position.set(0, 0, 0);
    pivot.add(group);

    this.pivot = pivot;
    this.id = 'reactor';
    this.def = this.def;
    this.anchor = position.clone();
    this.basePosition = position.clone();
    this.mesh = disc; // 拾取目标
    this.wire = null;
    this.visible = true;
    this.explodeT = 0;
    this.revealT = 0;
    this.hoverT = 0;
    this.selectT = 0;
    this.tris = 120;

    // 拾取辅助：给一个稍大的透明拾取面（位于 pivot 局部原点）
    const pickMat = new THREE.MeshBasicMaterial({ visible: false });
    this.pickMesh = new THREE.Mesh(new THREE.CircleGeometry(0.1, 12), pickMat);
    pivot.add(this.pickMesh);
  }

  /** 每帧脉动 */
  update(dt, time) {
    const pulse = 0.75 + 0.25 * Math.sin(time * 2.6);
    const burst = Math.pow(0.5 + 0.5 * Math.sin(time * 0.9), 8) * 0.6; // 周期性爆发
    const glowScale = 0.16 + 0.05 * pulse + burst * 0.12;
    this.glow.scale.setScalar(glowScale);
    this.glow.material.opacity = 0.55 + 0.3 * pulse;
    this.light.intensity = 1.8 + 1.2 * pulse + burst * 4;

    if (this.material) {
      this.material.setHighlight(this.hoverT, this.selectT);
      this.material.setReveal(this.revealT);
    }
    // 选中时外环旋转
    this.pivot.children.forEach((c) => {
      if (c.geometry && c.geometry.type === 'RingGeometry') c.rotation.z += dt * (this.selectT > 0.5 ? 2.0 : 0.4);
    });
  }

  dispose() {
    this.pivot.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}

/** 径向渐变辉光贴图 */
function makeGlowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(160,240,255,0.85)');
  g.addColorStop(0.6, 'rgba(70,200,255,0.28)');
  g.addColorStop(1, 'rgba(0,180,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * SceneManager.js — 场景 / 相机 / 渲染器 / 线条后期 / 全息舞台
 *
 * 渲染走 EdgePass 三通道（法线 / 颜色+深度 / 合成），因此不再需要 EffectComposer 辉光：
 * 线条本身由边缘检测产生，亮度已经在合成通道里拉开。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SCENE_CONFIG } from '../config/armor.config.js';
import { EdgePass } from './EdgePass.js';

export function isWebGL2Available() {
  try {
    const canvas = document.createElement('canvas');
    return !!(window.WebGL2RenderingContext && canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

export class SceneManager {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(SCENE_CONFIG.bg, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(SCENE_CONFIG.bg, 0.09);

    this.camera = new THREE.PerspectiveCamera(
      SCENE_CONFIG.cameraFov,
      window.innerWidth / window.innerHeight,
      0.05,
      120,
    );

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;
    this.controls.maxPolarAngle = Math.PI * 0.58;
    this.controls.rotateSpeed = 0.75;

    // 灯（暗色底材依靠微弱明暗交代体块）
    this.scene.add(new THREE.HemisphereLight(0x2f5f7a, 0x030a10, 0.85));
    const key = new THREE.DirectionalLight(0xbfeaff, 1.1);
    key.position.set(2.4, 3.2, 2.6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x3f86c8, 0.8);
    rim.position.set(-2.2, 1.4, -2.4);
    this.scene.add(rim);

    // 线条 + 流光合成通道
    this.edge = new EdgePass(this.renderer, {
      ...SCENE_CONFIG.line,
      bg: SCENE_CONFIG.bg,
    });

    this.stageGroup = new THREE.Group();
    this.scene.add(this.stageGroup);

    this.time = 0;
    this._fit = { dist: 4, targetY: 1 };

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  /* ---------------- 舞台（随模型尺寸缩放） ---------------- */
  buildStage(box) {
    const H = box.h;
    const R = Math.max(box.w, box.h) * 0.72;

    // 地面极坐标网格
    const grid = new THREE.PolarGridHelper(H * 1.05, 12, 6, 96, 0x1f5f7a, 0x0d3145);
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    grid.material.depthWrite = false;
    grid.position.y = 0.0008 * H;
    this.stageGroup.add(grid);

    // 内圈亮环 + 细描边
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x4fd2ff, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const inner = new THREE.Mesh(new THREE.RingGeometry(R * 0.68, R * 0.684, 96), ringMat);
    inner.rotation.x = -Math.PI / 2;
    this.stageGroup.add(inner);

    const outerMat = ringMat.clone();
    outerMat.opacity = 0.22;
    const outer = new THREE.Mesh(new THREE.RingGeometry(R * 0.995, R, 96), outerMat);
    outer.rotation.x = -Math.PI / 2;
    this.stageGroup.add(outer);

    // 放射刻度
    const spokes = 72;
    const pts = [];
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2;
      const long = i % 6 === 0;
      const r0 = R * (long ? 0.9 : 0.955);
      pts.push(Math.cos(a) * r0, 0.001, Math.sin(a) * r0);
      pts.push(Math.cos(a) * R * 0.995, 0.001, Math.sin(a) * R * 0.995);
    }
    const spokeGeo = new THREE.BufferGeometry();
    spokeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const spokeMesh = new THREE.LineSegments(spokeGeo, new THREE.LineBasicMaterial({
      color: 0x4fd2ff, transparent: true, opacity: 0.20,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.stageGroup.add(spokeMesh);

    // 地面辉光
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(R, 64),
      new THREE.MeshBasicMaterial({
        color: 0x0a3f57, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -0.001 * H;
    this.stageGroup.add(glow);

    this._stageR = R;
  }

  /* ---------------- 取景 ---------------- */
  /** 舞台区（中央网格格）：模型只在这一块里取景 */
  _stageRect() {
    const st = document.querySelector('.stage');
    const r = st ? st.getBoundingClientRect() : null;
    if (r && r.width > 40 && r.height > 40) return r;
    return { left: 0, top: 60, width: window.innerWidth, height: window.innerHeight - 160 };
  }

  /**
   * 把模型放进舞台区并垂直居中。
   * @param {{w:number,h:number,d:number}} box
   */
  frame(box) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const vFov = THREE.MathUtils.degToRad(SCENE_CONFIG.cameraFov);
    const st = this._stageRect();
    const visW = st.width;
    const visH = st.height;

    const halfTan = Math.tan(vFov / 2);
    const dV = (box.h / 2) / halfTan * (vh / visH);
    const dH = (box.w / 2) / (halfTan * this.camera.aspect) * (vw / visW);
    const dist = Math.max(dV, dH) * SCENE_CONFIG.fitScale;

    const pxPerUnit = vh / (2 * halfTan * dist);
    // 舞台中心比视口中心偏上时，视线目标要相应下移，模型才会落在舞台里
    const shiftPx = vh / 2 - (st.top + visH / 2);

    this._fit.dist = dist;
    this._fit.targetY = box.h * 0.5 - shiftPx / pxPerUnit;

    this.controls.minDistance = dist * 0.42;
    this.controls.maxDistance = dist * 2.3;
    this.edge.setBand(st.left / vw, (st.left + st.width) / vw);
    return this._fit;
  }

  /** 默认视角（斜前方） */
  resetView(tweens) {
    const fit = this._fit;
    const dir = new THREE.Vector3(0.24, 0.08, 1).normalize();
    const p1 = new THREE.Vector3(0, fit.targetY, 0).addScaledVector(dir, fit.dist);
    const t1 = new THREE.Vector3(0, fit.targetY, 0);

    if (!tweens) {
      this.camera.position.copy(p1);
      this.controls.target.copy(t1);
      this.controls.update();
      return;
    }
    const p0 = this.camera.position.clone();
    const t0 = this.controls.target.clone();
    tweens.add({
      tag: 'resetView',
      duration: 1.0,
      ease: 'inOutCubic',
      onUpdate: (_r, e) => {
        this.camera.position.lerpVectors(p0, p1, e);
        this.controls.target.lerpVectors(t0, t1, e);
      },
    });
  }

  /** 相机推拉（拆解时后拉让出空间） */
  zoom(factor, tweens, duration = 1.2) {
    const target = this.controls.target.clone();
    const p0 = this.camera.position.clone();
    const dir = p0.clone().sub(target);
    const d0 = dir.length();
    const d1 = this._fit.dist * factor;
    if (d0 < 1e-3) return;
    dir.normalize();
    this.controls.minDistance = Math.min(this.controls.minDistance, d1 * 0.9);
    tweens.add({
      tag: 'zoom',
      duration,
      ease: 'inOutCubic',
      onUpdate: (_r, e) => {
        this.camera.position.copy(target).addScaledVector(dir, d0 + (d1 - d0) * e);
      },
    });
  }

  /** 低性能降级：像素比降到 1 */
  degrade() {
    if (this.degraded) return;
    this.degraded = true;
    this.renderer.setPixelRatio(1);
    this.resize();
    console.info('[Render] 检测到低帧率，已自动降级（像素比 1）');
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.edge.setSize(w, h, this.renderer.getPixelRatio());
    this.edge.sync(this.camera);
    const st = this._stageRect();
    this.edge.setBand(st.left / w, (st.left + st.width) / w);
  }

  /**
   * 每帧渲染
   * @param {object} opts { armorRoot, highlight, hide }
   */
  render(opts = {}) {
    this.controls.update();
    this.edge.setTime(this.time);
    this.edge.render(this.scene, this.camera, {
      hide: [this.stageGroup, ...(opts.hide || [])],
      armorRoot: opts.armorRoot,
      highlight: opts.highlight,
    });
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.controls.dispose();
    this.edge.dispose();
    this.renderer.dispose();
  }
}

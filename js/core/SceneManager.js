/**
 * SceneManager.js — 场景 / 相机 / 渲染器 / 辉光后期 / 环境网格
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SCENE_CONFIG } from '../config/armor.config.js';

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(SCENE_CONFIG.bg, 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SCENE_CONFIG.bg);
    this.scene.fog = new THREE.FogExp2(SCENE_CONFIG.bg, 0.12);

    this.camera = new THREE.PerspectiveCamera(
      SCENE_CONFIG.cameraFov,
      window.innerWidth / window.innerHeight,
      0.05,
      60,
    );
    this.camera.position.set(...SCENE_CONFIG.cameraPos);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(...SCENE_CONFIG.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = SCENE_CONFIG.minDistance;
    this.controls.maxDistance = SCENE_CONFIG.maxDistance;
    this.controls.maxPolarAngle = Math.PI * 0.62;
    this.controls.enablePan = false;

    // 辉光后期
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      SCENE_CONFIG.bloom.strength,
      SCENE_CONFIG.bloom.radius,
      SCENE_CONFIG.bloom.threshold,
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // 灯光（主要供实体模式与反应堆点光）
    this.scene.add(new THREE.HemisphereLight(0x3a5a72, 0x050a10, 0.7));
    const key = new THREE.DirectionalLight(0xbfeaff, 0.9);
    key.position.set(2, 3, 2.5);
    this.scene.add(key);

    this._buildPlatform();
    this._buildBackdropGrid();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  /** 脚下全息平台：同心圆 + 放射网格 */
  _buildPlatform() {
    const group = new THREE.Group();

    const ringGeo = new THREE.RingGeometry(0.62, 0.645, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x2fb9e6, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);

    const ring2 = new THREE.Mesh(new THREE.RingGeometry(0.86, 0.868, 64), ringMat.clone());
    ring2.material.opacity = 0.25;
    ring2.rotation.x = -Math.PI / 2;
    group.add(ring2);

    // 放射线
    const spokes = 48;
    const spokeGeo = new THREE.BufferGeometry();
    const pts = [];
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2;
      pts.push(Math.cos(a) * 0.65, 0.001, Math.sin(a) * 0.65);
      pts.push(Math.cos(a) * 0.86, 0.001, Math.sin(a) * 0.86);
    }
    spokeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const spokesMesh = new THREE.LineSegments(spokeGeo, new THREE.LineBasicMaterial({
      color: 0x2fb9e6, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    group.add(spokesMesh);

    // 地面微光圆盘
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(0.9, 48),
      new THREE.MeshBasicMaterial({
        color: 0x0c4a66, transparent: true, opacity: 0.18,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -0.002;
    group.add(glow);

    this.platform = group;
    this.scene.add(group);
  }

  /** 远景科技网格（细线地面网格） */
  _buildBackdropGrid() {
    const grid = new THREE.GridHelper(30, 60, 0x0f3a52, 0x0a2436);
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    grid.material.depthWrite = false;
    grid.position.y = -0.01;
    this.scene.add(grid);
  }

  /** 恢复默认视角 */
  resetView(tweens) {
    const cam = this.camera, ctl = this.controls;
    const p0 = cam.position.clone();
    const t0 = ctl.target.clone();
    const p1 = new THREE.Vector3(...SCENE_CONFIG.cameraPos);
    const t1 = new THREE.Vector3(...SCENE_CONFIG.target);
    tweens.add({
      tag: 'resetView',
      duration: 1.1,
      ease: 'inOutCubic',
      onUpdate: (_r, e) => {
        cam.position.lerpVectors(p0, p1, e);
        ctl.target.lerpVectors(t0, t1, e);
      },
    });
  }

  /** 低性能降级：关闭辉光、降低像素比 */
  degrade() {
    if (this.degraded) return;
    this.degraded = true;
    this.bloom.enabled = false;
    this.renderer.setPixelRatio(1);
    this.composer.setPixelRatio(1);
    this.resize();
    console.info('[Render] 检测到低帧率，已自动降级（关闭辉光 / 像素比 1）');
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  /** 每帧渲染 */
  render() {
    this.controls.update();
    this.composer.render();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.controls.dispose();
    this.renderer.dispose();
  }
}

/**
 * HolographicMaterial.js — 全息材质系统
 *
 * 1. HolographicMaterial：自定义 ShaderMaterial
 *    - 青蓝色半透明基底 + 表面细纹
 *    - Fresnel 边缘发光（随视角）
 *    - 水平扫描光束（uScanY 由外部驱动，速度可调）
 *    - 数字化显现 / 溶解（uReveal + 体素噪声 discard）
 *    - 悬停 / 选中高亮（独立强度）
 *    - 全息 ↔ 实体模式切换
 * 2. WireMaterial：共享的线框叠加材质
 *
 * 全局 uniforms（时间 / 扫描 / 透明度 / 线速度）在所有模块材质间共享引用，
 * 一次更新作用于整个战甲；每个模块单独持有 reveal / highlight 状态。
 */
import * as THREE from 'three';

/* ---------- 共享全局 uniforms ---------- */
const globalUniforms = {
  uTime:      { value: 0 },
  uScanY:     { value: -0.1 },   // 扫描线归一化高度（-0.1 → 1.15 循环）
  uOpacity:   { value: 0.55 },   // 透明度滑条
  uHolo:      { value: 1 },      // 1=全息 0=实体
  uHeight:    { value: 1.2 },    // 模型总高（局部 y 归一化用）
};

const VERT = /* glsl */`
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vPosL;
  void main() {
    vPosL = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform float uScanY;
  uniform float uOpacity;
  uniform float uHolo;
  uniform float uHeight;

  uniform float uReveal;    // 0 隐藏 → 1 完整显现
  uniform float uHover;
  uniform float uSelect;

  uniform vec3  uColor;      // 基底青蓝
  uniform vec3  uEdgeColor;  // Fresnel 边缘
  uniform vec3  uScanColor;  // 扫描光束
  uniform vec3  uSolidColor; // 实体模式颜色

  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vPosL;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    // ---------- 数字化显现 / 溶解 ----------
    float rev = mix(-0.25, 1.15, clamp(uReveal, 0.0, 1.0));
    float noise = hash13(floor(vPosL * 34.0));
    if (noise > rev) discard;
    float frontier = 1.0 - smoothstep(rev - 0.14, rev, noise); // 显现前沿辉光

    float t = clamp(vPosL.y / uHeight, 0.0, 1.0); // 归一化身高

    // ---------- 扫描光束 ----------
    float d = abs(t - uScanY);
    float scan = smoothstep(0.085, 0.0, d);
    float scanTrail = smoothstep(0.28, 0.0, d) * 0.35; // 余晖

    // ---------- 表面细纹（全息扫描纹理） ----------
    float fine = smoothstep(0.90, 1.0, sin(vPosL.y * 150.0)) * 0.05;
    fine += smoothstep(0.93, 1.0, sin(vPosL.y * 31.0 + vPosL.x * 22.0)) * 0.04;
    // 装甲分块网格：水平环线 + 纵向经线（比三角形线框更像装甲板缝）
    float band = smoothstep(0.955, 1.0, sin(vPosL.y * 210.0));
    float meridian = smoothstep(0.972, 1.0, sin(atan(vPosL.z, vPosL.x) * 34.0));
    float panelLines = max(band * 0.55, meridian * 0.75) * 0.30;

    // ---------- Fresnel 边缘发光 ----------
    vec3 viewDir = normalize(cameraPosition - vPosW);
    vec3 nrm = normalize(vNormalW);
    float fresnel = pow(1.0 - abs(dot(nrm, viewDir)), 2.6);

    // ---------- 全息闪烁 ----------
    float flicker = 0.96 + 0.04 * sin(uTime * 31.0) * sin(uTime * 17.3 + 1.7);

    // ---------- 颜色合成 ----------
    float facing = abs(dot(nrm, viewDir));
    vec3 holo = uColor * (0.10 + fine * 0.55 + panelLines) * (0.45 + 0.55 * facing)
              + uEdgeColor * fresnel * (0.55 + uSelect * 0.30 + uHover * 0.12)
              + uScanColor * (scan * 0.85 + scanTrail * 0.45)
              + uEdgeColor * frontier * 1.1;

    // 实体模式：简单半兰伯特光照
    vec3 lightDir = normalize(vec3(0.5, 0.9, 0.7));
    float diff = 0.35 + 0.65 * max(dot(nrm, lightDir), 0.0);
    vec3 solid = uSolidColor * diff + uEdgeColor * fresnel * 0.12 * (1.0 - uHolo);

    vec3 color = mix(holo * flicker, solid, 1.0 - uHolo);

    // ---------- 高亮 ----------
    color += uEdgeColor * (uSelect * 0.22 + uHover * 0.08) * uHolo;

    // ---------- 透明度 ----------
    float alpha = mix(
      uOpacity * (0.10 + fresnel * 0.44 + scan * 0.5 + panelLines * 1.2 + frontier * 0.6) * flicker,
      1.0,
      1.0 - uHolo
    );
    alpha = clamp(alpha + uSelect * 0.18 + uHover * 0.08, 0.0, 1.0);

    gl_FragColor = vec4(color, alpha);
  }
`;

export class HolographicMaterial {
  /**
   * @param {string} moduleId 用于调色（能量核心等特殊模块可覆盖颜色）
   */
  constructor(moduleId) {
    const reactor = moduleId === 'reactor';
    this.uniforms = {
      // 共享（引用全局对象，一处更新全体生效）
      uTime: globalUniforms.uTime,
      uScanY: globalUniforms.uScanY,
      uOpacity: globalUniforms.uOpacity,
      uHolo: globalUniforms.uHolo,
      uHeight: globalUniforms.uHeight,
      // 模块私有
      uReveal: { value: 0 },
      uHover: { value: 0 },
      uSelect: { value: 0 },
      uColor: { value: new THREE.Color(reactor ? 0x9ff4ff : 0x1ec8ff) },
      uEdgeColor: { value: new THREE.Color(reactor ? 0xffffff : 0x8ef2ff) },
      uScanColor: { value: new THREE.Color(0xbdf6ff) },
      uSolidColor: { value: new THREE.Color(0x6e7a88) }, // 实体模式：枪灰金属
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
    });
  }

  setHighlight(hover, select) {
    this.uniforms.uHover.value = hover;
    this.uniforms.uSelect.value = select;
  }

  setReveal(v) { this.uniforms.uReveal.value = v; }

  setHologram(on) { globalUniforms.uHolo.value = on ? 1 : 0; }

  setOpacity(v) { globalUniforms.uOpacity.value = v; }

  updateTime(t) { /* 共享 uniform，由 SceneEffects 统一驱动 */ }

  dispose() { this.material.dispose(); }

  /** 全局共享 uniforms（渲染循环里更新） */
  static get globals() { return globalUniforms; }
}

/* ---------- 线框叠加材质（全部模块共享一个实例） ---------- */
export class WireMaterial {
  static _instance = null;
  static enabled = true;

  static instance() {
    if (!this._instance) {
      this._instance = new THREE.MeshBasicMaterial({
        color: 0xaef4ff,
        wireframe: true,
        transparent: true,
        opacity: 0.07,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
    }
    return this._instance;
  }

  static setOpacity(v) {
    if (this._instance) this._instance.opacity = v;
  }
}

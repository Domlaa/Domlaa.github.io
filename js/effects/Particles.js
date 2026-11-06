/**
 * Particles.js — 环境粒子系统
 *
 * 战甲周围漂浮的数字化粒子：
 *  - 圆柱空间内随机分布，缓慢上浮 + 左右摆动
 *  - 少量粒子绑定在模型表面附近（沿表面缓慢环绕）
 *  - 亮度 / 大小随机，加法混合 + 辉光
 */
import * as THREE from 'three';

const VERT = /* glsl */`
  attribute float aSize;
  attribute float aSeed;
  attribute float aBright;
  uniform float uTime;
  uniform float uPixelRatio;
  varying float vBright;
  varying float vSeed;

  void main() {
    vec3 p = position;
    float t = uTime * (0.14 + aSeed * 0.22);
    // 缓慢上浮（循环）
    p.y = mod(p.y + t * 0.14, 1.85);
    // 水平漂移
    p.x += sin(uTime * (0.3 + aSeed) + aSeed * 6.28) * 0.05;
    p.z += cos(uTime * (0.24 + aSeed * 0.7) + aSeed * 9.4) * 0.05;
    // 环绕粒子绕轴旋转
    float ang = uTime * (0.05 + aSeed * 0.1);
    float c = cos(ang), s = sin(ang);
    p.xz = mat2(c, -s, s, c) * p.xz;

    vBright = aBright * (0.6 + 0.4 * sin(uTime * (1.2 + aSeed * 2.0) + aSeed * 20.0));
    vSeed = aSeed;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * uPixelRatio * (3.2 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  precision mediump float;
  uniform vec3 uColor;
  varying float vBright;
  varying float vSeed;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float a = smoothstep(0.5, 0.05, d);
    // 少数粒子呈十字闪光
    if (vSeed > 0.92) {
      a = max(a, smoothstep(0.03, 0.0, abs(uv.x)) + smoothstep(0.03, 0.0, abs(uv.y)));
    }
    gl_FragColor = vec4(uColor, a * vBright * 0.85);
    if (gl_FragColor.a < 0.01) discard;
  }
`;

export class ParticleField {
  constructor(count = 420, height = 1.2) {
    this.count = count;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const seeds = new Float32Array(count);
    const brights = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const r = 0.25 + Math.random() * 0.75;
      const ang = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(ang) * r;
      positions[i * 3 + 1] = Math.random() * 1.85;        // 循环高度范围
      positions[i * 3 + 2] = Math.sin(ang) * r;
      sizes[i] = 1.2 + Math.random() * 3.2;
      seeds[i] = Math.random();
      brights[i] = 0.25 + Math.random() * 0.75;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geo.setAttribute('aBright', new THREE.BufferAttribute(brights, 1));
    // 粒子跟随模型自转（挂在 armorGroup 内）但自己不参与拆解
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.2);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        uColor: { value: new THREE.Color(0x7de8ff) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.renderOrder = 3;
    this.points.frustumCulled = false;
  }

  update(dt, time) {
    this.material.uniforms.uTime.value = time;
  }

  setPixelRatio(r) {
    this.material.uniforms.uPixelRatio.value = Math.min(r, 2);
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

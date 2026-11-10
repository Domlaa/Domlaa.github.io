/**
 * EdgePass.js — 线条 + 流光合成通道
 *
 * 三通道管线（与 mk7.html 同一套思路，首页单独封装）：
 *   1. 法线通道 —— MeshNormalMaterial 渲染，屏幕空间法线差 → 折线 / 轮廓
 *   2. 颜色通道 —— 装甲暗色底材 + 3D 背景，附带深度纹理 → 深度边缘 / 亮度细缝
 *   3. 合成通道 —— 三重边缘检测 → 线条着色 → 垂直流光脉冲 → 数字化构建擦除
 *
 * 附加：高亮遮罩通道（只画悬停 / 选中的模块），让 HUD 选中态在纯线稿画面里也看得见。
 */

import * as THREE from 'three';

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const QUAD_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D tColor, tNormal, tDepth, tMask;
  uniform vec2  uTexel, uBandX;
  uniform float uStrength, uThickness, uNormalW, uDepthW, uLumW, uDetail, uSurface;
  uniform float uTime, uFlow, uFlowSpeed, uWipe, uNear, uFar;
  uniform vec3  uLineColor;

  float linDepth(vec2 uv) {
    float z = texture2D(tDepth, uv).x;
    float ndc = z * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
  }
  vec3 nrm(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
  float lum(vec2 uv) { return dot(texture2D(tColor, uv).rgb, vec3(0.2126, 0.7152, 0.0722)); }

  void main() {
    vec2 o = uTexel * uThickness;
    vec4 src = texture2D(tColor, vUv);
    vec3 col = src.rgb;

    // 装甲遮罩：靠深度判断而不是颜色 alpha —— 反应堆 / 粒子这类加色元素
    // 虽然不写深度，但 alpha 接近 1，用 alpha 当遮罩会被误当成装甲压暗。
    float dRaw = texture2D(tDepth, vUv).x;
    float armorMask = step(dRaw, 0.9995);

    // 表面控制：去饱和 + 压暗（0 = 纯线稿底色，1 = 原样）
    // 只作用于装甲本体（有深度写入的像素）；3D 背景 / 反应堆 / 粒子这些加色发光元素
    // 原样保留，否则会被一并压成灰白。
    {
      float g = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float s = mix(1.0, uSurface, armorMask);
      col = mix(vec3(g), col, s) * mix(0.14, 1.0, s);
    }

    // ---------- 法线边缘 ----------
    vec3 nC = nrm(vUv);
    float nEdge = 0.0;
    nEdge = max(nEdge, 1.0 - dot(nC, nrm(vUv + vec2(o.x, 0.0))));
    nEdge = max(nEdge, 1.0 - dot(nC, nrm(vUv - vec2(o.x, 0.0))));
    nEdge = max(nEdge, 1.0 - dot(nC, nrm(vUv + vec2(0.0, o.y))));
    nEdge = max(nEdge, 1.0 - dot(nC, nrm(vUv - vec2(0.0, o.y))));
    nEdge = smoothstep(0.14, 0.58, nEdge);

    // ---------- 深度边缘（二阶差分，抑制掠射面误判） ----------
    float dC = linDepth(vUv);
    float lap = abs(linDepth(vUv - vec2(o.x, 0.0)) + linDepth(vUv + vec2(o.x, 0.0)) - 2.0 * dC)
              + abs(linDepth(vUv + vec2(0.0, o.y)) + linDepth(vUv - vec2(0.0, o.y)) - 2.0 * dC);
    float dEdge = smoothstep(0.0012, 0.010, lap / max(dC, 1e-4));

    // ---------- 亮度边缘（装甲表面细缝） ----------
    float mask = armorMask;
    float lxC = lum(vUv);
    float lx = lum(vUv + vec2(o.x, 0.0)) - lum(vUv - vec2(o.x, 0.0));
    float ly = lum(vUv + vec2(0.0, o.y)) - lum(vUv - vec2(0.0, o.y));
    float lumEdge = smoothstep(0.04, 0.24, length(vec2(lx, ly))) * mask;

    // 局部对比：让凹槽 / 螺栓浮出来（仅装甲本体）
    float blur = 0.25 * (lum(vUv + vec2(o.x, o.y) * 2.0) + lum(vUv + vec2(-o.x, o.y) * 2.0)
                       + lum(vUv + vec2(o.x, -o.y) * 2.0) + lum(vUv + vec2(-o.x, -o.y) * 2.0));
    col *= clamp(1.0 + (lxC - blur) * uDetail * mask, 0.35, 2.2);

    float edge = clamp(nEdge * uNormalW + dEdge * uDepthW + lumEdge * uLumW, 0.0, 1.0) * uStrength;

    // ---------- 高亮（悬停 / 选中模块） ----------
    float hi = texture2D(tMask, vUv).r;
    if (hi > 0.001) {
      col = mix(col, uLineColor * 0.24, hi * 0.42 * (0.85 + 0.15 * sin(uTime * 3.0)));
      edge *= 1.0 + hi * 1.15;
    }

    // 表面压暗后暗线会不可见：表面越暗，线条自动越亮
    float lineLight = 1.0 - smoothstep(0.0, 0.55, uSurface);

    // ---------- 流光：柔和渐变的扫描带 ----------
    // fy = 0 是扫描头；沿 +y 上行时，已扫过的一侧落在 fy→1。
    // 「前沿高斯 + 向下长指数拖尾」取 max：两者在 fy=0 / fy=1 处数值接近，
    // 衔接连续不会出现硬边；再用 smoothstep 做一次 S 形柔化。
    float fy = fract(vUv.y - uTime * uFlowSpeed);   // 1.0 = one band per screen height
    float head = exp(-pow(fy * 14.0, 2.0));        // leading core (fast falloff upward)
    float trail = exp(-(1.0 - fy) * 7.0);          // long trail below (already swept)
    float band = smoothstep(0.02, 1.0, max(head, trail));
    float pulse = clamp(band, 0.0, 1.0) * uFlow;

    vec3 ink = vec3(0.012, 0.017, 0.024);
    float baseDim = mix(1.0, 0.78, clamp(uFlow, 0.0, 1.0));
    vec3 lineCol = mix(ink, uLineColor * baseDim, lineLight);
    vec3 pulseCol = uLineColor * (1.06 + 0.82 * pulse);
    lineCol = mix(lineCol, pulseCol, pulse);
    col = mix(col, lineCol, edge * mix(0.94, 0.55, lineLight) * (1.0 + pulse * 0.12));
    // 扫描带在装甲表面留一层极淡辉光，让明暗过渡更柔（仅装甲本体）
    col += uLineColor * pulse * 0.075 * armorMask;

    // ---------- 数字化构建擦除（自下而上） ----------
    // uWipe = 1 时完全显现；< 1 时前沿以上被擦掉，前沿留一条亮线
    if (uWipe < 0.999) {
      float wpos = -0.06 + uWipe * 1.12;
      float d = vUv.y - wpos;
      float pending = smoothstep(0.0, 0.05, d);
      // 前沿亮线只在中列舞台范围内、且优先落在装甲上（避免横贯全屏）
      float hx = smoothstep(uBandX.x - 0.03, uBandX.x + 0.05, vUv.x)
               * (1.0 - smoothstep(uBandX.y - 0.05, uBandX.y + 0.03, vUv.x));
      float front = exp(-pow(d * 46.0, 2.0)) * hx * mix(0.18, 1.0, armorMask);
      col = col * (1.0 - pending) + uLineColor * front * 1.05;
    }

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export class EdgePass {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} [cfg] 初值：strength / width / flow / flowSpeed / surface / color / bg
   */
  constructor(renderer, cfg = {}) {
    this.renderer = renderer;
    this.cfg = {
      strength: 0.95, width: 1.1, flow: 0.9, flowSpeed: 0.22,
      surface: 0.22, color: 0x9fe8ff, bg: 0x030912, ...cfg,
    };

    this._normalMat = new THREE.MeshNormalMaterial({ side: THREE.FrontSide });
    this._maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });

    const s = renderer.getDrawingBufferSize(new THREE.Vector2());
    this._depthTex = new THREE.DepthTexture(s.x, s.y, THREE.UnsignedIntType);
    this._depthTex.format = THREE.DepthFormat;

    this.beautyRT = new THREE.WebGLRenderTarget(s.x, s.y, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType, depthTexture: this._depthTex, depthBuffer: true,
    });
    this.normalRT = new THREE.WebGLRenderTarget(s.x, s.y, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.HalfFloatType,
    });
    this.maskRT = new THREE.WebGLRenderTarget(s.x, s.y, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType,
    });

    this.uniforms = {
      tColor: { value: this.beautyRT.texture },
      tNormal: { value: this.normalRT.texture },
      tDepth: { value: this._depthTex },
      tMask: { value: this.maskRT.texture },
      uTexel: { value: new THREE.Vector2(1 / s.x, 1 / s.y) },
      uBandX: { value: new THREE.Vector2(0.14, 0.86) },
      uStrength: { value: this.cfg.strength },
      uThickness: { value: this.cfg.width },
      uNormalW: { value: 1.15 },
      uDepthW: { value: 0.55 },
      uLumW: { value: 0.42 },
      uDetail: { value: 0.55 },
      uSurface: { value: this.cfg.surface },
      uLineColor: { value: new THREE.Color(this.cfg.color) },
      uTime: { value: 0 },
      uFlow: { value: this.cfg.flow },
      uFlowSpeed: { value: this.cfg.flowSpeed },
      uWipe: { value: 1 },
      uNear: { value: 0.05 },
      uFar: { value: 60 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: QUAD_VERT,
      fragmentShader: QUAD_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
    this._maskCleared = true;
  }

  /* ---------------- 参数 ---------------- */
  setStrength(v) { this.uniforms.uStrength.value = v; }
  setWidth(v) { this.uniforms.uThickness.value = v; }
  setFlow(v) { this.uniforms.uFlow.value = v; }
  setFlowSpeed(v) { this.uniforms.uFlowSpeed.value = v; }
  setSurface(v) { this.uniforms.uSurface.value = v; }
  setColor(hex) { this.uniforms.uLineColor.value.set(hex); }
  setWipe(v) { this.uniforms.uWipe.value = v; }
  setTime(t) { this.uniforms.uTime.value = t; }

  /** 构建擦除亮线的水平范围（0..1 视口归一化坐标） */
  setBand(x0, x1) { this.uniforms.uBandX.value.set(x0, x1); }

  /** 视口 / 相机参数变化时同步 */
  sync(camera) {
    this.uniforms.uNear.value = camera.near;
    this.uniforms.uFar.value = camera.far;
  }

  setSize(w, h, pixelRatio = this.renderer.getPixelRatio()) {
    const pw = Math.max(1, Math.floor(w * pixelRatio));
    const ph = Math.max(1, Math.floor(h * pixelRatio));
    this.beautyRT.setSize(pw, ph);
    this.normalRT.setSize(pw, ph);
    this.maskRT.setSize(pw, ph);
    this.uniforms.uTexel.value.set(1 / pw, 1 / ph);
  }

  /**
   * 渲染一帧。
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {object} opts
   * @param {THREE.Object3D[]} [opts.hide] 法线通道排除的对象（3D 背景 / 平台 / 粒子）
   * @param {THREE.Object3D} [opts.armorRoot] 装甲根节点（遮罩通道用）
   * @param {THREE.Object3D[]} [opts.highlight] 需要提亮的模块 pivot
   */
  render(scene, camera, opts = {}) {
    const r = this.renderer;
    const { hide = [], armorRoot = null, highlight = [] } = opts;

    for (const o of hide) o.visible = false;

    // 1) 法线通道
    scene.overrideMaterial = this._normalMat;
    r.setRenderTarget(this.normalRT);
    r.setClearColor(0x8080ff, 1);
    r.clear();
    r.render(scene, camera);
    scene.overrideMaterial = null;

    // 2) 颜色 + 深度
    r.setRenderTarget(this.beautyRT);
    r.setClearColor(this.cfg.bg, 0);
    r.clear();
    r.render(scene, camera);

    // 3) 高亮遮罩（只画悬停 / 选中模块；其余暂时隐藏）
    if (armorRoot && highlight.length) {
      const kids = armorRoot.children;
      const saved = new Array(kids.length);
      for (let i = 0; i < kids.length; i++) {
        saved[i] = kids[i].visible;
        if (!highlight.includes(kids[i])) kids[i].visible = false;
      }
      scene.overrideMaterial = this._maskMat;
      r.setRenderTarget(this.maskRT);
      r.setClearColor(0x000000, 1);
      r.clear();
      r.render(scene, camera);
      scene.overrideMaterial = null;
      for (let i = 0; i < kids.length; i++) kids[i].visible = saved[i];
      this._maskCleared = false;
    } else if (!this._maskCleared) {
      r.setRenderTarget(this.maskRT);
      r.setClearColor(0x000000, 1);
      r.clear();
      this._maskCleared = true;
    }

    for (const o of hide) o.visible = true;

    // 4) 合成到屏幕
    r.setRenderTarget(null);
    r.setClearColor(this.cfg.bg, 1);
    r.render(this.scene, this.camera);
  }

  dispose() {
    this.beautyRT.dispose();
    this.normalRT.dispose();
    this.maskRT.dispose();
    this._depthTex.dispose();
    this.material.dispose();
    this._normalMat.dispose();
    this._maskMat.dispose();
  }
}

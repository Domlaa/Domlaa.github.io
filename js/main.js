/**
 * main.js — 系统编排入口
 *
 * 启动流程：WebGL2 检测 → 场景 → 模型加载（切分） → 舞台 / 取景 →
 * 边缘线条管线 → 数字化构建擦除 → HUD 上线。
 * 渲染循环统一驱动：自转 / 流光时钟 / 粒子 / 反应堆 / 补间 / HUD。
 */
import * as THREE from 'three';
import { isWebGL2Available, SceneManager } from './core/SceneManager.js';
import { ArmorModel } from './model/ArmorModel.js';
import { ArcReactor } from './effects/ArcReactor.js';
import { ParticleField } from './effects/Particles.js';
import { TweenEngine } from './animation/TweenEngine.js';
import { ArmorExplode } from './animation/ArmorExplode.js';
import { ArmorRaycaster } from './interaction/ArmorRaycaster.js';
import { HUD } from './ui/HUD.js';
import { SCENE_CONFIG } from './config/armor.config.js';

const $ = (id) => document.getElementById(id);
const bootLog = $('boot-log');
const bootBar = $('boot-bar');
function log(msg, progress) {
  bootLog.textContent = msg;
  window.__BOOT_STAGE = msg;                 // 供 index.html 的超时诊断读取
  if (progress !== undefined) bootBar.style.right = `${Math.round((1 - progress) * 100)}%`;
}

async function boot() {
  if (!isWebGL2Available()) {
    $('boot').classList.add('hidden');
    $('webgl-error').classList.remove('hidden');
    return;
  }

  const canvas = $('stage');
  const sceneManager = new SceneManager(canvas);
  const tweens = new TweenEngine();
  const armor = new ArmorModel();
  const edge = sceneManager.edge;

  log('LOADING ARMOR GEOMETRY…', 0.05);

  try {
    await armor.load((p) => log(`LOADING ARMOR GEOMETRY… ${(p * 100) | 0}%`, 0.05 + p * 0.8));
  } catch (err) {
    console.error('[Armor] 模型加载失败:', err);
    log('MODEL LOAD FAILED — SEE CONSOLE', 1);
    window.__BOOT_DIAG?.(`模型加载失败：${err?.message || err}`);
    return;
  }

  log('SEGMENTING MODULES…', 0.9);

  // Arc reactor: the chest carries a real circular bay on the sternum. REACTOR_MOUNT gives
  // a starting ratio, then the mount is snapped onto the actual socket floor — the ratio
  // alone drifts a few millimetres after each model re-compression.
  const chest = armor.modules.get('chest');
  if (chest) {
    const hint = ArcReactor.mountPoint(armor.height);
    const snap = ArcReactor.snapToSocket(chest.mesh, armor.group, hint, armor.height);
    const reactor = new ArcReactor(snap.position);
    reactor.pivot.scale.setScalar(armor.height / 2.6);
    armor.attachProceduralModule(reactor);
    armor._reactor = reactor;
  }

  // 环境粒子（挂在战甲组内，随自转；按模型高度缩放）
  const particles = new ParticleField(SCENE_CONFIG.particles, armor.height);
  particles.points.scale.setScalar(armor.height / 1.85);
  armor.group.add(particles.points);

  sceneManager.scene.add(armor.group);

  // 拆解系统与拾取（高模 + 宽体：位移收敛，拆开时相机后拉）
  const explode = new ArmorExplode(armor, tweens, SCENE_CONFIG.explodeScale);
  const explodeCtl = {
    explode: () => { explode.explode(); sceneManager.zoom(SCENE_CONFIG.explodeZoom, tweens); },
    assemble: () => { explode.assemble(); sceneManager.zoom(1.0, tweens); },
  };
  const raycaster = new ArmorRaycaster(canvas, armor, sceneManager, (m) => hud.renderInfo(m));

  // 渲染状态
  const state = {
    paused: false,
    spin: SCENE_CONFIG.autoSpin,     // 与滑条默认值 30 对应（30/100 × 0.6）
    time: 0,
  };

  // HUD（先显示再取景：舞台区尺寸来自已排版的网格）
  const hud = new HUD({
    armor, sceneManager, explode: explodeCtl, tweens,
    onSpin: (n) => { state.spin = n * 0.6; },
    getSpin: () => state.spin,
    onToggleLines: (on) => edge.setStrength(on ? 0.95 : 0),
    onToggleFlow: (on) => edge.setFlow(on ? SCENE_CONFIG.line.flow : 0),
    onLine: (n) => edge.setStrength(n),
    onWidth: (n) => edge.setWidth(n),
    onFlowSpeed: (n) => edge.setFlowSpeed(n * 0.5),
    onPause: (paused) => {
      state.paused = paused;
      if (paused) tweens.pause(); else tweens.resume();
    },
    onReset: () => sceneManager.resetView(tweens),
    // Dock collapse: the stage grid row grows, so re-fit the camera once the transition ends
    onDockToggle: () => {
      setTimeout(() => {
        sceneManager.frame(armor.box);
        sceneManager.zoom(1.0, tweens, 0.7);
        sceneManager.edge.setBand(
          sceneManager._stageRect().left / window.innerWidth,
          (sceneManager._stageRect().left + sceneManager._stageRect().width) / window.innerWidth,
        );
      }, 440);
    },
  });
  hud.show();

  sceneManager.buildStage(armor.box);
  sceneManager.frame(armor.box);
  sceneManager.resetView();
  edge.sync(sceneManager.camera);

  // 面板统计
  let tris = 0;
  for (const m of armor.modules.values()) tris += m.tris || 0;
  $('sys-tris').textContent = tris.toLocaleString('en-US');

  // 数字化构建：等启动画面开始淡出后再自下而上擦出模型
  log('CALIBRATING HOLOGRAM…', 1);
  edge.setWipe(0);

  setTimeout(() => {
    window.__BOOT_READY = true;              // 关掉 index.html 里的超时诊断
    const bootEl = $('boot');
    bootEl.classList.add('fade');
    setTimeout(() => bootEl.remove(), 900);

    tweens.add({
      tag: 'wipe',
      duration: 1.9,
      ease: 'outCubic',
      delay: 0.15,
      onUpdate: (_r, e) => edge.setWipe(e),
      onComplete: () => edge.setWipe(1),
    });
  }, 700);

  /* ---------------- 渲染循环 ---------------- */
  const clock = new THREE.Clock();
  let running = true;
  let slowTime = 0;

  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.1);

    if (!state.paused) {
      state.time += dt;
      armor.group.rotation.y += state.spin * dt;
      particles.update(dt, state.time);
      if (armor._reactor) armor._reactor.update(dt, state.time);
      tweens.update(dt);
    }
    armor.update(dt);
    sceneManager.time = state.time;

    // 性能自适应：连续 3 秒低于 38fps 则降级一次
    if (dt > 1 / 38) {
      slowTime += dt;
      if (slowTime > 3) { sceneManager.degrade(); slowTime = -1e9; }
    } else if (slowTime > 0) {
      slowTime = Math.max(0, slowTime - dt * 0.5);
    }

    sceneManager.render({
      armorRoot: armor.group,
      highlight: armor.highlightPivots(),
      hide: [particles.points],
    });
    hud.update(dt, state.time);
  }
  loop();

  // 页面隐藏时自动降载
  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) { clock.getDelta(); loop(); }
  });

  // 组件销毁（SPA 场景下释放 GPU 资源）
  window.addEventListener('pagehide', () => {
    running = false;
    armor.dispose();
    particles.dispose();
    sceneManager.dispose();
  });

  console.info(`[Armor] 系统上线：${armor.modules.size} 个模块，${tris} 三角面，高度 ${armor.height.toFixed(2)}`);

  // 调试 / 自动截图用句柄
  window.__HOME = { THREE, sceneManager, armor, edge, hud, state, explode: explodeCtl, explodeRaw: explode };
}

boot();

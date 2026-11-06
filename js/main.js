/**
 * main.js — 系统编排入口
 *
 * 启动流程：WebGL2 检测 → 场景 → 模型加载（切分） → 反应堆/粒子 →
 * 数字化显现动画 → HUD 上线。渲染循环统一驱动：自转 / 扫描 / 补间 / HUD。
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
import { HolographicMaterial } from './materials/HolographicMaterial.js';

const $ = (id) => document.getElementById(id);
const bootLog = $('boot-log');
const bootBar = $('boot-bar');
function log(msg, progress) {
  bootLog.textContent = msg;
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

  log('LOADING ARMOR GEOMETRY…', 0.05);

  try {
    await armor.load((p) => log(`LOADING ARMOR GEOMETRY… ${(p * 100) | 0}%`, 0.05 + p * 0.8));
  } catch (err) {
    console.error('[Armor] 模型加载失败:', err);
    log('MODEL LOAD FAILED — SEE CONSOLE', 1);
    return;
  }

  log('SEGMENTING MODULES…', 0.9);

  // 弧光反应堆：安装到胸甲前方（依据胸甲包围盒计算安装位）
  const chest = armor.modules.get('chest');
  if (chest) {
    const bb = chest.mesh.geometry.boundingBox;
    const y = bb.min.y + (bb.max.y - bb.min.y) * 0.72;
    const reactor = new ArcReactor(new THREE.Vector3(0, y, bb.max.z + 0.02));
    armor.attachProceduralModule(reactor);
    armor._reactor = reactor;
  }

  // 环境粒子（挂在战甲组内，随自转）
  const particles = new ParticleField(420, armor.height);
  armor.group.add(particles.points);
  sceneManager.scene.add(armor.group);

  // 拆解系统与拾取
  const explode = new ArmorExplode(armor, tweens);
  const raycaster = new ArmorRaycaster(canvas, armor, sceneManager, (m) => hud.renderInfo(m));

  // HUD
  const hud = new HUD({
    armor, sceneManager, explode, tweens,
    onScanSpeed: (n) => { state.scanSpeed = 0.12 + n * 0.85; },
    onOpacity: (n) => armor.setOpacity(0.15 + n * 0.85),
    onSpin: (n) => { state.spin = n * 0.7; },
    onToggleHolo: (on) => armor.setHologram(on),
    onToggleWire: (on) => armor.setWireframe(on),
    onPause: (paused) => {
      state.paused = paused;
      if (paused) tweens.pause(); else tweens.resume();
    },
    onReset: () => sceneManager.resetView(tweens),
  });

  // 面板统计
  let tris = 0;
  for (const m of armor.modules.values()) tris += m.tris || 0;
  $('sys-tris').textContent = tris.toLocaleString();

  // 应用状态（渲染循环使用，避免 Vue 式高频响应式开销）
  const state = {
    paused: false,
    spin: 0.3 * 0.7,          // 与滑条默认值 30 对应
    scanSpeed: 0.12 + 0.35 * 0.85,
    time: 0,
  };

  // 数字化显现 → HUD 上线
  log('CALIBRATING HOLOGRAM…', 1);
  explode.materialize(2.4);
  setTimeout(() => {
    const bootEl = $('boot');
    bootEl.classList.add('fade');
    hud.show();
    setTimeout(() => bootEl.remove(), 900);
  }, 700);

  /* ---------------- 渲染循环 ---------------- */
  const clock = new THREE.Clock();
  let running = true;
  let slowTime = 0; // 连续低帧率累计时长 → 触发降级

  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.1);

    if (!state.paused) {
      state.time += dt;
      // 自转
      armor.group.rotation.y += state.spin * dt;
      // 扫描线循环（-0.15 → 1.15）
      const cycle = 1.3;
      HolographicMaterial.globals.uScanY.value = ((state.time * state.scanSpeed) % cycle) - 0.15;
      HolographicMaterial.globals.uTime.value = state.time;
      particles.update(dt, state.time);
      if (armor._reactor) armor._reactor.update(dt, state.time);
      tweens.update(dt);
    }
    armor.update(dt, state.time);

    // 性能自适应：连续 3 秒低于 38fps 则降级一次
    if (dt > 1 / 38) {
      slowTime += dt;
      if (slowTime > 3) { sceneManager.degrade(); slowTime = -1e9; }
    } else if (slowTime > 0) {
      slowTime = Math.max(0, slowTime - dt * 0.5);
    }

    sceneManager.render();
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

  console.info(`[Armor] 系统上线：${armor.modules.size} 个模块，${tris} 三角面`);
}

boot();

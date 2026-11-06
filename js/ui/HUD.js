/**
 * HUD.js — 全息 HUD 信息面板
 *
 *  - 左上系统状态 / 右上能量面板
 *  - 左侧模块列表（点击选中 / 眼睛按钮显隐）
 *  - 右侧选中部件详情
 *  - 底部控制栏（拆解组装、全息线框、扫描/透明/自转滑条、暂停、复位）
 *  - SVG 动态指示线：模块列表行 ↔ 3D 模块锚点（每帧投影，跟随模型旋转）
 */
import * as THREE from 'three';
import { MODULES, ARMOR_NAME } from '../config/armor.config.js';

export class HUD {
  /**
   * @param {object} app { armor, sceneManager, explode, tweens, controls(state) }
   */
  constructor(app) {
    this.app = app;
    this.armor = app.armor;

    this.el = {
      hud: document.getElementById('hud'),
      fps: document.getElementById('sys-fps'),
      tris: document.getElementById('sys-tris'),
      state: document.getElementById('sys-state'),
      render: document.getElementById('sys-render'),
      powerOutput: document.getElementById('power-output'),
      powerBar: document.getElementById('power-bar'),
      powerIntegrity: document.getElementById('power-integrity'),
      moduleList: document.getElementById('module-list'),
      infoTitle: document.getElementById('info-title'),
      infoBody: document.getElementById('info-body'),
      svg: document.getElementById('leader-lines'),
    };

    this.rows = new Map();      // id -> { li, eye }
    this.lines = new Map();     // id -> { path, dot, label }
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._fpsTimer = 0;

    this._buildModuleList();
    this._initSvg();
    this._bindControls();

    document.getElementById('sys-unit').textContent = ARMOR_NAME;
  }

  show() { this.el.hud.classList.remove('hidden'); }

  /* ---------------- 模块列表 ---------------- */
  _buildModuleList() {
    for (const def of MODULES) {
      const li = document.createElement('li');
      li.dataset.id = def.id;
      li.innerHTML = `
        <span class="dot"></span>
        <span class="name">${def.name}</span>
        <span class="cn-name">${def.cn}</span>
        <span class="eye" title="显示 / 隐藏">◉</span>
      `;
      li.addEventListener('click', (e) => {
        if (e.target.classList.contains('eye')) return;
        this.selectModule(def.id, true);
      });
      li.querySelector('.eye').addEventListener('click', () => {
        const m = this.armor.modules.get(def.id);
        this.setModuleVisible(def.id, !m.visible);
      });
      this.el.moduleList.appendChild(li);
      this.rows.set(def.id, { li, eye: li.querySelector('.eye') });
    }
  }

  setModuleVisible(id, visible) {
    this.armor.setModuleVisible(id, visible);
    const row = this.rows.get(id);
    if (row) row.li.classList.toggle('off', !visible);
    // 隐藏的模块若处于选中状态则取消选中
    if (!visible && this.armor.selected?.id === id) {
      this.armor.setSelected(null);
      this.renderInfo(null);
    }
  }

  selectModule(id, scroll = false) {
    const m = this.armor.modules.get(id);
    if (!m || !m.visible) return;
    this.armor.setSelected(m);
    this.renderInfo(m);
  }

  /* ---------------- 指示线 SVG ---------------- */
  _initSvg() {
    const NS = 'http://www.w3.org/2000/svg';
    for (const def of MODULES) {
      const path = document.createElementNS(NS, 'polyline');
      path.setAttribute('class', 'lead-line');
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('class', 'lead-dot');
      dot.setAttribute('r', '2.5');
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('class', 'lead-label');
      label.setAttribute('x', '8');
      label.textContent = def.cn;
      this.el.svg.appendChild(path);
      this.el.svg.appendChild(dot);
      this.el.svg.appendChild(label);
      this.lines.set(def.id, { path, dot, label });
    }
  }

  _syncSvgSize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.el.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }

  /** 每帧：投影锚点 → 更新指示线 */
  updateLines() {
    this._syncSvgSize();
    const w = window.innerWidth;
    const v = new THREE.Vector3();
    const listRect = this.el.moduleList.getBoundingClientRect();
    const listVisible = listRect.width > 0 && listRect.height > 0;

    for (const def of MODULES) {
      const m = this.armor.modules.get(def.id);
      const { path, dot, label } = this.lines.get(def.id);
      if (!m || !m.visible || m.revealT < 0.6) {
        path.setAttribute('points', '');
        dot.setAttribute('r', '0');
        label.setAttribute('x', '-100');
        continue;
      }
      // 锚点（模型空间）→ 世界 → 屏幕投影
      v.copy(m.anchor);
      this.armor.group.localToWorld(v);
      v.project(this.app.sceneManager.camera);
      if (v.z > 1) { // 在相机背后
        path.setAttribute('points', '');
        dot.setAttribute('r', '0');
        label.setAttribute('x', '-100');
        continue;
      }
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
      if (sx < -40 || sx > w + 40 || sy < -40 || sy > window.innerHeight + 40) {
        path.setAttribute('points', '');
        dot.setAttribute('r', '0');
        label.setAttribute('x', '-100');
        continue;
      }

      // 连接到左侧列表对应行（行存在时）
      const row = this.rows.get(def.id);
      if (!listVisible) {
        path.setAttribute('points', '');
        dot.setAttribute('r', '0');
        label.style.display = 'none';
        continue;
      }
      let portX = Math.max(16, w * 0.18), portY = sy;
      if (row) {
        const r = row.li.getBoundingClientRect();
        portX = r.right + 4;
        portY = r.top + r.height / 2;
      }
      const elbowX = Math.min(sx - 26, portX + (sx - portX) * 0.55);
      const selected = this.armor.selected?.id === def.id;

      path.setAttribute('points', `${portX},${portY} ${elbowX},${portY} ${sx},${sy}`);
      path.setAttribute('class', 'lead-line' + (selected ? ' selected' : ''));
      dot.setAttribute('cx', sx);
      dot.setAttribute('cy', sy);
      dot.setAttribute('r', selected ? '3.5' : '2.5');
      dot.setAttribute('class', 'lead-dot' + (selected ? ' selected' : ''));
      label.setAttribute('x', sx + 8);
      label.setAttribute('y', sy - 6);
      label.setAttribute('class', 'lead-label' + (selected ? ' selected' : ''));
      // 标签仅对选中 / 悬停模块显示，避免 10 个标签互相压叠
      const showLabel = selected || this.armor.hovered?.id === def.id;
      label.style.display = showLabel ? '' : 'none';
    }
  }

  /* ---------------- 信息面板 ---------------- */
  renderInfo(m) {
    // 列表高亮
    for (const [id, row] of this.rows) row.li.classList.toggle('active', id === m?.id);

    if (!m) {
      this.el.infoTitle.innerHTML = 'TARGET INFO <span class="cn">部件信息</span>';
      this.el.infoBody.innerHTML = '<p class="info-hint">点击任意装甲模块<br>查看详细技术参数</p>';
      return;
    }
    const def = m.def;
    this.el.infoTitle.innerHTML = `TARGET INFO <span class="cn">部件信息</span>`;
    const stats = def.stats.map(([k, v, p]) => `
      <span class="k">${k}</span>
      <span class="bar"><i style="right:${Math.round((1 - p) * 100)}%"></i></span>
      <span class="v">${v}</span>
    `).join('');
    this.el.infoBody.innerHTML = `
      <div class="info-name">${def.name}</div>
      <div class="info-cn">■ ${def.cn}</div>
      <p class="info-desc">${def.desc}</p>
      <div class="info-stats">${stats}</div>
      <div class="info-status"><span class="ok-dot"></span>STATUS · NOMINAL</div>
    `;
  }

  /* ---------------- 控制栏 ---------------- */
  _bindControls() {
    const $ = (id) => document.getElementById(id);
    const { explode, tweens, onScanSpeed, onOpacity, onSpin, onToggleHolo, onToggleWire, onPause, onReset } = this.app;

    $('btn-explode').addEventListener('click', () => { explode.explode(); this._flashState('EXPLODE'); });
    $('btn-assemble').addEventListener('click', () => { explode.assemble(); this._flashState('ASSEMBLE'); });
    $('btn-holo').addEventListener('click', (e) => {
      const on = e.currentTarget.classList.toggle('on');
      onToggleHolo(on);
    });
    $('btn-wire').addEventListener('click', (e) => {
      const on = e.currentTarget.classList.toggle('on');
      onToggleWire(on);
    });
    $('btn-pause').addEventListener('click', (e) => {
      const paused = e.currentTarget.textContent.startsWith('暂停');
      e.currentTarget.textContent = paused ? '继续 RESUME' : '暂停 PAUSE';
      onPause(paused);
    });
    $('btn-reset').addEventListener('click', () => onReset());

    $('rng-scan').addEventListener('input', (e) => onScanSpeed(e.target.value / 100));
    $('rng-opacity').addEventListener('input', (e) => onOpacity(e.target.value / 100));
    $('rng-spin').addEventListener('input', (e) => onSpin(e.target.value / 100));

    this._tweens = tweens;
  }

  _flashState(text) {
    this.el.state.textContent = text;
    clearTimeout(this._stateTimer);
    this._stateTimer = setTimeout(() => { this.el.state.textContent = 'STANDBY'; }, 1600);
  }

  /* ---------------- 每帧低频更新（FPS / 能量） ---------------- */
  update(dt, time) {
    // FPS：每 0.5s 汇总一次，避免频繁触发布局
    this._fpsAccum += dt;
    this._fpsFrames++;
    this._fpsTimer += dt;
    if (this._fpsTimer > 0.5) {
      this.el.fps.textContent = Math.round(this._fpsFrames / this._fpsAccum);
      this._fpsAccum = 0;
      this._fpsFrames = 0;
      this._fpsTimer = 0;
    }

    // 能量读数（噪声抖动）
    const out = 3.42 + Math.sin(time * 1.7) * 0.08 + Math.sin(time * 4.3) * 0.04;
    this.el.powerOutput.textContent = out.toFixed(2) + ' GJ/s';
    this.el.powerBar.style.right = (10 + Math.sin(time * 0.8) * 4) + '%';
    this.el.powerIntegrity.textContent = (99.1 + Math.sin(time * 0.5) * 0.5).toFixed(1) + '%';

    this.updateLines();
  }
}

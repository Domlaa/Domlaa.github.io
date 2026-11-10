/**
 * HUD.js — 全息 HUD 信息面板
 *
 *  - 顶栏：品牌 / 型号 / 系统状态 / 时钟
 *  - 左栏：模块列表（点击选中、眼睛按钮显隐）、系统读数、其他视点
 *  - 右栏：选中部件详情、能量核心
 *  - 底部控制坞：拆解组装、线条 / 流光开关、线条强度 / 线宽 / 流速 / 自转、暂停、复位
 *  - SVG 指示线：仅对悬停 / 选中的模块绘制（避免十条线在装甲上互相压叠）
 */
import * as THREE from 'three';
import { MODULES, ARMOR_NAME } from '../config/armor.config.js';

export class HUD {
  /**
   * @param {object} app { armor, sceneManager, explode, tweens, onSpin, onPause, onReset,
   *                       onToggleLines, onToggleFlow, onLine, onWidth, onFlowSpeed }
   */
  constructor(app) {
    this.app = app;
    this.armor = app.armor;

    const $ = (id) => document.getElementById(id);
    this.el = {
      hud: $('hud'),
      fps: $('sys-fps'),
      tris: $('sys-tris'),
      state: $('sys-state'),
      clock: $('clock'),
      powerOutput: $('power-output'),
      powerBar: $('power-bar'),
      powerIntegrity: $('power-integrity'),
      moduleList: $('module-list'),
      infoBody: $('info-body'),
      svg: $('leader-lines'),
    };

    this.rows = new Map();
    this.lines = new Map();
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._fpsTimer = 0;
    this._clockTimer = 0;

    this._buildModuleList();
    this._initSvg();
    this._bindControls();
    this.renderInfo(null);

    const unit = $('sys-unit');
    if (unit) unit.textContent = ARMOR_NAME;
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
    if (!visible && this.armor.selected?.id === id) {
      this.armor.setSelected(null);
      this.renderInfo(null);
    }
  }

  selectModule(id) {
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
      dot.setAttribute('r', '2.4');
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('class', 'lead-label');
      label.textContent = def.cn;
      this.el.svg.appendChild(path);
      this.el.svg.appendChild(dot);
      this.el.svg.appendChild(label);
      this.lines.set(def.id, { path, dot, label });
    }
  }

  _hideLine(entry) {
    entry.path.setAttribute('points', '');
    entry.dot.setAttribute('r', '0');
    entry.label.style.display = 'none';
  }

  /** 每帧：只为悬停 / 选中模块投影锚点并连线到列表行 */
  updateLines() {
    const w = window.innerWidth, h = window.innerHeight;
    this.el.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const v = new THREE.Vector3();
    const listRect = this.el.moduleList.getBoundingClientRect();
    const listVisible = listRect.width > 0 && listRect.height > 0;

    for (const def of MODULES) {
      const m = this.armor.modules.get(def.id);
      const entry = this.lines.get(def.id);
      const active = m && m.visible && (this.armor.hovered === m || this.armor.selected === m);
      if (!m || !active || !listVisible) { this._hideLine(entry); continue; }

      // 模块中心（组空间）→ 世界 → 屏幕
      v.copy(m.pivot.position);
      this.armor.group.localToWorld(v);
      v.project(this.app.sceneManager.camera);
      if (v.z > 1) { this._hideLine(entry); continue; }
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      if (sx < -60 || sx > w + 60 || sy < -60 || sy > h + 60) { this._hideLine(entry); continue; }

      const row = this.rows.get(def.id);
      if (!row) { this._hideLine(entry); continue; }
      const r = row.li.getBoundingClientRect();
      const portX = r.right + 4;
      const portY = r.top + r.height / 2;
      const elbowX = portX + Math.max(18, Math.min(60, (sx - portX) * 0.45));
      const selected = this.armor.selected?.id === def.id;

      entry.path.setAttribute('points', `${portX},${portY} ${elbowX},${portY} ${sx},${sy}`);
      entry.path.setAttribute('class', 'lead-line' + (selected ? ' selected' : ''));
      entry.dot.setAttribute('cx', sx);
      entry.dot.setAttribute('cy', sy);
      entry.dot.setAttribute('r', selected ? '3.2' : '2.4');
      entry.dot.setAttribute('class', 'lead-dot' + (selected ? ' selected' : ''));
      entry.label.setAttribute('x', sx + 8);
      entry.label.setAttribute('y', sy - 7);
      entry.label.setAttribute('class', 'lead-label' + (selected ? ' selected' : ''));
      entry.label.style.display = '';
    }
  }

  /* ---------------- 信息面板 ---------------- */
  renderInfo(m) {
    for (const [id, row] of this.rows) row.li.classList.toggle('active', id === m?.id);

    if (!m) {
      this.el.infoBody.innerHTML = this._idleInfo();
      return;
    }
    const def = m.def;
    const stats = (def.stats || []).map(([k, v, p]) => `
      <span class="k">${k}</span>
      <span class="bar"><i style="right:${Math.round((1 - p) * 100)}%"></i></span>
      <span class="v">${v}</span>
    `).join('');
    this.el.infoBody.innerHTML = `
      <div class="info-name">${def.name}</div>
      <div class="info-cn">■ ${def.cn}</div>
      <p class="info-desc">${def.desc || ''}</p>
      <div class="info-stats">${stats}</div>
      <div class="info-status"><span class="ok-dot"></span>STATUS · NOMINAL</div>
    `;
  }

  /** 无选中时的摘要（把右栏空面板填成读数区） */
  _idleInfo() {
    const all = [...this.armor.modules.values()];
    const online = all.filter((m) => m.visible).length;
    const tris = all.reduce((s, m) => s + (m.tris || 0), 0);
    return `
      <p class="info-hint">点击任意装甲模块<br>查看详细技术参数</p>
      <div class="info-ov">
        <div class="kv"><span>PROJECTION</span><b>EDGE LINE</b></div>
        <div class="kv"><span>FLOW</span><b>VERTICAL PULSE</b></div>
        <div class="kv"><span>MODULES</span><b>${online} / ${all.length} ONLINE</b></div>
        <div class="kv"><span>TRIANGLES</span><b>${tris.toLocaleString('en-US')}</b></div>
        <div class="kv"><span>DECONSTRUCTION</span><b class="ok">READY</b></div>
      </div>`;
  }

  /* ---------------- 控制坞 ---------------- */
  _bindControls() {
    const $ = (id) => document.getElementById(id);
    const a = this.app;

    $('btn-explode').addEventListener('click', () => { a.explode.explode(); this._flashState('EXPLODE'); });
    $('btn-assemble').addEventListener('click', () => { a.explode.assemble(); this._flashState('ASSEMBLE'); });

    $('btn-lines').addEventListener('click', (e) => {
      const on = e.currentTarget.classList.toggle('on');
      a.onToggleLines(on);
    });
    $('btn-flow').addEventListener('click', (e) => {
      const on = e.currentTarget.classList.toggle('on');
      a.onToggleFlow(on);
    });

    $('rng-line').addEventListener('input', (e) => a.onLine(e.target.value / 100));
    $('rng-width').addEventListener('input', (e) => a.onWidth(e.target.value / 100));
    $('rng-flow').addEventListener('input', (e) => a.onFlowSpeed(e.target.value / 100));
    $('rng-spin').addEventListener('input', (e) => a.onSpin(e.target.value / 100));

    $('btn-pause').addEventListener('click', (e) => {
      const paused = e.currentTarget.textContent.startsWith('暂停');
      e.currentTarget.textContent = paused ? '继续 RESUME' : '暂停 PAUSE';
      a.onPause(paused);
    });
    $('btn-reset').addEventListener('click', () => a.onReset());
  }

  _flashState(text) {
    this.el.state.textContent = text;
    clearTimeout(this._stateTimer);
    this._stateTimer = setTimeout(() => { this.el.state.textContent = 'STANDBY'; }, 1800);
  }

  /** 右栏线条参数读数（滑条 / 开关变化时同步） */
  _syncProjection() {
    const u = this.app.sceneManager.edge.uniforms;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('p-lines', u.uStrength.value > 0.001 ? 'ON' : 'OFF');
    set('p-strength', u.uStrength.value.toFixed(2));
    set('p-width', u.uThickness.value.toFixed(2));
    set('p-flow', (u.uFlow.value > 0.001 ? 'ON · ' : 'OFF · ') + u.uFlowSpeed.value.toFixed(2));
    set('p-spin', (this.app.getSpin?.() ?? 0.18).toFixed(2) + ' rad/s');
  }

  /* ---------------- 每帧低频更新 ---------------- */
  update(dt, time) {
    this._fpsAccum += dt;
    this._fpsFrames++;
    this._fpsTimer += dt;
    if (this._fpsTimer > 0.5) {
      this.el.fps.textContent = String(Math.round(this._fpsFrames / this._fpsAccum));
      this._fpsAccum = 0;
      this._fpsFrames = 0;
      this._fpsTimer = 0;
    }

    this._clockTimer += dt;
    if (this._clockTimer > 1) {
      this._clockTimer = 0;
      this.el.clock.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
      this._syncProjection();
    }

    const out = 3.42 + Math.sin(time * 1.7) * 0.08 + Math.sin(time * 4.3) * 0.04;
    this.el.powerOutput.textContent = out.toFixed(2) + ' GJ/s';
    this.el.powerBar.style.right = (10 + Math.sin(time * 0.8) * 4) + '%';
    this.el.powerIntegrity.textContent = (99.1 + Math.sin(time * 0.5) * 0.5).toFixed(1) + '%';

    this.updateLines();
  }
}

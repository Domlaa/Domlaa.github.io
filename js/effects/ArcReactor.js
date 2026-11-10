/**
 * ArcReactor.js — procedural energy core
 *
 * The GLB is a single mesh (no separate core part), so the arc reactor is generated
 * from primitives + a glow sprite and registered as its own module in ArmorModel
 * (selectable / explodeable / hideable).
 */
import * as THREE from 'three';

export class ArcReactor {
  /**
   * Locate the reactor bay on the chest geometry.
   *
   * The Hulk Buster chest is not symmetric and the reactor sits on a raised plate
   * near the sternum, so a fixed ratio of the chest bounding box drifts off target.
   * Instead: scan the chest vertices band by band, take the band whose front surface
   * protrudes most (that plate), then average x of the vertices sitting on that front
   * surface — the model's own mid-line is slightly off x = 0.
   *
   * @param {THREE.BufferGeometry} geometry chest geometry (model space, y from the feet)
   * @param {number} height total model height, used for absolute tolerances
   * @returns {THREE.Vector3} mount point in model space
   */
  static mountPoint(geometry, height) {
    const pos = geometry.getAttribute('position');
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bb = geometry.boundingBox;

    const bandY = height * 0.014;
    const steps = 64;
    let bestY = bb.min.y, bestZ = -Infinity;

    for (let k = 0; k <= steps; k++) {
      const y0 = bb.min.y + (bb.max.y - bb.min.y) * (k / steps);
      let mz = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        if (Math.abs(pos.getY(i) - y0) > bandY) continue;
        const z = pos.getZ(i);
        if (z > mz) mz = z;
      }
      if (mz > bestZ) { bestZ = mz; bestY = y0; }
    }

    // 取该高度带里贴近前表面的顶点求 x 中心（护板本身）
    const zCut = bestZ - height * 0.022;
    let sx = 0, n = 0;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getY(i) - bestY) > bandY * 1.8) continue;
      if (pos.getZ(i) < zCut) continue;
      sx += pos.getX(i); n++;
    }

    return new THREE.Vector3(n ? sx / n : 0, bestY, bestZ + height * 0.004);
  }

  /**
   * @param {THREE.Vector3} position mount point in model space (front of the chest)
   */
  constructor(position) {
    this.material = null;
    this.def = {
      id: 'reactor',
      region: null,
      name: 'ARC REACTOR',
      sub: 'energy core',
      desc: 'Palladium arc reactor rated 3.42 GJ/s, feeding the whole suit. Emits a characteristic cyan glow while running.',
      stats: [
        ['OUTPUT', '3.42 GJ/s', 0.97],
        ['CORE TEMP', '2400 K', 0.72],
        ['FUEL', '99.2%', 0.99],
      ],
      explode: [0, 0.02, 0.30],   // stay on the chest plate when exploded
      rotate: [0, 0, 0],
      stagger: 0.42,
      procedural: true,
    };

    const group = new THREE.Group();

    // main disc (self-lit cyan-white)
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

    // 高亮核心（叠加在圆盘中心，避免整块看起来像一枚灰白硬币）
    const core = new THREE.Mesh(
      new THREE.CircleGeometry(0.022, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    core.position.z = 0.002;
    group.add(core);

    // inner marking ring
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

    // outer halo ring
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x35d5ff,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.062, 0.076, 40), haloMat);
    group.add(halo);

    // glow sprite
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

    // point light: warm-up glow around the core
    this.light = new THREE.PointLight(0x55dcff, 2.2, 1.6, 2);
    group.add(this.light);

    group.position.copy(position);

    // follow the ArmorModel module convention: pivot sits on the anchor, content offset under it
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

    // picking helper: a slightly larger invisible disc at the pivot origin
    const pickMat = new THREE.MeshBasicMaterial({ visible: false });
    this.pickMesh = new THREE.Mesh(new THREE.CircleGeometry(0.1, 12), pickMat);
    pivot.add(this.pickMesh);
  }

  /** per-frame pulse */
  update(dt, time) {
    const pulse = 0.75 + 0.25 * Math.sin(time * 2.6);
    const burst = Math.pow(0.5 + 0.5 * Math.sin(time * 0.9), 8) * 0.6; // 周期性爆发
    const glowScale = 0.095 + 0.028 * pulse + burst * 0.05;
    this.glow.scale.setScalar(glowScale);
    this.glow.material.opacity = 0.34 + 0.16 * pulse;
    this.light.intensity = 0.30 + 0.20 * pulse + 0.7 * burst;

    // outer rings spin faster while selected
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

/** radial-gradient glow texture */
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

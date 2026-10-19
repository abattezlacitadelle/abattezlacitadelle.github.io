// three.js perspective view on top of sim.js (the original 3D prototype view, kept for later use).
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, polyPath, linePath, ring, holes, LEADER_COLORS, LM_NAMES, lmName } from './sim.js';
import { hex } from './ui.js';

export function createView3D(sim) {
  const D = sim.data, W = sim.W, H = sim.H;
  const view = { cursor: { x: W / 2, y: H / 2, ok: false } };
  let ui = null;
  const areaPath = (c, a) => { c.beginPath(); polyPath(c, ring(a)); const h = holes(a); if (h) for (const r of h) polyPath(c, r); };

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  document.body.prepend(renderer.domElement);
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(innerWidth, innerHeight);
  Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
  document.body.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  const SKY = 0xa9b9c9;
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 3000, 10000);
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 20000);
  scene.add(new THREE.HemisphereLight(0xe4ecf5, 0x4a4238, 1.4));
  const sun = new THREE.DirectionalLight(0xfff1dc, 1.8); sun.position.set(-0.6, 1.4, 0.9); scene.add(sun);

  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.12;
  controls.maxPolarAngle = 1.35; controls.minDistance = 15; controls.maxDistance = 7000;
  controls.screenSpacePanning = false;
  controls.listenToKeyEvents(window);
  const wp = (x, y, h = 0) => new THREE.Vector3(x, h, -y);

  // ---------- ground ----------
  let groundMesh, groundTex, navTex;
  function buildNavCanvas() {
    const { COLS, ROWS, walk } = sim;
    const cv = document.createElement('canvas'); cv.width = COLS; cv.height = ROWS;
    const c = cv.getContext('2d'), out = c.createImageData(COLS, ROWS);
    for (let gy = 0; gy < ROWS; gy++) for (let gx = 0; gx < COLS; gx++) {
      const k = ((ROWS - 1 - gy) * COLS + gx) * 4, w = walk[gy * COLS + gx];
      out.data[k] = w ? 60 : 25; out.data[k + 1] = w ? 200 : 25; out.data[k + 2] = w ? 120 : 30; out.data[k + 3] = 255;
    }
    c.putImageData(out, 0, 0);
    return cv;
  }
  function buildGround() {
    const maxT = Math.min(4096, renderer.capabilities.maxTextureSize);
    const s = Math.min(maxT / W, maxT / H, 1.2, Math.sqrt(9e6 / (W * H))); // ~9 Mpx cap (big textures fail on some GPUs / SwiftShader)
    const cw = Math.round(W * s), ch = Math.round(H * s);
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    const c = cv.getContext('2d');
    c.fillStyle = '#4a4741'; c.fillRect(0, 0, cw, ch);
    c.setTransform(s, 0, 0, -s, 0, ch);
    c.fillStyle = '#56704a'; for (const a of D.parks || []) { areaPath(c, a); c.fill('evenodd'); }
    c.fillStyle = '#9c968a'; for (const a of D.squares || []) { areaPath(c, a); c.fill('evenodd'); }
    c.fillStyle = '#2f5f80'; for (const a of D.water || []) { areaPath(c, a); c.fill('evenodd'); }
    c.lineCap = 'round'; c.lineJoin = 'round';
    const roads = [...D.roads].sort((a, b) => a.w - b.w);
    for (const pass of [0, 1]) for (const r of roads) {
      const foot = r.w <= 3;
      if (pass === 0) { c.strokeStyle = foot ? '#8f8a7e' : '#8a857b'; c.lineWidth = r.w; }
      else { if (foot || r.w < 8) continue; c.strokeStyle = '#5a5855'; c.lineWidth = r.w - 4; }
      linePath(c, r.p); c.stroke();
    }
    groundTex = new THREE.CanvasTexture(cv);
    groundTex.colorSpace = THREE.SRGBColorSpace;
    groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    navTex = new THREE.CanvasTexture(buildNavCanvas());
    navTex.magFilter = THREE.NearestFilter; navTex.colorSpace = THREE.SRGBColorSpace;
    const g = new THREE.PlaneGeometry(W, H); g.rotateX(-Math.PI / 2); g.translate(W / 2, 0, -H / 2);
    groundMesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: groundTex }));
    scene.add(groundMesh);
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000).rotateX(-Math.PI / 2).translate(W / 2, -0.5, -H / 2),
      new THREE.MeshLambertMaterial({ color: 0x3d3b37, depthWrite: false }));
    outer.renderOrder = -1; // drawn first, never z-fights with the ground
    scene.add(outer);
  }

  function buildBuildings() {
    const pos = [], nor = [], col = [];
    const cW = new THREE.Color(), cR = new THREE.Color(), tmp = new THREE.Color();
    const WALLS = [0xd9ccb0, 0xd2c3a4, 0xe0d5bd, 0xcbbb9b, 0xd6cab4];
    const push = (a, n, c) => { pos.push(a[0], a[1], a[2]); nor.push(n[0], n[1], n[2]); col.push(c.r, c.g, c.b); };
    for (const b of D.buildings) {
      const p = b.p; let n = p.length >> 1;
      if (n >= 3 && p[0] === p[2 * n - 2] && p[1] === p[2 * n - 1]) n--;
      if (n < 3) continue;
      let area = 0;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1]; }
      const idx = [...Array(n).keys()];
      if (area < 0) idx.reverse();
      const h = b.h || 20;
      cW.setHex(WALLS[(Math.random() * WALLS.length) | 0]).multiplyScalar(0.92 + Math.random() * 0.12);
      cR.setHex(0x737f89).multiplyScalar(0.85 + Math.random() * 0.25);
      const cWb = tmp.copy(cW).multiplyScalar(0.62).clone();
      for (let k = 0; k < n; k++) {
        const a = idx[k], bb = idx[(k + 1) % n];
        const ax = p[2 * a], ay = p[2 * a + 1], bx = p[2 * bb], by = p[2 * bb + 1];
        const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
        const N = [dy / l, 0, dx / l];
        const A0 = [ax, 0, -ay], B0 = [bx, 0, -by], B1 = [bx, h, -by], A1 = [ax, h, -ay];
        push(A0, N, cWb); push(B0, N, cWb); push(B1, N, cW);
        push(A0, N, cWb); push(B1, N, cW); push(A1, N, cW);
      }
      const contour = idx.map(i => new THREE.Vector2(p[2 * i], p[2 * i + 1]));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      for (const t of tris) {
        let [i0, i1, i2] = t;
        const a = contour[i0], b2 = contour[i1], c = contour[i2];
        if ((b2.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b2.y - a.y) < 0) [i1, i2] = [i2, i1];
        for (const ii of [i0, i1, i2]) push([contour[ii].x, h, -contour[ii].y], [0, 1, 0], cR);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true })));
  }

  function labelAt(text, x, y, h, cls) {
    const el = document.createElement('div'); el.className = cls; el.textContent = text;
    const o = new CSS2DObject(el); o.position.copy(wp(x, y, h)); scene.add(o); return o;
  }
  function figureGeo(withShield) {
    const body = new THREE.CylinderGeometry(0.2, 0.27, 1.25, 6); body.translate(0, 0.625, 0);
    const head = new THREE.SphereGeometry(0.16, 6, 4); head.translate(0, 1.45, 0);
    const parts = [body, head];
    if (withShield) { const sh = new THREE.BoxGeometry(0.62, 0.95, 0.06); sh.translate(0, 0.75, 0.33); parts.push(sh); }
    for (const p of parts) p.deleteAttribute('uv');
    return mergeGeometries(parts.map(p => p.toNonIndexed()));
  }
  const figGeo = figureGeo(false), copGeo = figureGeo(true);

  // ---------- per-leader / per-squad scene objects (created lazily) ----------
  const leaderViews = [];
  function leaderView(L) {
    let v = leaderViews[L.id]; if (v) return v;
    const color = L.color, g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color });
    const fig = new THREE.Mesh(figGeo, mat); fig.scale.setScalar(1.25); g.add(fig);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.6, 4), new THREE.MeshLambertMaterial({ color: 0x333333 }));
    pole.position.set(0.3, 1.3, 0); g.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
    flag.position.set(0.75, 2.3, 0); g.add(flag);
    const ringM = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.45, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }));
    ringM.position.y = 0.08; g.add(ringM);
    const selM = new THREE.Mesh(new THREE.RingGeometry(1.7, 2.0, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    selM.position.y = 0.1; selM.visible = false; g.add(selM);
    scene.add(g);
    const tgt = new THREE.Mesh(new THREE.RingGeometry(2.2, 3, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    tgt.visible = false; scene.add(tgt);
    const path = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    path.visible = false; path.frustumCulled = false; scene.add(path);
    const el = document.createElement('div'); el.className = 'll'; el.style.borderColor = hex(color);
    el.addEventListener('pointerdown', e => { e.stopPropagation(); ui?.select(L.id, e.shiftKey); });
    const label = new CSS2DObject(el); label.center.set(0.5, 1.6); g.add(label);
    v = leaderViews[L.id] = { group: g, sel: selM, tgt, path, el, flag, pathRef: null };
    return v;
  }
  const squadViews = new Map();
  function squadView(sq) {
    let v = squadViews.get(sq); if (v) return v;
    const el = document.createElement('div'); el.className = 'pl';
    const label = new CSS2DObject(el); label.position.copy(wp(sq.x, sq.y, 4)); scene.add(label);
    v = { el, label }; squadViews.set(sq, v); return v;
  }

  // ---------- puffs ----------
  const MAXP = sim.pX.length;
  const pPos = new Float32Array(MAXP * 3);
  const puffGeo = new THREE.BufferGeometry();
  puffGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
  puffGeo.setAttribute('size', new THREE.BufferAttribute(sim.pSize, 1).setUsage(THREE.DynamicDrawUsage));
  puffGeo.setAttribute('alpha', new THREE.BufferAttribute(sim.pAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  const puffMat = new THREE.ShaderMaterial({
    uniforms: { scale: { value: 1 } }, transparent: true, depthWrite: false,
    vertexShader: `attribute float size; attribute float alpha; varying float vA; uniform float scale;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = min(size * scale / -mv.z, 900.0); gl_Position = projectionMatrix * mv; vA = alpha; }`,
    fragmentShader: `varying float vA; void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard;
      gl_FragColor = vec4(0.88, 0.89, 0.82, vA * smoothstep(0.5, 0.05, d)); }`
  });
  const puffs = new THREE.Points(puffGeo, puffMat); puffs.frustumCulled = false;

  // ---------- instanced crowd ----------
  const MAXA = sim.MAXA;
  const crowdMesh = new THREE.InstancedMesh(figGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXA);
  crowdMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  crowdMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXA * 3), 3).setUsage(THREE.DynamicDrawUsage);
  crowdMesh.frustumCulled = false;
  const copMesh = new THREE.InstancedMesh(copGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), 2000);
  copMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  copMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(2000 * 3), 3).setUsage(THREE.DynamicDrawUsage);
  copMesh.frustumCulled = false;
  const lColors = LEADER_COLORS.map(h => { const c = new THREE.Color(h); return c.lerp(new THREE.Color(0xffffff), 0.15); });
  const C_IDLE = new THREE.Color(0x8d8d88), C_PANIC = new THREE.Color(0xf2dc6b), C_COP = new THREE.Color(0x22335e), C_COPCH = new THREE.Color(0x4d6fd1);
  const heading = new Float32Array(MAXA);
  function writeMatrix(arr, o, x, z, a, s, yOff = 0) {
    const c = Math.cos(a) * s, sn = Math.sin(a) * s;
    arr[o] = c; arr[o + 1] = 0; arr[o + 2] = -sn; arr[o + 3] = 0;
    arr[o + 4] = 0; arr[o + 5] = s; arr[o + 6] = 0; arr[o + 7] = 0;
    arr[o + 8] = sn; arr[o + 9] = 0; arr[o + 10] = c; arr[o + 11] = 0;
    arr[o + 12] = x; arr[o + 13] = yOff; arr[o + 14] = z; arr[o + 15] = 1;
  }
  function updateViews(figScale) {
    const { px, py, vx, vy, panicT, lead, NA } = sim;
    const m = crowdMesh.instanceMatrix.array, col = crowdMesh.instanceColor.array;
    for (let i = 0; i < NA; i++) {
      const sp = vx[i] * vx[i] + vy[i] * vy[i];
      if (sp > 0.04) heading[i] = Math.atan2(vx[i], vy[i]);
      writeMatrix(m, i * 16, px[i], -py[i], heading[i], figScale);
      const c = panicT[i] > 0 ? C_PANIC : lead[i] >= 0 ? lColors[lead[i] % lColors.length] : C_IDLE;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    crowdMesh.count = NA;
    crowdMesh.instanceMatrix.needsUpdate = true; crowdMesh.instanceColor.needsUpdate = true;
    const cm = copMesh.instanceMatrix.array, cc = copMesh.instanceColor.array;
    let n = 0;
    for (const sq of sim.squads) {
      const a = Math.atan2(sq.dx, sq.dy), cl = sq.state === 'charge' ? C_COPCH : C_COP;
      for (let k = 0; k < sq.n && n < 2000; k++, n++) {
        writeMatrix(cm, n * 16, sq.ox[k], -sq.oy[k], a, figScale * 1.05);
        cc[n * 3] = cl.r; cc[n * 3 + 1] = cl.g; cc[n * 3 + 2] = cl.b;
      }
      squadView(sq).label.position.copy(wp(sq.x + sq.dx * sq.adv, sq.y + sq.dy * sq.adv, 2.5 * figScale + 2));
    }
    for (const [sq, v] of squadViews) if (!sim.squads.includes(sq)) { scene.remove(v.label); v.el.remove(); squadViews.delete(sq); }
    copMesh.count = n;
    copMesh.instanceMatrix.needsUpdate = true; copMesh.instanceColor.needsUpdate = true;
    for (const L of sim.leaders) {
      const v = leaderView(L);
      v.group.position.copy(wp(L.x, L.y)); v.group.scale.setScalar(figScale);
      v.flag.rotation.y = Math.sin(performance.now() / 300 + L.id) * 0.3;
      v.sel.visible = sim.selected.has(L.id);
      const F = L.field;
      v.tgt.visible = !!F && !L.arrived;
      if (F) { v.tgt.position.copy(wp(F.tx, F.ty, 0.15)); v.tgt.scale.setScalar(Math.max(1, figScale * 0.8)); }
      v.path.visible = v.tgt.visible && sim.selected.has(L.id);
      if (v.path.visible && L.path && L.path !== v.pathRef) {
        v.pathRef = L.path;
        const p = L.path, pts = new Float32Array((p.length >> 1) * 3);
        for (let i = 0, j = 0; i < p.length; i += 2, j += 3) { pts[j] = p[i]; pts[j + 1] = 0.4; pts[j + 2] = -p[i + 1]; }
        v.path.geometry.dispose();
        v.path.geometry = new THREE.BufferGeometry();
        v.path.geometry.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      }
    }
    // puffs: copy positions from the sim (x, height, -y)
    const NP = sim.NP, { pX, pY, pH } = sim;
    for (let i = 0; i < NP; i++) { pPos[i * 3] = pX[i]; pPos[i * 3 + 1] = pH[i]; pPos[i * 3 + 2] = -pY[i]; }
    puffGeo.setDrawRange(0, NP);
    puffGeo.attributes.position.needsUpdate = true; puffGeo.attributes.size.needsUpdate = true; puffGeo.attributes.alpha.needsUpdate = true;
  }

  // ---------- input ----------
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function groundAt(ev) {
    ndc.set(ev.clientX / innerWidth * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const p = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, p)) return null;
    return { x: p.x, y: -p.z };
  }
  let down = null;
  renderer.domElement.addEventListener('pointermove', e => { const g = groundAt(e); if (g) { view.cursor.x = g.x; view.cursor.y = g.y; view.cursor.ok = true; } });
  renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { down = null; return; }
    const g = groundAt(e); const b = down.b; down = null;
    if (g && ui) ui.click(g.x, g.y, b, e.shiftKey);
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight); labelRenderer.setSize(innerWidth, innerHeight);
  });
  const camDist = () => camera.position.distanceTo(controls.target);
  function focusOn(x, y, dist) {
    const off = camera.position.clone().sub(controls.target);
    if (dist) off.setLength(dist);
    controls.target.copy(wp(x, y)); camera.position.copy(controls.target).add(off);
  }

  // ---------- build ----------
  buildGround(); buildBuildings();
  scene.add(crowdMesh, copMesh, puffs);
  const [gx, gy] = sim.goal;
  for (const k in sim.LM) {
    if (k === 'elysee') continue;
    const [x, y] = sim.LM[k];
    labelAt(lmName(k), x, y, 30, 'lm');
  }
  labelAt(LM_NAMES.elysee, gx, gy, 45, 'lm goal');
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 300, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
  beacon.position.copy(wp(gx, gy, 150)); scene.add(beacon);
  const goalRing = new THREE.Mesh(new THREE.RingGeometry(sim.GOAL_R - 5, sim.GOAL_R, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.6 }));
  goalRing.position.copy(wp(gx, gy, 0.2)); scene.add(goalRing);

  Object.assign(view, {
    renderer, scene, camera, controls,
    attach(u) { ui = u; },
    pickRadius: () => Math.max(6, camDist() / 40),
    toggleNav() { groundMesh.material.map = groundMesh.material.map === groundTex ? navTex : groundTex; groundMesh.material.needsUpdate = true; },
    focus: focusOn,
    initCamera(start) {
      const cx = (start[0] + gx) / 2, cy = (start[1] + gy) / 2;
      controls.target.copy(wp(cx, cy - 300));
      camera.position.copy(controls.target).add(new THREE.Vector3(0, 1700, 1500));
      controls.update();
    },
    onHud() {
      for (const L of sim.leaders) leaderView(L).el.innerHTML = `<b>${L.name}</b> ${L.count}<div class="bar"><i style="width:${L.energy.toFixed(0)}%"></i></div>`;
      for (const sq of sim.squads) squadView(sq).el.innerHTML = `CRS ${sq.id} · ${sq.state}<div class="bar"><i style="width:${sq.energy.toFixed(0)}%"></i></div>`;
    },
    frame() {
      controls.update();
      const figScale = clamp(camDist() / 160, 1, 9);
      puffMat.uniforms.scale.value = innerHeight / (2 * Math.tan(camera.fov * Math.PI / 360));
      updateViews(figScale);
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    },
  });
  return view;
}

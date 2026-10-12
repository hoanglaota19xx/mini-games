/*
 * scene.js — toàn bộ phần 3D (Three.js r128, đã đóng gói trong vendor/).
 * - Cảnh được vẽ ở độ phân giải thấp rồi phóng to bằng NearestFilter + dither Bayer + scanline
 *   để ra chất "PS1 / CRT". Mọi mô hình tự dựng từ hình khối cơ bản, texture vẽ bằng canvas.
 * - Không chứa luật chơi: chỉ nhận lệnh (đặt vật phẩm, bắn, quay camera...) và trả Promise khi xong.
 */
(function (root) {
  'use strict';
  const T = root.THREE;
  const S = { ok: false, speed: 1 };

  const TABLE_W = 3.5, TABLE_D = 2.75;
  const SEAT_Z = 2.75;                      // vị trí tượng người ngồi
  const COLORS = [0xffb347, 0x4ad8ff];      // màu nhận diện P1 / P2

  let renderer, scene, camera, canvas, rt, postScene, postCam, postMat;
  let shakeAmt = 0, time = 0, lastT = 0, rafId = 0, curP = 0;
  const tweens = [];
  const pickHandler = { fn: null };
  let hoverKey = null;

  // ---------- tiện ích ----------
  const rngTex = root.SRLogic.makeRng(1234);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = {
    lin: (t) => t,
    io: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    out: (t) => 1 - Math.pow(1 - t, 3),
    in: (t) => t * t * t,
    back: (t) => { const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  };
  function tween(dur, fn, e) {
    return new Promise((res) => {
      tweens.push({ t: 0, dur: Math.max(0.0001, dur / S.speed), fn, e: e || ease.io, res });
    });
  }
  const wait = (sec) => tween(sec);
  function updateTweens(dt) {
    if (!tweens.length) return;
    const list = tweens.splice(0, tweens.length);
    const keep = [];
    for (const tw of list) {
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      try { if (tw.fn) tw.fn(tw.e(k), k); } catch (err) { console.error(err); }
      if (k >= 1) tw.res(); else keep.push(tw);
    }
    tweens.push(...keep);
  }

  function canvasTex(w, h, draw, opts) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new T.CanvasTexture(c);
    t.magFilter = T.NearestFilter; t.minFilter = T.NearestFilter;
    if (opts && opts.repeat) { t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(opts.repeat[0], opts.repeat[1]); }
    return t;
  }
  function speckle(x, w, h, n, alpha) {
    for (let i = 0; i < n; i++) {
      const dark = rngTex() < 0.5;
      x.fillStyle = dark ? 'rgba(0,0,0,' + (rngTex() * alpha) + ')' : 'rgba(255,255,255,' + (rngTex() * alpha * 0.6) + ')';
      x.fillRect(rngTex() * w, rngTex() * h, 1 + rngTex() * 2, 1);
    }
  }
  const phong = (color, o) => new T.MeshPhongMaterial(Object.assign({ color, flatShading: true, shininess: 12, specular: 0x222222 }, o || {}));
  const basic = (color, o) => new T.MeshBasicMaterial(Object.assign({ color }, o || {}));
  function mesh(geo, mat, x, y, z) {
    const m = new T.Mesh(geo, mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }
  const box = (w, h, d, mat, x, y, z) => mesh(new T.BoxGeometry(w, h, d), mat, x, y, z);
  const cyl = (rt_, rb, h, seg, mat, x, y, z) => mesh(new T.CylinderGeometry(rt_, rb, h, seg), mat, x, y, z);

  // ---------- vị trí ô vật phẩm ----------
  const side = (p) => (p === 0 ? 1 : -1);
  function slotPos(p, slot) {
    const s = side(p), row = Math.floor(slot / 4), col = slot % 4;
    return new T.Vector3(s * (-0.93 + col * 0.62), 0, s * (0.72 + row * 0.42));
  }

  // ---------- mô hình vật phẩm ----------
  const ITEM_MAKERS = {
    magnifier() {
      const g = new T.Group();
      const ring = mesh(new T.TorusGeometry(0.13, 0.024, 6, 14), phong(0x9aa4ad, { shininess: 60 }), 0, 0.03, 0);
      ring.rotation.x = Math.PI / 2;
      const lens = mesh(new T.CircleGeometry(0.115, 14), basic(0x9fd8ff, { transparent: true, opacity: 0.4 }), 0, 0.034, 0);
      lens.rotation.x = -Math.PI / 2; lens.castShadow = false;
      const handle = cyl(0.03, 0.036, 0.24, 6, phong(0x2a2018), 0.27, 0.03, 0);
      handle.rotation.z = Math.PI / 2;
      g.add(ring, lens, handle);
      g.rotation.y = 0.5;
      return g;
    },
    cigarette() {
      const g = new T.Group();
      const top = canvasTex(64, 64, (x, w, h) => {
        x.fillStyle = '#b3261e'; x.fillRect(0, 0, w, h);
        x.fillStyle = '#f2ead3'; x.fillRect(0, 22, w, 20);
        x.fillStyle = '#b3261e'; x.font = 'bold 18px monospace'; x.textAlign = 'center'; x.fillText('R7', 32, 38);
      });
      const mats = [phong(0xa02019), phong(0xa02019), new T.MeshPhongMaterial({ map: top, flatShading: true }), phong(0x7a1812), phong(0xa02019), phong(0xa02019)];
      g.add(mesh(new T.BoxGeometry(0.2, 0.075, 0.3), mats, 0, 0.0375, 0));
      const c = cyl(0.012, 0.012, 0.12, 6, phong(0xf2ead3), 0.04, 0.05, -0.2); c.rotation.x = Math.PI / 2;
      const tip = cyl(0.013, 0.013, 0.025, 6, phong(0xd9731b, { emissive: 0x331100 }), 0.04, 0.05, -0.27); tip.rotation.x = Math.PI / 2;
      g.add(c, tip);
      g.rotation.y = -0.3;
      return g;
    },
    beer() {
      const g = new T.Group();
      const tex = canvasTex(64, 64, (x, w, h) => {
        x.fillStyle = '#c9961a'; x.fillRect(0, 0, w, h);
        x.fillStyle = '#7a1d12'; x.fillRect(0, 18, w, 26);
        x.fillStyle = '#f5deb3'; x.font = 'bold 15px monospace'; x.textAlign = 'center'; x.fillText('BIA', 32, 37);
      });
      g.add(cyl(0.078, 0.078, 0.22, 10, new T.MeshPhongMaterial({ map: tex, flatShading: true, shininess: 40 }), 0, 0.11, 0));
      g.add(cyl(0.07, 0.078, 0.02, 10, phong(0xbfc5ca, { shininess: 80 }), 0, 0.23, 0));
      g.add(cyl(0.05, 0.05, 0.012, 8, phong(0x8f969c, { shininess: 80 }), 0, 0.245, 0));
      return g;
    },
    cuffs() {
      const g = new T.Group();
      const m = phong(0xb8c0c8, { shininess: 80 });
      const r1 = mesh(new T.TorusGeometry(0.075, 0.018, 6, 12), m, -0.14, 0.02, 0); r1.rotation.x = Math.PI / 2;
      const r2 = mesh(new T.TorusGeometry(0.075, 0.018, 6, 12), m, 0.14, 0.02, 0); r2.rotation.x = Math.PI / 2;
      g.add(r1, r2);
      for (let i = -1; i <= 1; i++) {
        const l = mesh(new T.TorusGeometry(0.022, 0.008, 5, 8), m, i * 0.05, 0.02, 0);
        l.rotation.x = Math.PI / 2 * (i % 2 === 0 ? 1 : 0); l.rotation.y = i % 2 === 0 ? 0 : Math.PI / 2;
        g.add(l);
      }
      g.rotation.y = 0.35;
      return g;
    },
    saw() {
      const g = new T.Group();
      const sh = new T.Shape();
      sh.moveTo(0, 0.12); sh.lineTo(0.42, 0.1); sh.lineTo(0.42, 0);
      for (let i = 11; i >= 0; i--) { sh.lineTo(i * 0.035 + 0.0175, -0.025); sh.lineTo(i * 0.035, 0.0); }
      const blade = mesh(new T.ExtrudeGeometry(sh, { depth: 0.012, bevelEnabled: false }), phong(0xaab2b9, { shininess: 70 }), -0.24, 0.02, 0.0);
      blade.rotation.x = Math.PI / 2; blade.position.z = -0.05;
      g.add(blade);
      g.add(box(0.16, 0.05, 0.075, phong(0xd9731b), 0.26, 0.03, 0.0));
      g.add(box(0.03, 0.04, 0.07, phong(0x444b52), 0.16, 0.03, 0.0));
      g.rotation.y = -0.2;
      return g;
    },
    phone() {
      const g = new T.Group();
      g.add(box(0.11, 0.045, 0.2, phong(0x23262b), 0, 0.0225, 0));
      g.add(box(0.075, 0.004, 0.05, basic(0x7bd88f), 0, 0.047, -0.055));
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) g.add(box(0.018, 0.004, 0.014, phong(0x6b727a), -0.025 + c * 0.025, 0.047, 0.015 + r * 0.025));
      g.add(cyl(0.006, 0.006, 0.07, 5, phong(0x23262b), 0.04, 0.045, -0.12));
      g.rotation.y = 0.4;
      return g;
    },
    inverter() {
      const g = new T.Group();
      const top = canvasTex(64, 64, (x, w, h) => {
        x.fillStyle = '#10302b'; x.fillRect(0, 0, w, h);
        x.strokeStyle = '#3cc9a8'; x.lineWidth = 2;
        x.strokeRect(3, 3, w - 6, h - 6);
        x.beginPath(); x.moveTo(20, 46); x.lineTo(20, 16); x.moveTo(13, 23); x.lineTo(20, 15); x.lineTo(27, 23);
        x.moveTo(44, 16); x.lineTo(44, 46); x.moveTo(37, 39); x.lineTo(44, 47); x.lineTo(51, 39); x.stroke();
      });
      const mats = [phong(0x1c2a2a), phong(0x1c2a2a), new T.MeshPhongMaterial({ map: top, flatShading: true }), phong(0x1c2a2a), phong(0x1c2a2a), phong(0x1c2a2a)];
      g.add(mesh(new T.BoxGeometry(0.2, 0.06, 0.2), mats, 0, 0.03, 0));
      g.add(box(0.025, 0.02, 0.025, basic(0xff4d4d), -0.07, 0.07, 0.08));
      g.add(box(0.025, 0.02, 0.025, basic(0x4dff88), 0.07, 0.07, 0.08));
      g.rotation.y = 0.25;
      return g;
    },
    adrenaline() {
      const g = new T.Group();
      const glass = cyl(0.036, 0.036, 0.26, 8, phong(0xcfe8f0, { transparent: true, opacity: 0.45 }), 0, 0.04, 0);
      glass.rotation.z = Math.PI / 2;
      const liquid = cyl(0.028, 0.028, 0.18, 8, phong(0x35e06f, { emissive: 0x0b4a1f }), -0.03, 0.04, 0); liquid.rotation.z = Math.PI / 2;
      const rod = cyl(0.01, 0.01, 0.12, 5, phong(0xdddddd), -0.18, 0.04, 0); rod.rotation.z = Math.PI / 2;
      const thumb = cyl(0.035, 0.035, 0.012, 8, phong(0xdddddd), -0.245, 0.04, 0); thumb.rotation.z = Math.PI / 2;
      const flange = box(0.012, 0.012, 0.11, phong(0xdddddd), 0.12, 0.04, 0);
      const needle = cyl(0.004, 0.004, 0.13, 4, phong(0xeeeeee, { shininess: 90 }), 0.19, 0.04, 0); needle.rotation.z = Math.PI / 2;
      g.add(glass, liquid, rod, thumb, flange, needle);
      g.position.y = 0.03; g.rotation.y = -0.5;
      const wrap = new T.Group(); wrap.add(g);
      return wrap;
    },
    medicine() {
      const g = new T.Group();
      const tex = canvasTex(64, 64, (x, w, h) => {
        x.fillStyle = '#d98a1a'; x.fillRect(0, 0, w, h);
        x.fillStyle = '#f4f0e4'; x.fillRect(0, 14, w, 34);
        x.fillStyle = '#8b1a1a'; x.font = 'bold 22px monospace'; x.textAlign = 'center'; x.fillText('Rx?', 32, 39);
      });
      g.add(cyl(0.065, 0.065, 0.16, 9, new T.MeshPhongMaterial({ map: tex, flatShading: true, shininess: 30 }), 0, 0.08, 0));
      g.add(cyl(0.07, 0.07, 0.04, 9, phong(0xf1f1f1), 0, 0.18, 0));
      return g;
    },
  };

  // ---------- trạng thái cảnh ----------
  const itemMeshes = [new Array(8).fill(null), new Array(8).fill(null)];
  const slotMarkers = [[], []];
  const figures = [];
  let gun, gunPump, gunBarrel, gunTube, muzzle, muzzleLight, muzzleCone;
  let gunPickable = true, gunAtRest = true;
  let lampGroup, lampLight, dust;
  const shellsOnTable = [];
  let ejectFrom = new T.Vector3();

  function buildTable() {
    const top = canvasTex(256, 256, (x, w, h) => {
      x.fillStyle = '#24332d'; x.fillRect(0, 0, w, h);
      speckle(x, w, h, 5000, 0.12);
      for (let i = 0; i < 40; i++) {
        x.strokeStyle = 'rgba(255,255,255,' + (0.03 + rngTex() * 0.05) + ')';
        x.beginPath(); const sx = rngTex() * w, sy = rngTex() * h; x.moveTo(sx, sy); x.lineTo(sx + (rngTex() - 0.5) * 60, sy + (rngTex() - 0.5) * 30); x.stroke();
      }
      x.strokeStyle = 'rgba(210,190,120,0.35)'; x.lineWidth = 2;
      x.strokeRect(10, 10, w - 20, h - 20);
      x.beginPath(); x.arc(w / 2, h / 2, 28, 0, Math.PI * 2); x.stroke();
    });
    const topMat = new T.MeshPhongMaterial({ map: top, flatShading: true, shininess: 6, specular: 0x111111 });
    const slab = new T.Mesh(new T.BoxGeometry(TABLE_W, 0.14, TABLE_D), topMat);
    slab.position.y = -0.07; slab.receiveShadow = true; slab.castShadow = true;
    scene.add(slab);
    const rim = new T.Mesh(new T.BoxGeometry(TABLE_W + 0.12, 0.06, TABLE_D + 0.12), phong(0x1a1612));
    rim.position.y = -0.17; rim.receiveShadow = true; scene.add(rim);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = box(0.2, 1.2, 0.2, phong(0x17130f), sx * (TABLE_W / 2 - 0.15), -0.78, sz * (TABLE_D / 2 - 0.15));
      scene.add(leg);
    }
    const markTex = canvasTex(64, 64, (x, w, h) => {
      x.strokeStyle = '#ffffff'; x.lineWidth = 3;
      const r = 8; x.beginPath();
      x.moveTo(r, 4); x.lineTo(w - r, 4); x.quadraticCurveTo(w - 4, 4, w - 4, r); x.lineTo(w - 4, h - r);
      x.quadraticCurveTo(w - 4, h - 4, w - r, h - 4); x.lineTo(r, h - 4); x.quadraticCurveTo(4, h - 4, 4, h - r);
      x.lineTo(4, r); x.quadraticCurveTo(4, 4, r, 4); x.stroke();
    });
    for (let p = 0; p < 2; p++) for (let s = 0; s < 8; s++) {
      const m = new T.Mesh(new T.PlaneGeometry(0.5, 0.4), new T.MeshBasicMaterial({ map: markTex, transparent: true, color: 0x7d8a82, opacity: 0.7, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      const pos = slotPos(p, s);
      m.position.set(pos.x, 0.004, pos.z);
      scene.add(m);
      slotMarkers[p][s] = m;
    }
  }

  function buildRoom() {
    const wallTex = canvasTex(128, 128, (x, w, h) => {
      x.fillStyle = '#15171b'; x.fillRect(0, 0, w, h);
      speckle(x, w, h, 2500, 0.18);
      x.fillStyle = 'rgba(255,255,255,0.05)';
      for (let i = 0; i < w; i += 32) x.fillRect(i, 0, 2, h);
      x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(0, h * 0.62, w, 3);
    }, { repeat: [6, 2] });
    const walls = new T.Mesh(new T.BoxGeometry(16, 8, 16), new T.MeshPhongMaterial({ map: wallTex, side: T.BackSide, flatShading: true, shininess: 2 }));
    walls.position.y = 2.6; walls.receiveShadow = true; scene.add(walls);
    const floorTex = canvasTex(64, 64, (x, w, h) => {
      x.fillStyle = '#101113'; x.fillRect(0, 0, w, h);
      x.fillStyle = '#17181c'; x.fillRect(0, 0, w / 2, h / 2); x.fillRect(w / 2, h / 2, w / 2, h / 2);
      speckle(x, w, h, 500, 0.2);
    }, { repeat: [16, 16] });
    const floor = new T.Mesh(new T.PlaneGeometry(16, 16), new T.MeshPhongMaterial({ map: floorTex, shininess: 10 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -1.38; floor.receiveShadow = true; scene.add(floor);
    // đèn neon trên tường
    const neon = (color, x, y, z, w, ry) => {
      const m = new T.Mesh(new T.BoxGeometry(w, 0.09, 0.05), new T.MeshBasicMaterial({ color }));
      m.position.set(x, y, z); m.rotation.y = ry || 0; scene.add(m);
    };
    neon(0xff3b5c, 0, 2.3, -7.9, 5); neon(0xff3b5c, 0, 2.0, -7.9, 3);
    neon(0x3bd7ff, 0, 2.3, 7.9, 5); neon(0x3bd7ff, 0, 2.0, 7.9, 3);
    neon(0x9b5cff, -7.9, 2.3, 0, 4, Math.PI / 2); neon(0x9b5cff, 7.9, 2.3, 0, 4, Math.PI / 2);
    const l1 = new T.PointLight(0xff3b5c, 0.55, 12, 1.5); l1.position.set(0, 2, -6.8); scene.add(l1);
    const l2 = new T.PointLight(0x3bd7ff, 0.55, 12, 1.5); l2.position.set(0, 2, 6.8); scene.add(l2);
  }

  function buildLamp() {
    lampGroup = new T.Group();
    lampGroup.position.y = 3.1;
    const shade = new T.Mesh(new T.CylinderGeometry(0.16, 0.6, 0.36, 10, 1, true), new T.MeshPhongMaterial({ color: 0x22262b, side: T.DoubleSide, flatShading: true }));
    lampGroup.add(shade);
    const bulb = new T.Mesh(new T.SphereGeometry(0.1, 6, 5), new T.MeshBasicMaterial({ color: 0xfff1c9 }));
    bulb.position.y = -0.1; lampGroup.add(bulb);
    const cord = new T.Mesh(new T.CylinderGeometry(0.012, 0.012, 5, 4), new T.MeshBasicMaterial({ color: 0x050505 }));
    cord.position.y = 2.7; lampGroup.add(cord);
    lampLight = new T.SpotLight(0xffe7b8, 1.5, 0, 1.0, 0.6, 1);
    lampLight.position.set(0, -0.15, 0);
    lampLight.castShadow = true;
    lampLight.shadow.mapSize.set(1024, 1024);
    lampLight.shadow.bias = -0.0006;
    lampLight.shadow.camera.near = 0.5; lampLight.shadow.camera.far = 9;
    lampGroup.add(lampLight);
    const tgt = new T.Object3D(); tgt.position.set(0, -3.1, 0); lampGroup.add(tgt); lampLight.target = tgt;
    scene.add(lampGroup);
    const hemi = new T.HemisphereLight(0x6a7a98, 0x120d0a, 0.62); scene.add(hemi);

    const N = 90, pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = rngTex() * Math.PI * 2, r = Math.sqrt(rngTex()) * 2.2;
      pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = -0.3 + rngTex() * 3; pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    dust = new T.Points(geo, new T.PointsMaterial({ color: 0xfff0d0, size: 0.011, transparent: true, opacity: 0.6, depthWrite: false }));
    scene.add(dust);
  }

  function buildFigure(p) {
    const color = COLORS[p];
    const g = new T.Group();
    const cloth = phong(0x1f222b);
    g.add(box(0.95, 1.15, 0.5, cloth, 0, 0.45, 0));
    g.add(box(1.3, 0.28, 0.56, phong(0x282c37), 0, 1.0, 0));
    const head = new T.Mesh(new T.IcosahedronGeometry(0.28, 0), phong(0x3a3d46));
    head.position.set(0, 1.45, 0); head.castShadow = true;
    const eyeMat = new T.MeshBasicMaterial({ color });
    const eyeL = new T.Mesh(new T.BoxGeometry(0.09, 0.04, 0.02), eyeMat); eyeL.position.set(-0.1, 1.48, 0.25);
    const eyeR = eyeL.clone(); eyeR.position.x = 0.1;
    g.add(head, eyeL, eyeR);
    const strip = new T.Mesh(new T.BoxGeometry(0.5, 0.05, 0.02), eyeMat); strip.position.set(0, 0.85, 0.26); g.add(strip);
    for (const sx of [-1, 1]) {
      const arm = box(0.15, 0.15, 0.7, cloth, sx * 0.62, 0.38, 0.6);
      g.add(arm);
    }
    const cuffs = new T.Group();
    for (const sx of [-1, 1]) {
      const c = new T.Mesh(new T.TorusGeometry(0.1, 0.025, 6, 10), phong(0xb8c0c8, { shininess: 80 }));
      c.position.set(sx * 0.62, 0.4, 0.88); cuffs.add(c);
    }
    cuffs.visible = false; g.add(cuffs);
    const marker = new T.Mesh(new T.ConeGeometry(0.14, 0.28, 4), new T.MeshBasicMaterial({ color }));
    marker.rotation.x = Math.PI; marker.position.set(0, 2.05, 0); marker.visible = false; g.add(marker);
    g.position.set(0, -0.3, side(p) * SEAT_Z);
    g.rotation.y = p === 0 ? Math.PI : 0;
    g.userData = { pick: { kind: 'figure', player: p }, marker, active: false, head, eyeMat, cloth, cuffs, base: g.position.clone(), baseRot: g.rotation.clone(), hit: 0, down: 0, eyeColor: color };
    const hit = new T.Mesh(new T.BoxGeometry(1.4, 1.9, 0.8), new T.MeshBasicMaterial({ visible: false }));
    hit.position.y = 0.7; g.add(hit);
    scene.add(g);
    figures[p] = g;
  }

  function buildGun() {
    gun = new T.Group();
    const steel = phong(0x30343a, { shininess: 70, specular: 0x555555 });
    const wood = phong(0x5a3a22);
    const barrel = cyl(0.033, 0.033, 1.1, 10, steel, 0, 0, 0.55); barrel.rotation.x = Math.PI / 2;
    const tube = cyl(0.028, 0.028, 0.78, 8, steel, 0, -0.075, 0.42); tube.rotation.x = Math.PI / 2;
    const recv = box(0.1, 0.13, 0.36, steel, 0, -0.02, -0.12);
    gunPump = box(0.105, 0.085, 0.28, wood, 0, -0.075, 0.42);
    const stock = box(0.085, 0.14, 0.55, wood, 0, -0.04, -0.56);
    stock.rotation.x = 0.07;
    const guard = mesh(new T.TorusGeometry(0.04, 0.008, 4, 8), steel, 0, -0.1, -0.08); guard.rotation.y = Math.PI / 2;
    gunBarrel = barrel; gunTube = tube;
    gun.add(barrel, tube, recv, gunPump, stock, guard);
    muzzle = new T.Object3D(); muzzle.position.set(0, 0, 1.12); gun.add(muzzle);
    muzzleLight = new T.PointLight(0xffa24d, 0, 7, 1.4); muzzle.add(muzzleLight);
    muzzleCone = new T.Mesh(new T.ConeGeometry(0.11, 0.55, 8, 1, true), new T.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }));
    muzzleCone.rotation.x = -Math.PI / 2; muzzleCone.position.z = 0.28; muzzleCone.visible = false; muzzle.add(muzzleCone);
    const hit = new T.Mesh(new T.BoxGeometry(0.4, 0.4, 1.9), new T.MeshBasicMaterial({ visible: false }));
    hit.position.z = 0.2; gun.add(hit);
    gun.userData = { pick: { kind: 'gun' } };
    gun.scale.setScalar(0.85);
    scene.add(gun);
    setGunPose(restPose());
  }

  // ---------- tư thế súng (theo người đang cầm: p = 0 hoặc 1) ----------
  const _dummy = new T.Object3D();
  function poseFrom(pos, target) {
    _dummy.position.copy(pos); _dummy.lookAt(target);
    return { pos: pos.clone(), quat: _dummy.quaternion.clone() };
  }
  const headPos = (p) => new T.Vector3(0, 1.15, side(p) * SEAT_Z);
  function restPose() { return poseFrom(new T.Vector3(0, 0.07, 0), new T.Vector3(1, 0.07, -0.3)); }
  function holdPose(p) {
    const s = side(p);
    return poseFrom(new T.Vector3(1.0, 0.55, s * 0.95), new T.Vector3(0.6, 0.5, -s * 3));
  }
  function aimOppPose(p) {
    const s = side(p);
    return poseFrom(new T.Vector3(1.0, 0.65, s * 0.95), headPos(1 - p));
  }
  function aimSelfPose(p) {
    const s = side(p);
    return poseFrom(new T.Vector3(1.0, 0.85, s * (SEAT_Z - 1.4)), headPos(p));
  }
  function setGunPose(p) { gun.position.copy(p.pos); gun.quaternion.copy(p.quat); }
  function moveGun(to, dur, e) {
    const p0 = gun.position.clone(), q0 = gun.quaternion.clone();
    return tween(dur, (k) => { gun.position.lerpVectors(p0, to.pos, k); gun.quaternion.copy(q0).slerp(to.quat, k); }, e);
  }

  // ---------- camera: góc nhìn thứ ba cố định, cả hai người cùng xem ----------
  const camParams = { pos: new T.Vector3(0, 4.6, 4.2), look: new T.Vector3(0, 0.2, 0), fov: 48 };
  function fitCamera() {
    const a = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const k = Math.min(1, Math.max(0, (1.6 - a) / (1.6 - 0.5)));   // 0 = ngang, 1 = dọc
    camParams.fov = lerp(48, 58, k);
    camParams.pos.set(0, lerp(4.5, 7.6, k), lerp(4.0, 3.2, k));
    camParams.look.set(0, lerp(0.1, 0.0, k), lerp(0.05, 0.0, k));
    camera.fov = camParams.fov; camera.aspect = a; camera.updateProjectionMatrix();
  }
  function applyCamera() {
    camera.position.copy(camParams.pos);
    if (shakeAmt > 0.0005) {
      camera.position.x += (Math.random() - 0.5) * shakeAmt; camera.position.y += (Math.random() - 0.5) * shakeAmt; camera.position.z += (Math.random() - 0.5) * shakeAmt;
    }
    camera.lookAt(camParams.look);
  }

  // ---------- khởi tạo ----------
  S.init = function (cv) {
    canvas = cv;
    try {
      renderer = new T.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    } catch (e) { return false; }
    if (!renderer.getContext()) return false;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFShadowMap;
    renderer.setClearColor(0x050507);
    scene = new T.Scene();
    scene.fog = new T.FogExp2(0x060608, 0.075);
    camera = new T.PerspectiveCamera(52, 1, 0.1, 40);
    buildTable(); buildRoom(); buildLamp(); buildFigure(0); buildFigure(1); buildGun();

    rt = new T.WebGLRenderTarget(320, 180, { minFilter: T.NearestFilter, magFilter: T.NearestFilter, depthBuffer: true });
    postScene = new T.Scene(); postCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    postMat = new T.ShaderMaterial({
      uniforms: { tDiffuse: { value: rt.texture }, uRes: { value: new T.Vector2(320, 180) }, uTime: { value: 0 }, uFlash: { value: new T.Vector4(1, 1, 1, 0) }, uFade: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: [
        'precision highp float;',
        'uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uTime; uniform vec4 uFlash; uniform float uFade;',
        'varying vec2 vUv;',
        'float b2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }',
        'float b4(vec2 a){ return b2(a) + 0.25 * b2(a * 0.5); }',
        'void main(){',
        '  vec3 col = texture2D(tDiffuse, vUv).rgb;',
        '  vec2 px = floor(vUv * uRes);',
        '  float lv = 15.0;',
        '  col = pow(col, vec3(0.85));',
        '  col = floor(col * lv + 0.5 + (b4(px) - 0.47) * 0.9) / lv;',
        '  col *= 0.94 + 0.06 * sin(vUv.y * uRes.y * 6.2831);',
        '  vec2 cc = vUv - 0.5; col *= clamp(1.0 - dot(cc, cc) * 1.5, 0.0, 1.0);',
        '  float n = fract(sin(dot(px + fract(uTime) * 37.0, vec2(12.9898, 78.233))) * 43758.5453);',
        '  col += (n - 0.5) * 0.035;',
        '  col = mix(col, uFlash.rgb, uFlash.a);',
        '  col *= (1.0 - uFade);',
        '  gl_FragColor = vec4(col, 1.0);',
        '}',
      ].join('\n'),
      depthTest: false, depthWrite: false,
    });
    postScene.add(new T.Mesh(new T.PlaneGeometry(2, 2), postMat));

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', () => setHover(null));
    window.addEventListener('resize', S.resize);
    S.resize();
    applyCamera();
    S.ok = true;
    lastT = performance.now();
    rafId = requestAnimationFrame(loop);
    return true;
  };

  S.resize = function () {
    if (!renderer) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.clientWidth || 640, ch = canvas.clientHeight || 360;
    renderer.setPixelRatio(dpr);
    renderer.setSize(cw, ch, false);
    const th = Math.max(180, Math.min(340, Math.round(ch / 2.4)));
    const tw = Math.max(120, Math.round(th * cw / ch));
    rt.setSize(tw, th);
    postMat.uniforms.uRes.value.set(tw, th);
    fitCamera();
    applyCamera();
  };

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    time += dt;
    updateTweens(dt);
    idle(dt);
    applyCamera();
    postMat.uniforms.uTime.value = time;
    try {
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCam);
    } catch (err) { console.error(err); cancelAnimationFrame(rafId); }
  }

  const _tmp = new T.Vector3();
  function idle(dt) {
    shakeAmt *= Math.pow(0.002, dt);
    lampGroup.rotation.z = Math.sin(time * 0.7) * 0.025; lampGroup.rotation.x = Math.cos(time * 0.53) * 0.02;
    const flick = Math.sin(time * 41) * Math.sin(time * 7.3);
    lampLight.intensity = 1.5 + (flick > 0.96 ? -0.7 : 0) + Math.sin(time * 2.1) * 0.05;
    const pa = dust.geometry.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      pa.array[i * 3 + 1] -= dt * 0.03; pa.array[i * 3] += Math.sin(time + i) * dt * 0.01;
      if (pa.array[i * 3 + 1] < -0.4) pa.array[i * 3 + 1] = 2.6;
    }
    pa.needsUpdate = true;
    for (let p = 0; p < 2; p++) {
      const f = figures[p], u = f.userData;
      u.hit = Math.max(0, u.hit - dt * 3);
      const breathe = Math.sin(time * 1.6 + p) * 0.012;
      f.position.set(u.base.x + (Math.random() - 0.5) * u.hit * 0.1, u.base.y + breathe - u.down * 0.3, u.base.z);
      u.head.rotation.x = u.down * 0.6 + Math.sin(time * 0.9 + p) * 0.03;
      u.cloth.emissive.setRGB(u.hit * 0.9, 0, 0);
      u.eyeMat.color.setHex(u.down > 0.5 ? 0x222222 : u.eyeColor).multiplyScalar(u.active ? 1 : 0.35);
      u.marker.visible = u.active && u.down < 0.5;
      u.marker.position.y = 2.05 + Math.sin(time * 3.2) * 0.07;
      u.marker.rotation.y += dt * 2;
    }
    // ô vật phẩm nhấp nháy khi là mục tiêu
    for (let p = 0; p < 2; p++) for (let s = 0; s < 8; s++) {
      const m = slotMarkers[p][s], st = m.userData.state;
      if (st === 'target') m.material.opacity = 0.6 + 0.4 * Math.sin(time * 8);
    }
  }

  // ---------- chọn đối tượng bằng chuột / chạm ----------
  const ray = new T.Raycaster(), ndc = new T.Vector2();
  function pickAt(ev) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const targets = [gun, figures[0], figures[1]];
    for (let p = 0; p < 2; p++) for (let s = 0; s < 8; s++) if (itemMeshes[p][s]) targets.push(itemMeshes[p][s]);
    const hits = ray.intersectObjects(targets, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !(o.userData && o.userData.pick)) o = o.parent;
      if (!o) continue;
      const pk = o.userData.pick;
      if (pk.kind === 'gun' && (!gunPickable || !gunAtRest)) continue;
      return pk;
    }
    return null;
  }
  function onPointerDown(ev) {
    if (ev.button > 0) return;
    const pk = pickAt(ev);
    if (pickHandler.fn) pickHandler.fn(pk);
  }
  function onPointerMove(ev) {
    if (ev.pointerType !== 'mouse') return;
    const pk = pickAt(ev);
    setHover(pk);
  }
  function setHover(pk) {
    const key = pk ? pk.kind + ':' + (pk.player != null ? pk.player : '') + ':' + (pk.slot != null ? pk.slot : '') : null;
    if (key === hoverKey) return;
    hoverKey = key;
    canvas.style.cursor = pk && (pk.kind === 'gun' || pk.kind === 'item') ? 'pointer' : 'default';
    for (let p = 0; p < 2; p++) for (let s = 0; s < 8; s++) refreshMarker(p, s);
    const glow = pk && pk.kind === 'gun';
    gun.traverse((o) => { if (o.isMesh && o.material && o.material.emissive) o.material.emissive.setHex(glow ? 0x332a10 : 0x000000); });
  }
  S.onPick = (fn) => { pickHandler.fn = fn; };

  // ---------- trạng thái ô ----------
  const STATE_COLOR = { none: 0x7d8a82, selected: 0xffd24a, target: 0xff4d4d, usable: 0x7fd18b };
  function refreshMarker(p, s) {
    const m = slotMarkers[p][s];
    const st = m.userData.state || 'none';
    let color = STATE_COLOR[st], op = st === 'none' ? 0.7 : 0.95;
    if (st === 'none' && hoverKey === 'item:' + p + ':' + s) { color = 0xffffff; op = 0.9; }
    m.material.color.setHex(color); m.material.opacity = op;
  }
  S.setSlotState = (p, s, state) => { slotMarkers[p][s].userData.state = state; refreshMarker(p, s); };
  S.clearSlotStates = () => { for (let p = 0; p < 2; p++) for (let s = 0; s < 8; s++) S.setSlotState(p, s, 'none'); };

  // ---------- vật phẩm ----------
  function makeItemMesh(id, p, s) {
    const g = ITEM_MAKERS[id]();
    const wrap = new T.Group(); wrap.add(g);
    const hit = new T.Mesh(new T.BoxGeometry(0.58, 0.5, 0.42), new T.MeshBasicMaterial({ visible: false }));
    hit.position.y = 0.2; wrap.add(hit);
    wrap.userData = { pick: { kind: 'item', player: p, slot: s }, id };
    const pos = slotPos(p, s);
    wrap.position.copy(pos);
    return wrap;
  }
  S.placeItem = function (p, s, id, animate) {
    const old = itemMeshes[p][s]; if (old) { scene.remove(old); itemMeshes[p][s] = null; }
    if (!id) return Promise.resolve();
    const m = makeItemMesh(id, p, s);
    itemMeshes[p][s] = m; scene.add(m);
    if (!animate) return Promise.resolve();
    const y1 = 1.4; m.position.y = y1; m.scale.setScalar(0.01);
    return tween(0.35, (k) => { m.position.y = lerp(y1, 0, k); m.scale.setScalar(lerp(0.01, 1, Math.min(1, k * 1.4))); }, ease.out);
  };
  S.clearItems = function () {
    for (let p = 0; p < 2; p++) for (let s = 0; s < 8; s++) if (itemMeshes[p][s]) { scene.remove(itemMeshes[p][s]); itemMeshes[p][s] = null; }
    S.clearSlotStates();
  };
  S.hasItem = (p, s) => !!itemMeshes[p][s];

  function puff(pos, color) {
    const parts = [];
    for (let i = 0; i < 10; i++) {
      const m = new T.Mesh(new T.BoxGeometry(0.05, 0.05, 0.05), new T.MeshBasicMaterial({ color: color || 0xffffff, transparent: true }));
      m.position.copy(pos); scene.add(m);
      parts.push({ m, v: new T.Vector3((Math.random() - 0.5) * 1.2, Math.random() * 1.0, (Math.random() - 0.5) * 1.2) });
    }
    return tween(0.5, (k) => parts.forEach((q) => {
      q.m.position.addScaledVector(q.v, 0.016); q.m.material.opacity = 1 - k; q.m.scale.setScalar(1 - k * 0.8);
    }), ease.lin).then(() => parts.forEach((q) => { scene.remove(q.m); q.m.geometry.dispose(); q.m.material.dispose(); }));
  }

  // Vật phẩm bay lên, tới trước mặt người dùng, rồi biến mất. `user` là người đang dùng.
  S.useItem = async function (owner, slot, user) {
    const m = itemMeshes[owner][slot];
    if (!m) return;
    itemMeshes[owner][slot] = null;
    m.userData.pick = null;
    const start = m.position.clone();
    const us = side(user);
    const mid = new T.Vector3(start.x * 0.3, 0.95, us * 0.55);
    await tween(0.45, (k) => {
      m.position.lerpVectors(start, mid, k); m.position.y = lerp(start.y, 0.95, k) + Math.sin(k * Math.PI) * 0.25;
      m.rotation.y += 0.12;
    }, ease.io);
    await wait(0.45);
    await Promise.all([puff(mid, 0xffffff), tween(0.25, (k) => m.scale.setScalar(1 - k), ease.in)]);
    scene.remove(m);
  };

  // ---------- đạn ----------
  function makeShell(kind) {
    const g = new T.Group();
    g.add(cyl(0.045, 0.045, 0.14, 8, phong(kind === 'live' ? 0xc8372d : 0x2f5fc8, { emissive: kind === 'live' ? 0x300806 : 0x081030 }), 0, 0.07, 0));
    g.add(cyl(0.048, 0.048, 0.04, 8, phong(0xc9a24a, { shininess: 60 }), 0, 0.02, 0));
    return g;
  }
  S.showLoad = async function (live, blank) {
    const kinds = [];
    for (let i = 0; i < live; i++) kinds.push('live');
    for (let i = 0; i < blank; i++) kinds.push('blank');
    for (let i = kinds.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
    const n = kinds.length, group = [];
    const spacing = 0.2;
    kinds.forEach((k, i) => {
      const m = makeShell(k);
      m.userData.base = new T.Vector3((i - (n - 1) / 2) * spacing, 0, 0.4);
      m.position.copy(m.userData.base); m.position.y = 1.2;
      m.scale.setScalar(0.01);
      scene.add(m); group.push(m);
    });
    await Promise.all(group.map((m, i) => wait(i * 0.07).then(() => {
      root.SRAudio && root.SRAudio.play('shell');
      const b = m.userData.base;
      return tween(0.3, (k) => { m.position.set(b.x, lerp(1.2, 0, k), b.z); m.scale.setScalar(Math.min(1, k * 1.5 + 0.01)); }, ease.out);
    })));
    await wait(1.7);
    await Promise.all(group.map((m, i) => wait(i * 0.05).then(() => {
      root.SRAudio && root.SRAudio.play('shell');
      const p0 = m.position.clone();
      return tween(0.3, (k) => { m.position.lerpVectors(p0, new T.Vector3(0.3, 0.1, 0), k); m.scale.setScalar(1 - k); }, ease.in);
    })));
    group.forEach((m) => scene.remove(m));
  };

  S.ejectShell = async function (kind, fromGun) {
    const m = makeShell(kind); m.scale.setScalar(1.3);
    const from = fromGun ? gun.localToWorld(new T.Vector3(0.07, 0.05, -0.02)) : new T.Vector3(0.1, 0.25, 0);
    m.position.copy(from); scene.add(m);
    const vel = new T.Vector3(0.9, 1.6, -side(curP) * 0.35);
    const p0 = from.clone();
    const dur = 0.55;
    await tween(dur, (k) => {
      const t = k * dur;
      m.position.set(p0.x + vel.x * t, Math.max(0, p0.y + vel.y * t - 4.5 * t * t), p0.z + vel.z * t);
      m.rotation.x += 0.3; m.rotation.z += 0.2;
    }, ease.lin);
    m.rotation.set(Math.PI / 2, 0, 0); m.position.y = 0.045;
    root.SRAudio && root.SRAudio.play('shell');
    await wait(1.1);
    await tween(0.25, (k) => m.scale.setScalar(1.3 * (1 - k)), ease.in);
    scene.remove(m);
  };

  // ---------- súng ----------
  S.setGunPickable = (b) => { gunPickable = b; };
  S.gunTake = async function (p) {
    curP = p; gunAtRest = false;
    root.SRAudio && root.SRAudio.play('whoosh');
    await moveGun(holdPose(p), 0.5, ease.io);
  };
  S.gunAim = async function (p, who) {
    curP = p;
    await moveGun(who === 'self' ? aimSelfPose(p) : aimOppPose(p), 0.45, ease.io);
  };
  S.gunRest = async function () {
    await moveGun(restPose(), 0.5, ease.io);
    gunAtRest = true;
  };
  S.setGunSawed = function (b) {
    const k = b ? 0.55 : 1;
    gunBarrel.scale.y = k; gunBarrel.position.z = 0.55 * k;
    gunTube.scale.y = k; gunTube.position.z = 0.42 * (b ? 0.8 : 1);
    muzzle.position.z = 1.12 * k;
  };
  S.gunFire = async function (shell, selfShot) {
    const base = { pos: gun.position.clone(), quat: gun.quaternion.clone() };
    if (shell === 'live') {
      const fwd = new T.Vector3(0, 0, 1).applyQuaternion(base.quat);
      muzzleLight.intensity = 6; muzzleCone.visible = true; muzzleCone.scale.setScalar(0.8 + Math.random() * 0.5);
      shakeAmt = selfShot ? 0.28 : 0.2;
      S.flash(selfShot ? 0xff2a1a : 0xffffff, selfShot ? 0.85 : 0.7, 0.35);
      const p1 = base.pos.clone().addScaledVector(fwd, -0.16).add(new T.Vector3(0, 0.07, 0));
      await tween(0.07, (k) => gun.position.lerpVectors(base.pos, p1, k), ease.out);
      muzzleCone.visible = false;
      const l0 = muzzleLight.intensity;
      await tween(0.3, (k) => { gun.position.lerpVectors(p1, base.pos, k); muzzleLight.intensity = l0 * (1 - k); }, ease.out);
      muzzleLight.intensity = 0;
    } else {
      shakeAmt = 0.02;
      await tween(0.05, (k) => { gun.position.y = base.pos.y + k * 0.02; }, ease.lin);
      await tween(0.12, (k) => { gun.position.y = base.pos.y + (1 - k) * 0.02; }, ease.lin);
    }
  };
  S.gunPump = async function (shell) {
    root.SRAudio && root.SRAudio.play('pump');
    const z0 = gunPump.position.z;
    const eject = shell ? S.ejectShell(shell, true) : Promise.resolve();
    await tween(0.18, (k) => { gunPump.position.z = z0 - 0.16 * k; }, ease.out);
    await tween(0.18, (k) => { gunPump.position.z = z0 - 0.16 * (1 - k); }, ease.in);
    gunPump.position.z = z0;
    await eject;
  };

  // ---------- nhân vật & hiệu ứng màn hình ----------
  S.hitFigure = (p) => { figures[p].userData.hit = 1; };
  S.setFigureDown = (p, down) => tween(0.7, (k) => { const u = figures[p].userData; u.down = down ? k : 1 - k; }, ease.out);
  S.resetFigures = () => { figures.forEach((f) => { f.userData.down = 0; f.userData.hit = 0; f.userData.cuffs.visible = false; }); };
  S.setFigureCuffed = (p, b) => { figures[p].userData.cuffs.visible = !!b; };
  S.flash = function (hex, amt, dur) {
    const u = postMat.uniforms.uFlash.value;
    u.set(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255, amt);
    return tween(dur, (k) => { u.w = amt * (1 - k); }, ease.out);
  };
  S.shake = (a) => { shakeAmt = Math.max(shakeAmt, a); };
  S.fade = (to, dur) => { const u = postMat.uniforms.uFade; const from = u.value; return tween(dur, (k) => { u.value = lerp(from, to, k); }, ease.io); };
  S.setTurn = (p) => { figures.forEach((f, i) => { f.userData.active = i === p; }); };
  S.itemAt = (p, s) => (itemMeshes[p][s] ? itemMeshes[p][s].userData.id : null);
  S.setSpeed = (v) => { S.speed = v; };
  S.wait = wait;
  S.THREE_DEBUG = () => ({ scene, camera, renderer, gun, figures, itemMeshes });

  root.SRScene = S;
})(window);

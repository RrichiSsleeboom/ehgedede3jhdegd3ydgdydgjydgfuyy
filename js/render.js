/*
 * Isometric canvas renderer. Reads the city state and draws it; it never
 * modifies the simulation. Requires window.Sim to be loaded first.
 */
(function () {
  'use strict';

  const TW = 64; // tile diamond width at zoom 1
  const TH = 32; // tile diamond height at zoom 1
  const ELEV = 14; // screen pixels per elevation level at zoom 1
  const GRASS = ['#5fae4f', '#69b859', '#58a449'];
  const WATER = ['#2f73c4', '#3a82d6'];
  const EARTH = '#7d5f3f';
  const ZONE_TINT = {
    R: 'rgba(120, 220, 120, 0.42)',
    C: 'rgba(90, 160, 255, 0.42)',
    I: 'rgba(240, 200, 80, 0.42)',
  };
  const HOUSE_WALLS = ['#f4e4c1', '#e9d2a6', '#cfe6f0', '#f3c3c0', '#d8e8c8'];
  const HOUSE_ROOFS = ['#a4482e', '#7a3b2e', '#3d5a80', '#6b4f3a', '#8b5e3c'];
  const ASPHALT = '#4a4f57';
  const AVENUE_ASPHALT = '#5c616b';
  const JAM = '#c9483a';

  // Stable pseudo-random value per tile, so colours don't flicker between frames.
  function hash(x, y) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }

  function parseHex(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Multiplies a #rrggbb colour's brightness by f and returns an rgb() string.
  function shade(hex, f) {
    const [r, g, b] = parseHex(hex).map((v) => Math.min(255, Math.round(v * f)));
    return `rgb(${r},${g},${b})`;
  }

  // Blends two #rrggbb colours; t = 0 gives a, t = 1 gives b.
  function mixHex(a, b, t) {
    const A = parseHex(a);
    const B = parseHex(b);
    return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`;
  }

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cam = { x: 0, y: 0, zoom: 1 };
      this.hover = null;
      this.selected = null;
      this.preview = new Map(); // tile index -> ok (boolean)
      this.night = 0; // 0 = day, 1 = full night
      this.time = 0;
      this.w = 0;
      this.h = 0;
      this.dpr = 1;
      this.city = null; // set during draw(), used by overlays and picking
      this.resize();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.w = rect.width;
      this.h = rect.height;
      this.canvas.width = Math.max(1, Math.round(this.w * this.dpr));
      this.canvas.height = Math.max(1, Math.round(this.h * this.dpr));
    }

    centerOn(size) {
      this.cam.x = this.w / 2;
      this.cam.y = this.h / 2 - (size * TH) / 2 * this.cam.zoom;
    }

    setZoom(zoom, sx, sy) {
      const before = this.unproject(sx, sy);
      this.cam.zoom = zoom;
      this.cam.x = sx - (before.x - before.y) * (TW / 2) * zoom;
      this.cam.y = sy - (before.x + before.y) * (TH / 2) * zoom;
    }

    // Sets the zoom so world point (wx, wy) stays under screen point (sx, sy).
    zoomAt(zoom, wx, wy, sx, sy) {
      this.cam.zoom = zoom;
      this.cam.x = sx - (wx - wy) * (TW / 2) * zoom;
      this.cam.y = sy - (wx + wy) * (TH / 2) * zoom;
    }

    // World (x, y) at elevation level `lift` to screen coordinates.
    project(x, y, lift) {
      const z = this.cam.zoom;
      return {
        x: (x - y) * (TW / 2) * z + this.cam.x,
        y: (x + y) * (TH / 2) * z + this.cam.y - (lift || 0) * ELEV * z,
      };
    }

    // Screen coordinates to world coordinates on the flat ground plane (level 0).
    unproject(sx, sy) {
      const z = this.cam.zoom;
      const a = (sx - this.cam.x) / ((TW / 2) * z);
      const b = (sy - this.cam.y) / ((TH / 2) * z);
      return { x: (a + b) / 2, y: (b - a) / 2 };
    }

    // The tile under the cursor. Raised tiles are hit at their raised position:
    // a tile at level e is hit where its raised top appears on screen.
    tileAt(sx, sy) {
      const Sim = window.Sim;
      const z = this.cam.zoom;
      for (let e = Sim.MAX_ELEVATION; e >= 0; e--) {
        const p = this.unproject(sx, sy + e * ELEV * z);
        const x = Math.floor(p.x);
        const y = Math.floor(p.y);
        if (!Sim.inBounds(x, y)) continue;
        if (this.city && this.city.tiles[y * Sim.SIZE + x].el === e) return { x, y };
      }
      const p = this.unproject(sx, sy);
      const x = Math.floor(p.x);
      const y = Math.floor(p.y);
      if (!Sim.inBounds(x, y)) return null;
      return { x, y };
    }

    elevationAt(x, y) {
      if (!this.city) return 0;
      return this.city.tiles[y * this.city.size + x].el;
    }

    draw(city) {
      const ctx = this.ctx;
      const N = city.size || window.Sim.SIZE;
      this.city = city;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = this.night > 0.5 ? '#0f1a2e' : '#7cc4f0';
      ctx.fillRect(0, 0, this.w, this.h);

      // Painter's algorithm: draw by increasing x + y so nearer tiles overlap farther ones.
      for (let d = 0; d <= 2 * N - 2; d++) {
        const x0 = Math.max(0, d - (N - 1));
        const x1 = Math.min(d, N - 1);
        for (let x = x0; x <= x1; x++) this.drawTile(city, x, d - x);
      }

      if (this.night > 0) {
        ctx.fillStyle = `rgba(8, 16, 48, ${(0.5 * this.night).toFixed(3)})`;
        ctx.fillRect(0, 0, this.w, this.h);
      }
      this.drawOverlays(city);
    }

    diamondPath(x, y, lift) {
      const ctx = this.ctx;
      const p0 = this.project(x, y, lift);
      const p1 = this.project(x + 1, y, lift);
      const p2 = this.project(x + 1, y + 1, lift);
      const p3 = this.project(x, y + 1, lift);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.lineTo(p3.x, p3.y);
      ctx.closePath();
    }

    drawTile(city, x, y) {
      const ctx = this.ctx;
      const N = city.size;
      const idx = y * N + x;
      const t = city.tiles[idx];
      const z = this.cam.zoom;
      const e = t.el;

      // Cull tiles that are clearly off screen.
      const c = this.project(x + 0.5, y + 0.5, e);
      if (c.x < -TW * z || c.x > this.w + TW * z || c.y < -120 * z || c.y > this.h + TH * z) return;

      const hv = hash(x, y);

      if (t.g === 'water') {
        const wave = 0.5 + 0.5 * Math.sin(this.time * 1.6 + x * 0.6 + y * 0.9);
        ctx.fillStyle = WATER[wave > 0.5 ? 1 : 0];
        this.diamondPath(x, y, 0);
        ctx.fill();
        if (t.road) this.drawRoad(city, x, y); // bridge
        return;
      }

      this.drawCliffs(city, x, y, t);

      ctx.fillStyle = shade(GRASS[hv % GRASS.length], 1 + 0.07 * e);
      this.diamondPath(x, y, e);
      ctx.fill();

      if (t.z) {
        ctx.fillStyle = ZONE_TINT[t.z];
        this.diamondPath(x, y, e);
        ctx.fill();
      }

      if (t.road) this.drawRoad(city, x, y);

      if (t.tree && !t.b && !t.road) this.drawTree(c.x, c.y, z, hv);

      if (t.b) {
        if (window.Sim.isService(t.b.t)) this.drawService(x, y, t, hv);
        else this.drawZoneBuilding(x, y, t, hv);
      }
    }

    // Visible side faces where this tile is higher than its neighbour to the
    // south-east (+x or +y). Tiles at the map edge get no cliff.
    drawCliffs(city, x, y, t) {
      const ctx = this.ctx;
      const N = city.size;
      const e = t.el;
      const faces = [];
      if (x + 1 < N) {
        const en = city.tiles[y * N + x + 1].el;
        if (en < e) {
          faces.push([this.project(x + 1, y, e), this.project(x + 1, y + 1, e), this.project(x + 1, y + 1, en), this.project(x + 1, y, en), 0.8]);
        }
      }
      if (y + 1 < N) {
        const en = city.tiles[(y + 1) * N + x].el;
        if (en < e) {
          faces.push([this.project(x, y + 1, e), this.project(x + 1, y + 1, e), this.project(x + 1, y + 1, en), this.project(x, y + 1, en), 0.6]);
        }
      }
      for (const [a, b, c, d, f] of faces) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
        ctx.lineTo(d.x, d.y);
        ctx.closePath();
        ctx.fillStyle = shade(EARTH, f);
        ctx.fill();
      }
    }

    drawRoad(city, x, y) {
      const ctx = this.ctx;
      const N = city.size;
      const z = this.cam.zoom;
      const t = city.tiles[y * N + x];
      const cen = this.project(x + 0.5, y + 0.5, t.el);
      const arms = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        if (city.tiles[ny * N + nx].road) arms.push([nx, ny]);
      }

      const base = t.avenue ? AVENUE_ASPHALT : ASPHALT;
      const color = t.cong > 0.5 ? mixHex(base, JAM, Math.min(1, (t.cong - 0.5) / 1.0)) : base;
      const width = TW * (t.avenue ? 0.52 : 0.36) * z;

      ctx.lineCap = 'butt';
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      for (const [nx, ny] of arms) {
        const p = this.project(nx + 0.5, ny + 0.5, city.tiles[ny * N + nx].el);
        ctx.beginPath();
        ctx.moveTo(cen.x, cen.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      // Junction disc, so isolated road tiles and corners look finished.
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(cen.x, cen.y, width / 2, width / 4, 0, 0, Math.PI * 2);
      ctx.fill();

      // Centre markings: white dashes for streets, yellow for avenues.
      ctx.strokeStyle = t.avenue ? 'rgba(242, 209, 107, 0.9)' : 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = Math.max(1, (t.avenue ? 1.5 : 1.1) * z);
      ctx.setLineDash([4 * z, 4 * z]);
      for (const [nx, ny] of arms) {
        const p = this.project(nx + 0.5, ny + 0.5, city.tiles[ny * N + nx].el);
        ctx.beginPath();
        ctx.moveTo(cen.x, cen.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    drawTree(cx, cy, z, hv) {
      const ctx = this.ctx;
      const r = 6.5 * z;
      ctx.fillStyle = '#6b4a2b';
      ctx.fillRect(cx - 1 * z, cy - 2 * z, 2 * z, 6 * z);
      ctx.fillStyle = ['#2e6b2e', '#357a35', '#2a5f3a'][hv % 3];
      ctx.beginPath();
      ctx.ellipse(cx, cy - 9 * z, r * 1.1, r * 1.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draws a box standing on tile (x, y) at its elevation. Returns its corners.
    drawBox(x, y, a, hPx, top, right, left, lift) {
      const ctx = this.ctx;
      const z = this.cam.zoom;
      const base = [
        [x + a, y + a],
        [x + 1 - a, y + a],
        [x + 1 - a, y + 1 - a],
        [x + a, y + 1 - a],
      ].map(([wx, wy]) => this.project(wx, wy, lift));
      const up = hPx * z;
      const tp = base.map((p) => ({ x: p.x, y: p.y - up }));

      const poly = (pts, color) => {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };
      poly([base[1], base[2], tp[2], tp[1]], right);
      poly([base[2], base[3], tp[3], tp[2]], left);
      poly(tp, top);
      return { base, tp };
    }

    drawNightWindows(base, tp, count) {
      if (this.night < 0.3) return;
      const ctx = this.ctx;
      const z = this.cam.zoom;
      ctx.fillStyle = `rgba(255, 220, 120, ${this.night.toFixed(2)})`;
      for (let k = 0; k < count; k++) {
        const s = (k + 1) / (count + 1);
        // Point on the front-right edge, halfway up the wall.
        const bx = base[1].x + (base[2].x - base[1].x) * s;
        const by = base[1].y + (base[2].y - base[1].y) * s;
        const tx = tp[1].x + (tp[2].x - tp[1].x) * s;
        const ty = tp[1].y + (tp[2].y - tp[1].y) * s;
        ctx.fillRect((bx + tx) / 2 - 1.5 * z, (by + ty) / 2 - 2 * z, 3 * z, 4 * z);
      }
    }

    drawZoneBuilding(x, y, t, hv) {
      const b = t.b;
      const lvl = b.lvl;
      let h;
      let a;
      let walls;
      let roof;
      if (b.t === 'R') {
        h = [0, 12, 20, 34][lvl];
        a = 0.2;
        walls = HOUSE_WALLS[hv % HOUSE_WALLS.length];
        roof = HOUSE_ROOFS[(hv >>> 3) % HOUSE_ROOFS.length];
      } else if (b.t === 'C') {
        h = [0, 18, 30, 46][lvl];
        a = 0.14;
        walls = '#9cc3e8';
        roof = '#dce9f7';
      } else {
        h = [0, 12, 18, 26][lvl];
        a = 0.12;
        walls = '#a9a9a9';
        roof = '#c4b15a';
      }
      // Buildings that are not operating are drawn darker.
      const f = t.occ ? 1 : 0.55;
      const wallsC = f < 1 ? shade(walls, f) : walls;
      const roofC = f < 1 ? shade(roof, f) : roof;
      const { base, tp } = this.drawBox(x, y, a, h, roofC, wallsC, shade(walls, 0.8 * f), t.el);

      if (b.t === 'I') {
        // Chimney.
        this.drawBox(x, y, 0.36, h + 14, '#5d5d5d', '#444', '#333', t.el);
      }
      if (b.t !== 'I' && t.occ) this.drawNightWindows(base, tp, lvl + 1);
    }

    drawService(x, y, t, hv) {
      const ctx = this.ctx;
      const z = this.cam.zoom;
      const type = t.b.t;
      const info = window.Sim.SERVICE_INFO[type];

      if (type === 'park') {
        ctx.fillStyle = '#2e8b3d';
        this.diamondPath(x, y, t.el);
        ctx.fill();
        const offsets = [[0.3, 0.3], [0.7, 0.4], [0.5, 0.7]];
        for (let i = 0; i < offsets.length; i++) {
          const p = this.project(x + offsets[i][0], y + offsets[i][1], t.el);
          this.drawTree(p.x, p.y, z * 0.8, hv + i);
        }
        return;
      }

      const heights = { power: 34, water: 22, hospital: 30, metro: 14 };
      const h = heights[type] || 16;
      const { tp } = this.drawBox(x, y, 0.2, h, info.color, shade(info.color, 0.8), shade(info.color, 0.6), t.el);
      const cx = (tp[0].x + tp[2].x) / 2;
      const cy = (tp[0].y + tp[2].y) / 2;
      ctx.font = `bold ${Math.max(8, 11 * z)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2, 2.5 * z);
      ctx.strokeStyle = 'rgba(20, 20, 20, 0.7)';
      ctx.strokeText(info.letter, cx, cy);
      ctx.fillStyle = '#fff';
      ctx.fillText(info.letter, cx, cy);
    }

    drawOverlays(city) {
      const ctx = this.ctx;
      const N = city.size;
      for (const [idx, ok] of this.preview) {
        const x = idx % N;
        const y = (idx - x) / N;
        ctx.fillStyle = ok ? 'rgba(90, 255, 140, 0.38)' : 'rgba(255, 90, 90, 0.38)';
        this.diamondPath(x, y, city.tiles[idx].el);
        ctx.fill();
      }
      if (this.selected) {
        ctx.strokeStyle = '#ffd54f';
        ctx.lineWidth = 2;
        this.diamondPath(this.selected.x, this.selected.y, this.elevationAt(this.selected.x, this.selected.y));
        ctx.stroke();
      }
      if (this.hover) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.lineWidth = 1.5;
        this.diamondPath(this.hover.x, this.hover.y, this.elevationAt(this.hover.x, this.hover.y));
        ctx.stroke();
      }
    }
  }

  window.Renderer = Renderer;
})();

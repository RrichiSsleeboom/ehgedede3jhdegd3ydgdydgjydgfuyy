/*
 * City simulation core. Pure logic, no DOM access, so it runs both in the
 * browser (exposed as window.Sim) and in Node (module.exports) for tests.
 *
 * Model overview
 *  - The map is a SIZE x SIZE grid of tiles. Land has elevation levels (0..3),
 *    some tiles are water (lakes, or a river that can be bridged).
 *  - Players lay streets and avenues, paint residential / commercial / industrial
 *    zones and place services and utilities.
 *  - Road networks are flood-filled. Everything touching a road belongs to that
 *    network. Utilities only work if they touch a road, so a power plant must
 *    be connected to the zones it should power.
 *  - Residents commute over the road network to the nearest reachable job.
 *    Each road tile has a capacity; overloaded roads jam and unhappy residents.
 *  - Zoned buildings grow when there is demand, get upgraded when happy and
 *    prosperous, and decay when disconnected or unhappy.
 *  - Each simulated day collects taxes and pays upkeep.
 */
(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.Sim = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SIZE = 64;
  const DAY_SECONDS = 4; // real seconds per game day at 1x speed
  const START_MONEY = 40000;
  const DEFAULT_TAX = 0.09;
  const MAX_LEVEL = 3;
  const MAX_ELEVATION = 3;
  const BULLDOZE_COST = 10;
  const TREE_COST = 2;
  const BRIDGE_COST = 80; // extra cost per river tile on top of the road
  const SAVE_VERSION = 2;
  const MILESTONES = [50, 100, 250, 500, 1000, 2500, 5000, 10000];

  const ROAD = {
    street: { cost: 20, upkeep: 0.25, capacity: 60 },
    avenue: { cost: 60, upgradeCost: 40, upkeep: 0.6, capacity: 150 },
    highway: { cost: 120, upgradeCost: 80, upkeep: 1.2, capacity: 240 },
  };
  const HIGHWAY_PREFAB_LENGTH = 12;

  // Level index 0 is unused so that b.lvl (1..3) can index directly.
  const ZONE_INFO = {
    R: {
      name: 'Woonwijk',
      capacity: [0, 6, 14, 30],
      jobs: [0, 0, 0, 0],
      tax: [0, 2, 4, 7],
      power: [0, 2, 4, 7],
      water: [0, 1.5, 3, 5],
      pollution: [0, 0, 0, 0],
    },
    C: {
      name: 'Commercieel',
      capacity: [0, 0, 0, 0],
      jobs: [0, 5, 12, 25],
      tax: [0, 3, 6, 10],
      power: [0, 3, 6, 10],
      water: [0, 1, 2, 3],
      pollution: [0, 0, 0, 0],
    },
    I: {
      name: 'Industrie',
      capacity: [0, 0, 0, 0],
      jobs: [0, 8, 18, 35],
      tax: [0, 4, 7, 11],
      power: [0, 5, 9, 14],
      water: [0, 2, 4, 6],
      pollution: [0, 1, 2, 3],
    },
  };

  const SERVICE_INFO = {
    park: { name: 'Park', cost: 400, upkeep: 2, radius: 6, letter: 'P', color: '#43a047' },
    police: { name: 'Politiebureau', cost: 1500, upkeep: 8, radius: 10, letter: 'Po', color: '#3949ab' },
    fire: { name: 'Brandweerkazerne', cost: 1500, upkeep: 8, radius: 10, letter: 'Br', color: '#e53935' },
    school: { name: 'School', cost: 2500, upkeep: 12, radius: 8, letter: 'S', color: '#fb8c00' },
    hospital: { name: 'Ziekenhuis', cost: 4000, upkeep: 15, radius: 10, letter: 'H', color: '#ef5350' },
    metro: { name: 'Metrostation', cost: 6000, upkeep: 18, radius: 4, letter: 'M', color: '#7e57c2' },
    power: { name: 'Elektriciteitscentrale', cost: 8000, upkeep: 30, supply: 300, letter: 'E', color: '#fdd835' },
    water: { name: 'Waterpomp', cost: 3000, upkeep: 12, supply: 400, letter: 'W', color: '#039be5' },
  };

  const isZone = (type) => Object.prototype.hasOwnProperty.call(ZONE_INFO, type);
  const isService = (type) => Object.prototype.hasOwnProperty.call(SERVICE_INFO, type);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const tileIndex = (x, y) => y * SIZE + x;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE;

  // Deterministic PRNG (mulberry32) so terrain is reproducible from a seed.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Smooth value noise on a coarse lattice with the given cell size.
  function makeNoise(rand, cell) {
    const G = Math.ceil(SIZE / cell) + 2;
    const grid = new Float32Array(G * G);
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    return function (x, y) {
      const gx = x / cell;
      const gy = y / cell;
      const ix = Math.floor(gx);
      const iy = Math.floor(gy);
      let fx = gx - ix;
      let fy = gy - iy;
      fx = fx * fx * (3 - 2 * fx);
      fy = fy * fy * (3 - 2 * fy);
      const a = grid[iy * G + ix];
      const b = grid[iy * G + ix + 1];
      const c = grid[(iy + 1) * G + ix];
      const d = grid[(iy + 1) * G + ix + 1];
      return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
    };
  }

  function makeTile(terrain) {
    return {
      g: terrain, // 'grass' | 'water'
      el: 0, // elevation level 0..MAX_ELEVATION (land only; water is 0)
      river: false, // water tile that belongs to a river (bridgeable)
      tree: false,
      road: false,
      avenue: false, // wider road with more capacity (only meaningful when road)
      hwy: false, // highway: the widest road, nearby homes get noisier
      z: null, // zone painted on the tile: 'R' | 'C' | 'I' | null
      b: null, // building: { t: 'R'|'C'|'I'|serviceKey, lvl }
      // Derived state, recomputed by refreshNetworks / simulateDay:
      net: -1,
      powered: false,
      watered: false,
      occ: false,
      happy: 0,
      cong: 0, // road congestion: load / capacity (roads), or the worst adjacent road
    };
  }

  function generateTerrain(seed) {
    const rand = mulberry32(seed);
    const n1 = makeNoise(rand, 14);
    const n2 = makeNoise(rand, 6);
    const n3 = makeNoise(rand, 4);
    const nh = makeNoise(rand, 10);
    const elev = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) elev[tileIndex(x, y)] = 0.7 * n1(x, y) + 0.3 * n2(x, y);
    }
    // Pick the threshold so roughly 16% of the map is water.
    const sorted = Array.from(elev).sort((a, b) => a - b);
    const threshold = sorted[Math.floor(sorted.length * 0.16)];
    const c = SIZE / 2;
    const tiles = new Array(SIZE * SIZE);
    const hills = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = tileIndex(x, y);
        // Keep the centre dry so the player always has room to start.
        const water = elev[i] < threshold && Math.hypot(x + 0.5 - c, y + 0.5 - c) > 7;
        const t = makeTile(water ? 'water' : 'grass');
        if (!water && n3(x, y) > 0.6 && rand() < 0.6) t.tree = true;
        hills[i] = nh(x, y);
        tiles[i] = t;
      }
    }

    // Hills: quantile thresholds so the levels are spread over the land.
    const landHills = [];
    for (let i = 0; i < tiles.length; i++) if (tiles[i].g === 'grass') landHills.push(hills[i]);
    landHills.sort((a, b) => a - b);
    const q = (p) => landHills[Math.min(landHills.length - 1, Math.floor(landHills.length * p))];
    const q1 = q(0.4);
    const q2 = q(0.65);
    const q3 = q(0.85);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = tileIndex(x, y);
        const t = tiles[i];
        if (t.g !== 'grass') continue;
        if (Math.hypot(x + 0.5 - c, y + 0.5 - c) <= 8) continue; // flat start area
        const h = hills[i];
        t.el = h < q1 ? 0 : h < q2 ? 1 : h < q3 ? 2 : 3;
      }
    }

    // River: a winding channel from top to bottom, two tiles wide, on one side
    // of the centre. It can be crossed with bridges (roads on river tiles).
    const left = rand() < 0.5;
    const baseX = left ? 8 + Math.floor(rand() * 8) : 48 + Math.floor(rand() * 8);
    const phase = rand() * Math.PI * 2;
    const amp = 2 + rand() * 2;
    for (let y = 0; y < SIZE; y++) {
      const cx = baseX + Math.round(amp * Math.sin(y / 9 + phase));
      for (let dx = 0; dx < 2; dx++) {
        const x = clamp(cx + dx, 0, SIZE - 1);
        const t = tiles[tileIndex(x, y)];
        t.g = 'water';
        t.river = true;
        t.tree = false;
        t.el = 0;
      }
    }
    return tiles;
  }

  function neighbors(x, y) {
    const out = [];
    if (x > 0) out.push([x - 1, y]);
    if (x < SIZE - 1) out.push([x + 1, y]);
    if (y > 0) out.push([x, y - 1]);
    if (y < SIZE - 1) out.push([x, y + 1]);
    return out;
  }

  function forEachInRadius(x, y, r, fn) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (inBounds(nx, ny)) fn(tileIndex(nx, ny));
      }
    }
  }

  function hasAdjacentWater(city, x, y) {
    return neighbors(x, y).some(([nx, ny]) => city.tiles[tileIndex(nx, ny)].g === 'water');
  }

  // Index of the first road tile next to (x, y), or -1.
  function adjacentRoad(tiles, x, y) {
    for (const [nx, ny] of neighbors(x, y)) {
      const k = tileIndex(nx, ny);
      if (tiles[k].road) return k;
    }
    return -1;
  }

  // Recomputes road networks, attachments, utility supply/demand and the
  // per-tile powered / watered / occupied flags.
  function refreshNetworks(city) {
    const tiles = city.tiles;
    const nets = [];
    for (const t of tiles) {
      t.net = -1;
      t.powered = false;
      t.watered = false;
      t.occ = false;
    }

    // 1. Flood-fill road networks.
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const start = tileIndex(x, y);
        if (!tiles[start].road || tiles[start].net !== -1) continue;
        const id = nets.length;
        const net = { id, roads: 0, power: 0, water: 0, powerDemand: 0, waterDemand: 0, powerRatio: 0, waterRatio: 0 };
        nets.push(net);
        tiles[start].net = id;
        const stack = [start];
        while (stack.length) {
          const i = stack.pop();
          net.roads++;
          const cx = i % SIZE;
          const cy = (i - cx) / SIZE;
          for (const [nx, ny] of neighbors(cx, cy)) {
            const k = tileIndex(nx, ny);
            if (tiles[k].road && tiles[k].net === -1) {
              tiles[k].net = id;
              stack.push(k);
            }
          }
        }
      }
    }

    // 2. Attach non-road land tiles to the first adjacent road network.
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const t = tiles[tileIndex(x, y)];
        if (t.road || t.g === 'water') continue;
        const r = adjacentRoad(tiles, x, y);
        if (r >= 0) t.net = tiles[r].net;
      }
    }

    // 3. Utility supply and zone demand per network.
    for (const t of tiles) {
      if (!t.b || t.net < 0) continue;
      const net = nets[t.net];
      if (t.b.t === 'power') net.power += SERVICE_INFO.power.supply;
      else if (t.b.t === 'water') net.water += SERVICE_INFO.water.supply;
      else if (isZone(t.b.t)) {
        const info = ZONE_INFO[t.b.t];
        net.powerDemand += info.power[t.b.lvl];
        net.waterDemand += info.water[t.b.lvl];
      }
    }
    for (const net of nets) {
      net.powerRatio = net.powerDemand > 0 ? Math.min(1, net.power / net.powerDemand) : net.power > 0 ? 1 : 0;
      net.waterRatio = net.waterDemand > 0 ? Math.min(1, net.water / net.waterDemand) : net.water > 0 ? 1 : 0;
    }

    // 4. Per-tile flags.
    for (const t of tiles) {
      if (t.net < 0) continue;
      const net = nets[t.net];
      t.powered = net.power > 0;
      t.watered = net.water > 0;
      t.occ = !!t.b && isZone(t.b.t) && t.powered && t.watered;
    }

    city.nets = nets;
  }

  // Industrial buildings emit pollution that fades with distance.
  function computePollution(city) {
    const pol = city.pollution;
    pol.fill(0);
    const R = 4;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const t = city.tiles[tileIndex(x, y)];
        if (!t.b || t.b.t !== 'I' || t.net < 0) continue;
        const strength = ZONE_INFO.I.pollution[t.b.lvl];
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (!inBounds(nx, ny)) continue;
            const d = Math.hypot(dx, dy);
            if (d > R) continue;
            pol[tileIndex(nx, ny)] += strength * (1 - d / (R + 1));
          }
        }
      }
    }
    for (let i = 0; i < pol.length; i++) pol[i] = Math.min(10, pol[i]);
  }

  // Influence counts per tile for each service (with a radius), plus commercial
  // and industrial neighbourhoods.
  function computeCoverage(city) {
    const n = SIZE * SIZE;
    const cov = { commercial: new Uint16Array(n), industrial: new Uint16Array(n) };
    for (const key of Object.keys(SERVICE_INFO)) {
      if (SERVICE_INFO[key].radius) cov[key] = new Uint16Array(n);
    }
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const t = city.tiles[tileIndex(x, y)];
        if (!t.b || t.net < 0) continue;
        const type = t.b.t;
        if (isService(type)) {
          const info = SERVICE_INFO[type];
          if (info.radius) {
            const arr = cov[type];
            forEachInRadius(x, y, info.radius, (k) => arr[k]++);
          }
        } else if (type === 'C' && t.occ) {
          forEachInRadius(x, y, 3, (k) => cov.commercial[k]++);
        } else if (type === 'I' && t.occ) {
          forEachInRadius(x, y, 2, (k) => cov.industrial[k]++);
        }
      }
    }
    return cov;
  }

  // Commuting. Residents of occupied homes travel over roads to the nearest
  // reachable job (occupied commercial or industrial building). Every road tile
  // on the way receives their load. Metro stations halve the car trips nearby.
  function computeTraffic(city, cov) {
    const tiles = city.tiles;
    const N = SIZE * SIZE;
    const dist = new Int32Array(N).fill(-1);
    const parent = new Int32Array(N).fill(-1);
    const queue = [];

    // Job access points: roads next to an operating job building.
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const t = tiles[tileIndex(x, y)];
        if (!t.occ || (t.b.t !== 'C' && t.b.t !== 'I')) continue;
        const r = adjacentRoad(tiles, x, y);
        if (r >= 0 && dist[r] === -1) {
          dist[r] = 0;
          queue.push(r);
        }
      }
    }
    // Multi-source BFS over roads: every road tile learns its nearest job.
    for (let qi = 0; qi < queue.length; qi++) {
      const i = queue[qi];
      const cx = i % SIZE;
      const cy = (i - cx) / SIZE;
      for (const [nx, ny] of neighbors(cx, cy)) {
        const k = tileIndex(nx, ny);
        if (tiles[k].road && dist[k] === -1) {
          dist[k] = dist[i] + 1;
          parent[k] = i;
          queue.push(k);
        }
      }
    }

    // Commuters per road access tile.
    const src = new Float64Array(N);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = tileIndex(x, y);
        const t = tiles[i];
        if (!t.occ || t.b.t !== 'R') continue;
        const r = adjacentRoad(tiles, x, y);
        if (r < 0 || dist[r] < 0) continue;
        let amount = ZONE_INFO.R.capacity[t.b.lvl];
        if (cov.metro && cov.metro[i]) amount *= 0.5;
        src[r] += amount;
      }
    }

    // Walk each commute to its job and add the load to every road on the way.
    const load = new Float64Array(N);
    for (let r = 0; r < N; r++) {
      if (!src[r]) continue;
      let cur = r;
      while (cur !== -1) {
        load[cur] += src[r];
        if (dist[cur] === 0) break;
        cur = parent[cur];
      }
    }

    let jammed = 0;
    for (let i = 0; i < N; i++) {
      const t = tiles[i];
      if (t.road) {
        const cap = t.hwy ? ROAD.highway.capacity : t.avenue ? ROAD.avenue.capacity : ROAD.street.capacity;
        t.cong = load[i] / cap;
        if (t.cong >= 1) jammed++;
      } else {
        t.cong = 0;
      }
    }
    // Buildings and empty zones feel the worst road next to them.
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const t = tiles[tileIndex(x, y)];
        if (t.road) continue;
        const r = adjacentRoad(tiles, x, y);
        t.cong = r >= 0 ? tiles[r].cong : 0;
      }
    }
    return jammed;
  }

  function residentHappiness(city, cov, x, y) {
    const i = tileIndex(x, y);
    const t = city.tiles[i];
    let h = 55;
    if (t.net < 0) {
      h -= 40;
    } else {
      const net = city.nets[t.net];
      if (!t.powered) h -= 25;
      if (!t.watered) h -= 25;
      h -= (1 - net.powerRatio) * 20;
      h -= (1 - net.waterRatio) * 10;
    }
    h -= Math.min(2, t.cong) * 8;
    // Highways next to a home are noisy.
    for (const [nx, ny] of neighbors(x, y)) {
      if (city.tiles[tileIndex(nx, ny)].hwy) {
        h -= 6;
        break;
      }
    }
    h -= city.pollution[i] * 3;
    if (cov.park[i]) h += cov.park[i] > 1 ? 12 : 8;
    if (cov.police[i]) h += 6;
    if (cov.fire[i]) h += 6;
    if (cov.school[i]) h += 4;
    if (cov.hospital[i]) h += 6;
    h += Math.min(3, cov.commercial[i]) * 2;
    h -= Math.min(3, cov.industrial[i]) * 4;
    // Taxes above the default make residents unhappy, below it they cheer up.
    h -= (city.tax.R - DEFAULT_TAX) * 200;
    return Math.round(clamp(h, 0, 100));
  }

  function createCity(opts) {
    const o = opts || {};
    const seed = o.seed !== undefined ? o.seed : Math.floor(Math.random() * 1e9);
    const city = {
      size: SIZE,
      name: o.name || 'Nieuwe Stad',
      seed,
      day: 0,
      money: START_MONEY,
      tax: { R: DEFAULT_TAX, C: DEFAULT_TAX, I: DEFAULT_TAX },
      demand: { R: 0.5, C: 0.5, I: 0.5 },
      tiles: generateTerrain(seed),
      nets: [],
      pollution: new Float32Array(SIZE * SIZE),
      stats: emptyStats(),
      history: [],
      messages: [],
      milestone: 0,
    };
    refreshNetworks(city);
    computePollution(city);
    return city;
  }

  function emptyStats() {
    return { pop: 0, jobs: 0, happy: 0, income: 0, upkeep: 0, powerRatio: 1, waterRatio: 1, roads: 0, jammed: 0 };
  }

  // Taxes from operating zones, and upkeep for roads and services.
  function computeEconomy(city) {
    const tiles = city.tiles;
    let income = 0;
    let upkeep = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const t = tiles[tileIndex(x, y)];
        if (t.road) upkeep += t.hwy ? ROAD.highway.upkeep : t.avenue ? ROAD.avenue.upkeep : ROAD.street.upkeep;
        if (!t.b) continue;
        if (isService(t.b.t)) {
          upkeep += SERVICE_INFO[t.b.t].upkeep;
        } else if (t.occ) {
          const net = city.nets[t.net];
          const operating = Math.min(net.powerRatio, net.waterRatio);
          const rate = city.tax[t.b.t] / DEFAULT_TAX;
          income += ZONE_INFO[t.b.t].tax[t.b.lvl] * rate * operating;
        }
      }
    }
    return { income, upkeep };
  }

  // Recomputes everything derived from the map: networks, pollution, traffic,
  // happiness, population and jobs. Used by simulateDay and after loading.
  function measure(city) {
    const tiles = city.tiles;
    refreshNetworks(city);
    computePollution(city);
    const cov = computeCoverage(city);
    const jammed = computeTraffic(city, cov);

    let pop = 0;
    let comJobs = 0;
    let indJobs = 0;
    let happySum = 0;
    let happyN = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const t = tiles[tileIndex(x, y)];
        if (!t.b || !isZone(t.b.t)) continue;
        const info = ZONE_INFO[t.b.t];
        const lvl = t.b.lvl;
        if (t.b.t === 'R') {
          t.happy = residentHappiness(city, cov, x, y);
          happySum += t.happy;
          happyN++;
          if (t.occ) pop += info.capacity[lvl];
        } else if (t.b.t === 'C' && t.occ) {
          comJobs += info.jobs[lvl];
        } else if (t.b.t === 'I' && t.occ) {
          indJobs += info.jobs[lvl];
        }
      }
    }

    const eco = computeEconomy(city);
    let powerSup = 0;
    let powerDem = 0;
    let waterSup = 0;
    let waterDem = 0;
    for (const net of city.nets) {
      powerSup += net.power;
      powerDem += net.powerDemand;
      waterSup += net.water;
      waterDem += net.waterDemand;
    }
    const jobs = comJobs + indJobs;
    const roads = tiles.reduce((n, t) => n + (t.road ? 1 : 0), 0);
    city.stats = {
      pop,
      jobs,
      happy: happyN ? Math.round(happySum / happyN) : 0,
      income: Math.round(eco.income),
      upkeep: Math.round(eco.upkeep),
      powerRatio: powerDem > 0 ? Math.min(1, powerSup / powerDem) : 1,
      waterRatio: waterDem > 0 ? Math.min(1, waterSup / waterDem) : 1,
      roads,
      jammed,
    };
    return { pop, jobs, comJobs, indJobs };
  }

  // Advances the city by one game day. Returns an array of event messages.
  function simulateDay(city, rand) {
    const rnd = rand || Math.random;
    const events = [];
    const tiles = city.tiles;
    const moneyBefore = city.money;
    city.day += 1;

    const { pop, jobs, comJobs, indJobs } = measure(city);

    // Demand per zone, roughly between -1 (too much) and +1 (very needed).
    city.demand.R = clamp(0.5 + (jobs - pop) / Math.max(40, pop), -1, 1);
    city.demand.C = clamp(0.5 + (pop * 0.3 - comJobs) / Math.max(30, pop * 0.3), -1, 1);
    city.demand.I = clamp(0.5 + (pop * 0.2 - indJobs) / Math.max(30, pop * 0.2), -1, 1);

    // Growth, upgrades and decline.
    let spawned = 0;
    let abandoned = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const t = tiles[tileIndex(x, y)];
        if (!t.b) {
          if (t.z && !t.road && t.net >= 0) {
            const d = city.demand[t.z];
            if (d > 0.05 && rnd() < 0.18 * d) {
              t.b = { t: t.z, lvl: 1 };
              spawned++;
            }
          }
          continue;
        }
        if (!isZone(t.b.t)) continue;
        const type = t.b.t;

        if (t.net < 0) {
          // No road access: the building slowly empties out.
          if (rnd() < 0.25) {
            t.b = null;
            abandoned++;
          }
          continue;
        }

        if (t.occ) {
          if (t.b.lvl < MAX_LEVEL) {
            const d = Math.max(0, city.demand[type]);
            let p = 0;
            if (type === 'R') p = t.happy >= 55 && t.cong < 1 ? 0.06 * d : 0;
            else p = 0.05 * d;
            if (rnd() < p) t.b.lvl++;
          }
          if (type === 'R' && t.happy < 20 && rnd() < 0.03) {
            t.b.lvl--;
            if (t.b.lvl <= 0) t.b = null;
          }
        } else if (rnd() < 0.04) {
          t.b.lvl--;
          if (t.b.lvl <= 0) t.b = null;
        }
      }
    }
    refreshNetworks(city);

    // Economy: taxes in, upkeep out.
    const eco = computeEconomy(city);
    const income = eco.income;
    const upkeep = eco.upkeep;
    city.money = Math.round(city.money + income - upkeep);
    city.stats.income = Math.round(income);
    city.stats.upkeep = Math.round(upkeep);

    // Keep the measured values from measure(); add this day's money flow.
    city.stats.income = Math.round(income);
    city.stats.upkeep = Math.round(upkeep);
    const { powerRatio, waterRatio, jammed } = city.stats;

    city.history.push({ day: city.day, pop, money: city.money });
    if (city.history.length > 240) city.history.shift();

    // Events for the player.
    while (city.milestone < MILESTONES.length && pop >= MILESTONES[city.milestone]) {
      events.push({ kind: 'good', text: `Mijlpaal: ${MILESTONES[city.milestone].toLocaleString('nl-NL')} inwoners!` });
      city.milestone++;
    }
    if (moneyBefore >= 0 && city.money < 0) events.push({ kind: 'bad', text: 'Je begroting is negatief. Verhoog de belastingen of ruim diensten op.' });
    if (pop > 0 && powerRatio < 1) events.push({ kind: 'bad', text: 'Stroomtekort: bouw extra elektriciteitscentrales.' });
    if (pop > 0 && waterRatio < 1) events.push({ kind: 'bad', text: 'Watertekort: bouw extra waterpompen.' });
    if (jammed >= 3 && city.day % 7 === 0) {
      events.push({ kind: 'bad', text: `Files op ${jammed} wegvakken. Bouw een laan of een metrostation.` });
    }
    if (abandoned > 0) events.push({ kind: 'bad', text: `${abandoned} gebouw(en) verlaten omdat ze niet aan een weg liggen.` });
    if (spawned > 0 && city.day % 5 === 0) {
      events.push({ kind: 'info', text: spawned === 1 ? '1 nieuw gebouw gebouwd.' : `${spawned} nieuwe gebouwen gebouwd.` });
    }

    for (const e of events) city.messages.unshift({ day: city.day, kind: e.kind, text: e.text });
    if (city.messages.length > 50) city.messages.length = 50;

    return events;
  }

  // ---- Player actions -----------------------------------------------------

  const result = (ok, cost, reason, noop) => ({ ok: !!ok, cost: cost || 0, reason: reason || '', noop: !!noop });

  // Dry-run: says whether an action would succeed on a tile and what it costs.
  function checkAction(city, act, x, y) {
    if (!inBounds(x, y)) return result(false, 0, 'Buiten het veld');
    const t = city.tiles[tileIndex(x, y)];

    switch (act.type) {
      case 'road': {
        if (t.b) return result(false, 0, 'Sloop eerst het gebouw');
        if (t.road) {
          // Roads only get upgraded: street -> avenue -> highway, never back.
          const rank = t.hwy ? 2 : t.avenue ? 1 : 0;
          const want = act.highway ? 2 : act.avenue ? 1 : 0;
          if (want <= rank) return result(true, 0, '', true);
          const upgrade = want === 2 ? ROAD.highway.upgradeCost : ROAD.avenue.upgradeCost;
          if (city.money < upgrade) return result(false, upgrade, 'Niet genoeg geld');
          return result(true, upgrade);
        }
        if (t.g === 'water' && !t.river) return result(false, 0, 'Je kunt niet over een meer bouwen');
        let cost = act.highway ? ROAD.highway.cost : act.avenue ? ROAD.avenue.cost : ROAD.street.cost;
        if (t.g === 'water') cost += BRIDGE_COST;
        if (city.money < cost) return result(false, cost, 'Niet genoeg geld');
        return result(true, cost);
      }
      case 'zone': {
        if (t.g === 'water') return result(false, 0, 'Je kunt niet op water zonen');
        if (t.road) return result(false, 0, 'Op een weg kun je niet zonen');
        if (t.b) {
          if (t.b.t === act.zone) return result(true, 0, '', true);
          return result(false, 0, 'Er staat een gebouw op deze tegel');
        }
        if (t.z === act.zone) return result(true, 0, '', true);
        return result(true, 0);
      }
      case 'service': {
        const info = SERVICE_INFO[act.service];
        if (!info) return result(false, 0, 'Onbekende dienst');
        if (t.g === 'water') return result(false, 0, 'Kan niet op water bouwen');
        if (t.road || t.b) return result(false, 0, 'Tegel is bezet');
        if (act.service === 'water' && !hasAdjacentWater(city, x, y)) {
          return result(false, 0, 'Waterpomp moet naast water staan');
        }
        if (city.money < info.cost) return result(false, info.cost, 'Niet genoeg geld');
        return result(true, info.cost);
      }
      case 'bulldoze': {
        let cost = 0;
        if (t.road) cost += BULLDOZE_COST / 2;
        if (t.b) cost += BULLDOZE_COST;
        if (t.tree) cost += TREE_COST;
        if (!t.road && !t.b && !t.z && !t.tree) return result(true, 0, '', true);
        if (city.money < cost) return result(false, cost, 'Niet genoeg geld');
        return result(true, cost);
      }
      default:
        return result(false, 0, 'Onbekende actie');
    }
  }

  // Applies an action. Does not refresh networks; call refreshNetworks after a batch.
  function applyAction(city, act, x, y) {
    const r = checkAction(city, act, x, y);
    if (!r.ok || r.noop) return r;
    const t = city.tiles[tileIndex(x, y)];
    switch (act.type) {
      case 'road':
        if (t.road) {
          if (act.highway) t.hwy = true;
          else t.avenue = true;
        } else {
          t.road = true;
          t.avenue = !!act.avenue && !act.highway;
          t.hwy = !!act.highway;
          t.z = null;
          t.tree = false;
        }
        break;
      case 'zone':
        t.z = act.zone;
        t.tree = false;
        break;
      case 'service':
        t.b = { t: act.service, lvl: 1 };
        t.z = null;
        t.tree = false;
        break;
      case 'bulldoze':
        t.road = false;
        t.avenue = false;
        t.hwy = false;
        t.b = null;
        t.z = null;
        t.tree = false;
        break;
    }
    city.money -= r.cost;
    return r;
  }

  // Tiles of a ready-made highway piece, starting at (x, y) and running
  // east ('h') or south ('v'). Tiles outside the map are checked by checkAction.
  function highwayPrefab(x, y, dir) {
    const out = [];
    for (let i = 0; i < HIGHWAY_PREFAB_LENGTH; i++) {
      out.push(dir === 'v' ? { x, y: y + i } : { x: x + i, y });
    }
    return out;
  }

  // Rows describing a tile, for the inspector panel.
  function inspect(city, x, y) {
    if (!inBounds(x, y)) return null;
    const i = tileIndex(x, y);
    const t = city.tiles[i];
    const pct = (v) => Math.round(v * 100) + '%';
    const rows = [];
    rows.push(['Terrein', t.g === 'water' ? (t.river ? 'Rivier' : 'Meer') : t.tree ? 'Bos' : 'Gras']);
    if (t.g !== 'water') rows.push(['Hoogte', String(t.el)]);
    if (t.road) {
      rows.push(['Weg', t.hwy ? 'Snelweg' : t.avenue ? 'Laan' : 'Straat']);
      if (t.g === 'water') rows.push(['Brug', 'Ja']);
      rows.push(['Verkeersdruk', pct(t.cong)]);
    }
    if (t.z) rows.push(['Zone', ZONE_INFO[t.z].name]);
    if (t.b) {
      if (isZone(t.b.t)) {
        rows.push(['Gebouw', `${ZONE_INFO[t.b.t].name}, niveau ${t.b.lvl}`]);
        rows.push(['Status', t.occ ? 'Bewoond / actief' : 'Niet actief']);
      } else {
        rows.push(['Gebouw', SERVICE_INFO[t.b.t].name]);
      }
    }
    if (t.g !== 'water' && !t.road) {
      rows.push(['Wegaansluiting', t.net >= 0 ? 'Ja' : 'Nee']);
    }
    if (t.b || t.z) {
      if (t.net >= 0) {
        rows.push(['Stroom', t.powered ? 'Ja' : 'Nee']);
        rows.push(['Water', t.watered ? 'Ja' : 'Nee']);
      }
      if (!t.road) rows.push(['Verkeersdruk', pct(t.cong)]);
    }
    if (t.b && t.b.t === 'R') rows.push(['Geluk', `${t.happy} / 100`]);
    rows.push(['Vervuiling', city.pollution[i].toFixed(1)]);
    return rows;
  }

  function serialize(city) {
    return JSON.stringify({
      v: SAVE_VERSION,
      name: city.name,
      seed: city.seed,
      day: city.day,
      money: city.money,
      tax: city.tax,
      demand: city.demand,
      milestone: city.milestone,
      history: city.history,
      messages: city.messages,
      tiles: city.tiles.map((t) => ({
        g: t.g,
        el: t.el,
        river: t.river,
        tree: t.tree,
        road: t.road,
        avenue: t.avenue,
        hwy: t.hwy,
        z: t.z,
        b: t.b,
      })),
    });
  }

  function deserialize(json) {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    if (!d || (d.v !== 1 && d.v !== SAVE_VERSION) || !Array.isArray(d.tiles) || d.tiles.length !== SIZE * SIZE) {
      throw new Error('Ongeldig opslagbestand');
    }
    const city = {
      size: SIZE,
      name: String(d.name || 'Nieuwe Stad'),
      seed: d.seed,
      day: d.day | 0,
      money: Number(d.money) || 0,
      tax: { R: DEFAULT_TAX, C: DEFAULT_TAX, I: DEFAULT_TAX, ...(d.tax || {}) },
      demand: { R: 0.5, C: 0.5, I: 0.5, ...(d.demand || {}) },
      milestone: d.milestone | 0,
      history: Array.isArray(d.history) ? d.history : [],
      messages: Array.isArray(d.messages) ? d.messages : [],
      nets: [],
      pollution: new Float32Array(SIZE * SIZE),
      stats: emptyStats(),
      tiles: d.tiles.map((s) => {
        const t = makeTile(s.g === 'water' ? 'water' : 'grass');
        t.el = clamp(s.el | 0, 0, MAX_ELEVATION);
        t.river = !!s.river;
        t.tree = !!s.tree;
        t.road = !!s.road;
        t.avenue = !!s.avenue;
        t.hwy = !!s.hwy;
        t.z = s.z && isZone(s.z) ? s.z : null;
        t.b = s.b && (isZone(s.b.t) || isService(s.b.t)) ? { t: s.b.t, lvl: s.b.lvl || 1 } : null;
        return t;
      }),
    };
    measure(city);
    return city;
  }

  return {
    SIZE,
    DAY_SECONDS,
    DEFAULT_TAX,
    MAX_LEVEL,
    MAX_ELEVATION,
    ROAD,
    BRIDGE_COST,
    HIGHWAY_PREFAB_LENGTH,
    highwayPrefab,
    ZONE_INFO,
    SERVICE_INFO,
    MILESTONES,
    mulberry32,
    generateTerrain,
    createCity,
    simulateDay,
    refreshNetworks,
    checkAction,
    applyAction,
    inspect,
    serialize,
    deserialize,
    tileIndex,
    inBounds,
    isZone,
    isService,
  };
});

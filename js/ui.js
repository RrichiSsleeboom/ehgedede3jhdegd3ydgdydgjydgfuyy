/*
 * Browser UI: input handling, HUD, budget panel, save/load and the game loop.
 * Depends on window.Sim (sim.js) and window.Renderer (render.js).
 */
(function () {
  'use strict';

  const Sim = window.Sim;
  const SAVE_KEY = 'citybuilder.save.v1';
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 2.5;

  // Each tool: kind decides how the pointer is used.
  //   inspect -> click selects a tile
  //   line    -> drag a straight road
  //   rect    -> drag a rectangle (zoning, bulldozing)
  //   point   -> single click places a service
  const TOOLS = [
    { id: 'inspect', group: 'Basis', label: 'Inspecteren', key: 'Q', kind: 'inspect' },
    { id: 'pan', group: 'Basis', label: 'Verschuiven', key: 'V', kind: 'pan' },
    { id: 'local', group: 'Basis', label: 'Landweg', key: 'G', kind: 'line', action: { type: 'road', kind: 'local' } },
    { id: 'road', group: 'Basis', label: 'Straat', key: '1', kind: 'line', action: { type: 'road', kind: 'street' } },
    { id: 'avenue', group: 'Basis', label: 'Laan', key: 'L', kind: 'line', action: { type: 'road', kind: 'avenue' } },
    { id: 'highway', group: 'Basis', label: 'Snelweg-stuk', key: 'J', kind: 'point', prefab: true, action: { type: 'road', kind: 'highway' } },
    { id: 'bulldoze', group: 'Basis', label: 'Slopen', key: '5', kind: 'rect', action: { type: 'bulldoze' } },
    { id: 'zone-R', group: 'Zones', label: 'Wonen', key: '2', kind: 'rect', action: { type: 'zone', zone: 'R' }, swatch: '#7dd87d' },
    { id: 'zone-V', group: 'Zones', label: 'Villawijk', key: 'K', kind: 'rect', action: { type: 'zone', zone: 'V' }, swatch: '#a8ec9a' },
    { id: 'zone-A', group: 'Zones', label: 'Appartementen', key: 'A', kind: 'rect', action: { type: 'zone', zone: 'A' }, swatch: '#2e8b57' },
    { id: 'zone-C', group: 'Zones', label: 'Commercieel', key: '3', kind: 'rect', action: { type: 'zone', zone: 'C' }, swatch: '#6fb7ff' },
    { id: 'zone-I', group: 'Zones', label: 'Industrie', key: '4', kind: 'rect', action: { type: 'zone', zone: 'I' }, swatch: '#f2d16b' },
    { id: 'svc-park', group: 'Diensten', label: 'Park', key: '6', kind: 'point', action: { type: 'service', service: 'park' } },
    { id: 'svc-police', group: 'Diensten', label: 'Politie', key: '7', kind: 'point', action: { type: 'service', service: 'police' } },
    { id: 'svc-fire', group: 'Diensten', label: 'Brandweer', key: '8', kind: 'point', action: { type: 'service', service: 'fire' } },
    { id: 'svc-school', group: 'Diensten', label: 'School', key: '9', kind: 'point', action: { type: 'service', service: 'school' } },
    { id: 'svc-hospital', group: 'Diensten', label: 'Ziekenhuis', key: 'H', kind: 'point', action: { type: 'service', service: 'hospital' } },
    { id: 'svc-metro', group: 'Diensten', label: 'Metro', key: 'M', kind: 'point', action: { type: 'service', service: 'metro' } },
    { id: 'svc-power', group: 'Nutsvoorzieningen', label: 'Centrale', key: '0', kind: 'point', action: { type: 'service', service: 'power' } },
    { id: 'svc-water', group: 'Nutsvoorzieningen', label: 'Waterpomp', key: '-', kind: 'point', action: { type: 'service', service: 'water' } },
  ];

  const $ = (id) => document.getElementById(id);
  const fmtMoney = (n) => (n < 0 ? '-€' : '€') + Math.abs(Math.round(n)).toLocaleString('nl-NL');
  const fmtPct = (r) => Math.round(r * 100) + '%';

  const canvas = $('view');
  const renderer = new window.Renderer(canvas);

  let city = loadInitialCity();
  renderer.centerOn(city.size);

  const rand = Math.random;
  let speed = 1;
  let dayAcc = 0;
  let currentTool = TOOLS[0];
  let prefabDir = 'h'; // orientation of ready-made pieces: 'h' east, 'v' south
  let drag = null; // { start, end } in tile coords
  let pan = null; // { sx, sy, camX, camY }
  let hover = null;
  let selected = null;
  let previewCost = 0;
  let previewReason = '';
  let hudDirty = true;

  // ---- Save / load ---------------------------------------------------------

  function newCity() {
    return Sim.createCity({ name: 'Nieuwe Stad', seed: Math.floor(Math.random() * 1e9) });
  }

  function loadInitialCity() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) return Sim.deserialize(raw);
    } catch (err) {
      // Corrupt save or storage blocked: start fresh.
    }
    return newCity();
  }

  function saveGame(showToast) {
    try {
      localStorage.setItem(SAVE_KEY, Sim.serialize(city));
      if (showToast) toast('Stad opgeslagen', 'good');
    } catch (err) {
      if (showToast) toast('Opslaan mislukt: ' + err.message, 'bad');
    }
  }

  function loadGame() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) {
        toast('Geen opgeslagen stad gevonden', 'info');
        return;
      }
      city = Sim.deserialize(raw);
      selected = null;
      renderer.centerOn(city.size);
      toast('Stad geladen', 'good');
    } catch (err) {
      toast('Laden mislukt: ' + err.message, 'bad');
    }
  }

  // ---- Notifications -------------------------------------------------------

  function toast(text, kind) {
    const log = $('log');
    const el = document.createElement('div');
    el.className = 'msg ' + (kind || 'info');
    el.textContent = text;
    log.prepend(el);
    while (log.children.length > 4) log.lastElementChild.remove();
    setTimeout(() => el.classList.add('fade'), 4000);
    setTimeout(() => el.remove(), 5200);
  }

  function handleEvents(events) {
    for (const e of events) {
      // The simulation repeats some warnings every day; show each only when it changes.
      if (e.text === lastEventText) continue;
      lastEventText = e.text;
      toast(e.text, e.kind);
    }
  }
  let lastEventText = '';

  // ---- Tools ---------------------------------------------------------------

  function buildToolbar() {
    const root = $('tools');
    let group = null;
    for (const tool of TOOLS) {
      if (tool.group !== group) {
        group = tool.group;
        const h = document.createElement('div');
        h.className = 'group-title';
        h.textContent = group;
        root.appendChild(h);
      }
      const btn = document.createElement('button');
      btn.className = 'tool';
      btn.dataset.tool = tool.id;
      btn.title = `${tool.label} (${tool.key})`;
      btn.innerHTML = `<span class="key">${tool.key}</span>${tool.swatch ? `<i class="swatch" style="background:${tool.swatch}"></i>` : ''}<span>${tool.label}</span>`;
      btn.addEventListener('click', () => setTool(tool));
      root.appendChild(btn);
    }
  }

  function setTool(tool) {
    currentTool = tool;
    for (const b of document.querySelectorAll('.tool')) {
      b.classList.toggle('active', b.dataset.tool === tool.id);
    }
    drag = null;
    updateStatusbar();
  }

  // ---- Pointer input -------------------------------------------------------

  function localPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Touch handling. Active pointers are tracked so that two fingers can pinch to
  // zoom and pan together. One finger pans on inspect, place and pan tools; on
  // the build tools (roads, zones, bulldozer) it draws, and the pan tool is there
  // to scroll the map then.
  const touches = new Map(); // pointerId -> client { x, y }
  let pinch = null; // { anchor: world point, zoom, dist }
  let gesture = null; // one-pointer gesture: a tap or a pan
  const TAP_SLOP = 8; // pixels a finger may move and still count as a tap

  const centroid = () => {
    const pts = [...touches.values()].slice(0, 2);
    const r = canvas.getBoundingClientRect();
    return {
      sx: (pts[0].x + pts[1].x) / 2 - r.left,
      sy: (pts[0].y + pts[1].y) / 2 - r.top,
      dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
    };
  };

  canvas.addEventListener('pointerdown', (e) => {
    const p = localPoint(e);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);

    if (e.button === 1 || e.button === 2) {
      pan = { sx: e.clientX, sy: e.clientY, camX: renderer.cam.x, camY: renderer.cam.y };
      return;
    }
    if (e.button !== 0) return;

    if (touches.size === 2) {
      // A second finger turns the gesture into a pinch and cancels any drawing.
      gesture = null;
      drag = null;
      const c = centroid();
      pinch = { anchor: renderer.unproject(c.sx, c.sy), zoom: renderer.cam.zoom, dist: c.dist };
      return;
    }
    if (touches.size > 2) return;

    const tile = renderer.tileAt(p.sx, p.sy);
    const kind = currentTool.kind;
    if (kind === 'pan' || (e.pointerType === 'touch' && (kind === 'inspect' || kind === 'point'))) {
      // Decide on release whether this was a tap (act) or a swipe (pan).
      gesture = { id: e.pointerId, sx: e.clientX, sy: e.clientY, camX: renderer.cam.x, camY: renderer.cam.y, moved: false, tile };
      return;
    }
    if (!tile) return;
    if (kind === 'inspect') {
      selected = tile;
      updateDetails();
    } else if (kind === 'point') {
      applyPoint(tile);
    } else {
      drag = { start: tile, end: tile };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = localPoint(e);
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch && touches.size >= 2) {
      const c = centroid();
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinch.zoom * (c.dist / pinch.dist)));
      renderer.zoomAt(zoom, pinch.anchor.x, pinch.anchor.y, c.sx, c.sy);
      hover = null;
      updateStatusbar();
      return;
    }

    if (gesture && gesture.id === e.pointerId) {
      const dx = e.clientX - gesture.sx;
      const dy = e.clientY - gesture.sy;
      if (!gesture.moved && Math.hypot(dx, dy) > TAP_SLOP) gesture.moved = true;
      if (gesture.moved) {
        renderer.cam.x = gesture.camX + dx;
        renderer.cam.y = gesture.camY + dy;
      }
    }

    if (pan) {
      renderer.cam.x = pan.camX + (e.clientX - pan.sx);
      renderer.cam.y = pan.camY + (e.clientY - pan.sy);
    }
    hover = renderer.tileAt(p.sx, p.sy);
    if (drag && hover) drag.end = hover;
    updateStatusbar();
  });

  function endPointer(e) {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;

    if (gesture && gesture.id === e.pointerId) {
      // A finger that did not move is a tap: act on the tile it started on.
      if (!gesture.moved && gesture.tile) {
        if (currentTool.kind === 'inspect') {
          selected = gesture.tile;
          updateDetails();
        } else if (currentTool.kind === 'point') {
          applyPoint(gesture.tile);
        }
      }
      gesture = null;
    }
    if (pan) {
      pan = null;
      return;
    }
    if (drag && touches.size === 0) {
      commitDrag();
      drag = null;
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => {
    if (touches.size === 0) {
      hover = null;
      updateStatusbar();
    }
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = localPoint(e);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, renderer.cam.zoom * factor));
      renderer.setZoom(z, p.sx, p.sy);
    },
    { passive: false }
  );

  // Tiles covered by the current drag, in the order they should be applied.
  function dragTiles() {
    if (!drag) return [];
    const s = drag.start;
    const e = drag.end;
    const out = [];
    if (currentTool.kind === 'line') {
      if (Math.abs(e.x - s.x) >= Math.abs(e.y - s.y)) {
        const step = e.x >= s.x ? 1 : -1;
        for (let x = s.x; ; x += step) {
          out.push({ x, y: s.y });
          if (x === e.x) break;
        }
      } else {
        const step = e.y >= s.y ? 1 : -1;
        for (let y = s.y; ; y += step) {
          out.push({ x: s.x, y });
          if (y === e.y) break;
        }
      }
      return out;
    }
    const x0 = Math.min(s.x, e.x);
    const x1 = Math.max(s.x, e.x);
    const y0 = Math.min(s.y, e.y);
    const y1 = Math.max(s.y, e.y);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ x, y });
    return out;
  }

  function commitDrag() {
    const tiles = dragTiles();
    let changed = 0;
    let spent = 0;
    let lastFail = '';
    for (const p of tiles) {
      const r = Sim.applyAction(city, currentTool.action, p.x, p.y);
      if (r.ok && !r.noop) {
        changed++;
        spent += r.cost;
      } else if (!r.ok) {
        lastFail = r.reason;
      }
    }
    if (changed) Sim.refreshNetworks(city);
    if (changed === 0 && lastFail) toast(lastFail, 'bad');
    hudDirty = true;
  }

  // Tiles a single click on the point tools affects: one tile, or a whole
  // ready-made piece (e.g. a highway section) when the tool is a prefab.
  function pointTiles(tile) {
    if (currentTool.prefab) return Sim.highwayPrefab(tile.x, tile.y, prefabDir);
    return [tile];
  }

  function applyPoint(tile) {
    let changed = 0;
    let lastFail = '';
    for (const p of pointTiles(tile)) {
      const r = Sim.applyAction(city, currentTool.action, p.x, p.y);
      if (!r.ok) lastFail = r.reason;
      else if (!r.noop) changed++;
    }
    if (lastFail) toast(lastFail, 'bad');
    if (!changed) return;
    Sim.refreshNetworks(city);
    const t = city.tiles[Sim.tileIndex(tile.x, tile.y)];
    if (!currentTool.prefab && t.net < 0) {
      toast('Let op: deze dienst ligt niet aan een weg en werkt niet tot je een weg aanlegt.', 'info');
    }
    hudDirty = true;
  }

  // Works out the preview overlay and its cost for whatever the pointer is doing.
  function computePreview() {
    const map = new Map();
    let cost = 0;
    let reason = '';
    let tiles = [];
    if (drag) tiles = dragTiles();
    else if (hover && currentTool.kind === 'point') tiles = pointTiles(hover);
    if (currentTool.action) {
      for (const p of tiles) {
        const r = Sim.checkAction(city, currentTool.action, p.x, p.y);
        if (r.noop) continue;
        map.set(Sim.tileIndex(p.x, p.y), r.ok);
        if (r.ok) cost += r.cost;
        else reason = r.reason;
      }
    }
    renderer.preview = map;
    previewCost = cost;
    previewReason = reason;
  }

  // ---- Keyboard ------------------------------------------------------------

  window.addEventListener('keydown', (e) => {
    // Typing in a text field keeps its keys. After a click on a toolbar button
    // the button has focus, so shortcuts must still work there.
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      setSpeed(speed === 0 ? 1 : 0);
      return;
    }
    if (e.key === 'Escape') {
      setTool(TOOLS[0]);
      return;
    }
    const k = e.key.toUpperCase();
    if (k === 'R' && currentTool.prefab) {
      prefabDir = prefabDir === 'h' ? 'v' : 'h';
      updateStatusbar();
      return;
    }
    const tool = TOOLS.find((t) => t.key === k);
    if (tool) setTool(tool);
  });

  // ---- HUD -----------------------------------------------------------------

  function setSpeed(s) {
    speed = s;
    for (const b of document.querySelectorAll('[data-speed]')) {
      b.classList.toggle('active', Number(b.dataset.speed) === s);
    }
    hudDirty = true;
  }

  function refreshHUD() {
    const s = city.stats;
    $('cityName').textContent = city.name;
    $('stMoney').textContent = fmtMoney(city.money);
    $('stMoney').classList.toggle('neg', city.money < 0);
    $('stPop').textContent = s.pop.toLocaleString('nl-NL');
    $('stJobs').textContent = s.jobs.toLocaleString('nl-NL');
    const happyEl = $('stHappy');
    happyEl.textContent = city.stats.pop > 0 ? s.happy + '/100' : '–';
    happyEl.className = 'val ' + (s.happy >= 60 ? 'good' : s.happy >= 35 ? 'warn' : 'bad');
    setUtility($('stPower'), s.powerRatio);
    setUtility($('stWater'), s.waterRatio);

    const frac = dayAcc / Sim.DAY_SECONDS;
    const mins = Math.floor(frac * 24 * 60);
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    $('stDate').textContent = `Dag ${city.day + 1} · ${hh}:${mm}`;

    $('incomeTxt').textContent = fmtMoney(s.income);
    $('upkeepTxt').textContent = fmtMoney(s.upkeep);
    const net = s.income - s.upkeep;
    $('netTxt').textContent = (net >= 0 ? '+' : '') + fmtMoney(net) + ' / dag';
    $('netTxt').className = net >= 0 ? 'good' : 'bad';
    $('statPop').textContent = s.pop.toLocaleString('nl-NL');
    $('statRoads').textContent = s.roads.toLocaleString('nl-NL');
    const jamEl = $('statJam');
    jamEl.textContent = s.jammed.toLocaleString('nl-NL');
    jamEl.className = s.jammed > 0 ? 'bad' : 'good';
    $('statDemand').textContent = ['R', 'C', 'I']
      .map((z) => `${z} ${city.demand[z] >= 0 ? '+' : ''}${city.demand[z].toFixed(2)}`)
      .join(' · ');

    for (const z of ['R', 'C', 'I']) {
      const v = Math.round(city.tax[z] * 100);
      const slider = $('tax' + z);
      if (document.activeElement !== slider) slider.value = v;
      $('tax' + z + 'v').textContent = v + '%';
    }

    drawSparkline();
    if (selected) updateDetails();
    hudDirty = false;
  }

  function setUtility(el, ratio) {
    el.textContent = fmtPct(ratio);
    el.className = 'val ' + (ratio >= 1 ? 'good' : ratio >= 0.6 ? 'warn' : 'bad');
  }

  function updateStatusbar() {
    const info = $('info');
    if (hover) {
      const rows = Sim.inspect(city, hover.x, hover.y) || [];
      const short = rows.filter((r) => ['Gebouw', 'Zone', 'Weg'].includes(r[0])).map((r) => r[1]);
      if (rows.some((r) => r[0] === 'Wegaansluiting' && r[1] === 'Nee')) short.push('geen wegaansluiting');
      info.textContent = `(${hover.x}, ${hover.y}) ${short.join(' · ') || rows[0][1]}`;
    } else {
      info.textContent = '';
    }
    const costEl = $('cost');
    if (previewCost > 0) {
      costEl.textContent = `Kosten: ${fmtMoney(previewCost)}`;
      costEl.className = previewCost > city.money ? 'bad' : '';
    } else {
      costEl.textContent = previewReason && (drag || hover) ? previewReason : '';
      costEl.className = 'bad';
    }
    $('toolHint').textContent = toolHint();
  }

  function toolHint() {
    switch (currentTool.kind) {
      case 'inspect':
        return 'Klik op een tegel voor details. Rechtermuisknop of middelste muisknop: verschuiven. Scrollen: zoomen. Op een telefoon: swipe om te verschuiven, twee vingers om te zoomen.';
      case 'pan':
        return 'Sleep om de kaart te verschuiven. Twee vingers om te zoomen.';
      case 'line':
        if (currentTool.action.kind === 'local') {
          return 'Sleep om een goedkope landweg aan te leggen. Weinig capaciteit, en de weg kan later worden opgewaardeerd.';
        }
        if (currentTool.action.kind === 'avenue') {
          return 'Sleep om een laan aan te leggen (dubbele capaciteit). Een bestaande straat wordt een laan.';
        }
        return 'Sleep om een rechte straat aan te leggen. Over een rivier komt een brug (duurder).';
      case 'rect':
        return currentTool.action.type === 'zone'
          ? 'Sleep een vak om te zonen. Wegen zijn nodig om gebouwen te laten groeien.'
          : 'Sleep een vak om gebouwen, wegen en bomen te slopen.';
      case 'point':
        if (currentTool.prefab) {
          return `Plaats een snelwegstuk van 12 tegels. R draait het stuk (nu ${prefabDir === 'h' ? 'horizontaal' : 'verticaal'}).`;
        }
        return currentTool.action.service === 'water'
          ? 'Plaats naast water. Verbind met een weg om te werken.'
          : 'Plaats op een lege tegel die aan een weg ligt.';
      default:
        return '';
    }
  }

  function updateDetails() {
    const box = $('details');
    const sheetBody = $('sheetBody');
    if (!selected) {
      box.innerHTML = '<p class="muted">Selecteer een tegel met het inspectiegereedschap (Q).</p>';
      document.body.classList.remove('has-selection');
      return;
    }
    const rows = Sim.inspect(city, selected.x, selected.y);
    if (!rows) return;
    const html =
      `<div class="muted">Tegel (${selected.x}, ${selected.y})</div>` +
      rows
        .map(([k, v]) => {
          const bad = (k === 'Wegaansluiting' || k === 'Stroom' || k === 'Water') && v === 'Nee';
          return `<div class="row"><span>${k}</span><b class="${bad ? 'no-road' : ''}">${v}</b></div>`;
        })
        .join('');
    box.innerHTML = html;
    sheetBody.innerHTML = html;
    document.body.classList.add('has-selection');
  }

  $('sheetClose').addEventListener('click', () => {
    selected = null;
    updateDetails();
  });

  function drawSparkline() {
    const sc = $('spark');
    const ctx = sc.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = sc.clientWidth;
    const h = sc.clientHeight;
    if (sc.width !== Math.round(w * dpr)) {
      sc.width = Math.round(w * dpr);
      sc.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const data = city.history;
    if (data.length < 2) return;
    const max = Math.max(10, ...data.map((d) => d.pop));
    ctx.strokeStyle = '#7dd87d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = (i / (data.length - 1)) * (w - 4) + 2;
      const y = h - 4 - (d.pop / max) * (h - 8);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // ---- Wiring --------------------------------------------------------------

  function wireControls() {
    for (const b of document.querySelectorAll('[data-speed]')) {
      b.addEventListener('click', () => setSpeed(Number(b.dataset.speed)));
    }
    for (const z of ['R', 'C', 'I']) {
      $('tax' + z).addEventListener('input', (e) => {
        city.tax[z] = Number(e.target.value) / 100;
        $('tax' + z + 'v').textContent = e.target.value + '%';
      });
      $('tax' + z).addEventListener('change', () => {
        Sim.refreshNetworks(city);
        hudDirty = true;
      });
    }
    $('btnSave').addEventListener('click', () => saveGame(true));
    $('btnLoad').addEventListener('click', loadGame);
    $('btnNew').addEventListener('click', () => {
      if (!confirm('Nieuwe stad beginnen? De huidige opslag wordt overschreven zodra je opslaat.')) return;
      city = newCity();
      selected = null;
      renderer.centerOn(city.size);
      setSpeed(1);
      toast('Nieuwe stad gestart', 'good');
    });
    $('btnPanel').addEventListener('click', () => {
      document.body.classList.toggle('panel-hidden');
      requestAnimationFrame(() => renderer.resize());
    });
    $('cityName').addEventListener('click', () => {
      const name = prompt('Naam van de stad', city.name);
      if (name && name.trim()) city.name = name.trim().slice(0, 30);
      hudDirty = true;
    });
    window.addEventListener('resize', () => renderer.resize());
  }

  // ---- Game loop -----------------------------------------------------------

  // 0..1 blend towards night based on the hour of the simulated day.
  function nightAmount(hour) {
    if (hour < 6) return 1;
    if (hour < 8) return (8 - hour) / 2;
    if (hour < 19) return 0;
    if (hour < 21) return (hour - 19) / 2;
    return 1;
  }

  let lastFrame = performance.now();
  let lastHud = 0;

  function frame(now) {
    const dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;

    if (speed > 0) {
      dayAcc += dt * speed;
      while (dayAcc >= Sim.DAY_SECONDS) {
        dayAcc -= Sim.DAY_SECONDS;
        handleEvents(Sim.simulateDay(city, rand));
        hudDirty = true;
      }
    }

    computePreview();
    const hour = (dayAcc / Sim.DAY_SECONDS) * 24;
    renderer.night = nightAmount(hour);
    renderer.time = now / 1000;
    renderer.hover = hover;
    renderer.selected = selected;
    renderer.draw(city);

    if (hudDirty || now - lastHud > 250) {
      refreshHUD();
      updateStatusbar();
      lastHud = now;
    }
    requestAnimationFrame(frame);
  }

  // ---- Start ---------------------------------------------------------------

  buildToolbar();
  wireControls();
  setTool(TOOLS[0]);
  setSpeed(1);
  refreshHUD();
  setInterval(() => saveGame(false), 30000);
  window.addEventListener('beforeunload', () => saveGame(false));
  requestAnimationFrame((t) => {
    lastFrame = t;
    frame(t);
  });

  // Exposed for debugging and automated tests.
  window.citybuilder = {
    get city() {
      return city;
    },
    setSpeed,
    setTool: (id) => setTool(TOOLS.find((t) => t.id === id)),
    act: (id, x, y) => {
      const tool = TOOLS.find((t) => t.id === id);
      if (!tool || !tool.action) return null;
      const r = Sim.applyAction(city, tool.action, x, y);
      Sim.refreshNetworks(city);
      hudDirty = true;
      return r;
    },
    tools: TOOLS.map((t) => t.id),
    renderer,
  };
})();

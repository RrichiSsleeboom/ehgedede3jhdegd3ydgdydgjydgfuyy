'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Sim = require('../js/sim.js');

const { SIZE } = Sim;
const idx = (x, y) => Sim.tileIndex(x, y);

// Lays a horizontal road at row y from x0 to x1 (inclusive) on a fresh city.
function roadRow(city, y, x0, x1) {
  for (let x = x0; x <= x1; x++) {
    const r = Sim.applyAction(city, { type: 'road' }, x, y);
    assert.ok(r.ok, `road at ${x},${y}: ${r.reason}`);
  }
  Sim.refreshNetworks(city);
}

// Returns a fresh city whose land is cleared of trees and water in a 12x12 block
// around the centre, so tests don't depend on the random terrain.
function flatCity(seed = 1) {
  const city = Sim.createCity({ seed, name: 'Test' });
  for (let y = 16; y < 48; y++) {
    for (let x = 16; x < 48; x++) {
      const t = city.tiles[idx(x, y)];
      t.g = 'grass';
      t.tree = false;
    }
  }
  Sim.refreshNetworks(city);
  return city;
}

test('terrain generation is deterministic and has land and water', () => {
  const a = Sim.generateTerrain(123);
  const b = Sim.generateTerrain(123);
  assert.equal(a.length, SIZE * SIZE);
  assert.deepEqual(
    a.map((t) => t.g),
    b.map((t) => t.g)
  );
  const water = a.filter((t) => t.g === 'water').length;
  assert.ok(water > 0 && water < a.length / 2, `water tiles: ${water}`);
  // Centre is always dry.
  assert.equal(a[idx(32, 32)].g, 'grass');
});

test('roads cost money and cannot be built on water', () => {
  const city = flatCity();
  const before = city.money;
  const r = Sim.applyAction(city, { type: 'road' }, 30, 30);
  assert.ok(r.ok && !r.noop);
  assert.equal(city.money, before - 20);

  city.tiles[idx(10, 10)].g = 'water';
  const w = Sim.checkAction(city, { type: 'road' }, 10, 10);
  assert.equal(w.ok, false);
});

test('zoning is free and cannot be placed on a road', () => {
  const city = flatCity();
  const before = city.money;
  const z = Sim.applyAction(city, { type: 'zone', zone: 'R' }, 30, 30);
  assert.ok(z.ok);
  assert.equal(city.money, before);
  assert.equal(city.tiles[idx(30, 30)].z, 'R');

  Sim.applyAction(city, { type: 'road' }, 31, 30);
  const onRoad = Sim.checkAction(city, { type: 'zone', zone: 'C' }, 31, 30);
  assert.equal(onRoad.ok, false);
});

test('road networks: connected tiles share an id, separated ones do not', () => {
  const city = flatCity();
  roadRow(city, 28, 24, 30);
  roadRow(city, 34, 24, 30); // disconnected second road
  const a = city.tiles[idx(24, 28)].net;
  const b = city.tiles[idx(30, 28)].net;
  const c = city.tiles[idx(24, 34)].net;
  assert.ok(a >= 0);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('buildings are only attached to a network when touching a road', () => {
  const city = flatCity();
  Sim.applyAction(city, { type: 'zone', zone: 'R' }, 30, 30); // not adjacent to any road
  Sim.refreshNetworks(city);
  assert.equal(city.tiles[idx(30, 30)].net, -1);

  roadRow(city, 29, 24, 30); // now the zone at (30,30) touches the road at (30,29)
  assert.ok(city.tiles[idx(30, 30)].net >= 0);
});

test('a power plant only powers buildings on its own road network', () => {
  const city = flatCity();
  roadRow(city, 28, 24, 30); // network A
  roadRow(city, 34, 24, 30); // network B, disconnected from A
  // Plant at (27,29) touches road A at (27,28).
  assert.ok(Sim.applyAction(city, { type: 'service', service: 'power' }, 27, 29).ok);
  Sim.applyAction(city, { type: 'zone', zone: 'R' }, 25, 27); // touches road A
  Sim.applyAction(city, { type: 'zone', zone: 'R' }, 25, 35); // touches road B only
  Sim.refreshNetworks(city);

  assert.equal(city.tiles[idx(27, 29)].net, city.tiles[idx(27, 28)].net);
  assert.equal(city.tiles[idx(25, 27)].powered, true, 'zone on the plant network is powered');
  assert.equal(city.tiles[idx(25, 35)].powered, false, 'zone on the other network is not powered');
});

test('water pumps must be placed next to water', () => {
  const city = flatCity();
  const r = Sim.checkAction(city, { type: 'service', service: 'water' }, 30, 30);
  assert.equal(r.ok, false);
  city.tiles[idx(29, 30)].g = 'water';
  const ok = Sim.checkAction(city, { type: 'service', service: 'water' }, 30, 30);
  assert.equal(ok.ok, true);
});

test('bulldozing removes roads, buildings and zones', () => {
  const city = flatCity();
  roadRow(city, 30, 24, 26);
  Sim.applyAction(city, { type: 'zone', zone: 'C' }, 25, 31);
  Sim.applyAction(city, { type: 'bulldoze' }, 25, 30);
  Sim.applyAction(city, { type: 'bulldoze' }, 25, 31);
  Sim.refreshNetworks(city);
  assert.equal(city.tiles[idx(25, 30)].road, false);
  assert.equal(city.tiles[idx(25, 31)].z, null);
});

test('a connected residential city grows population over time', () => {
  const city = flatCity(5);
  roadRow(city, 32, 20, 44);
  for (let x = 20; x <= 44; x++) {
    Sim.applyAction(city, { type: 'zone', zone: 'R' }, x, 31);
    Sim.applyAction(city, { type: 'zone', zone: 'C' }, x, 33);
  }
  Sim.applyAction(city, { type: 'service', service: 'power' }, 45, 32);
  Sim.refreshNetworks(city);
  // Make the power plant touch the road (it is at (45,32), adjacent to road end (44,32)).
  const rand = Sim.mulberry32(99);
  // Pump needs water next to it, so put water beside a land tile next to the road.
  city.tiles[idx(20, 30)].g = 'water';
  Sim.applyAction(city, { type: 'service', service: 'water' }, 20, 31);

  const startPop = city.stats.pop;
  for (let d = 0; d < 80; d++) Sim.simulateDay(city, rand);

  assert.ok(city.stats.pop > startPop, `population ${city.stats.pop}`);
  assert.ok(city.stats.pop > 0);
  assert.ok(city.history.length > 0);
});

test('save and load round-trip keeps the city intact', () => {
  const city = flatCity(7);
  roadRow(city, 30, 24, 30);
  Sim.applyAction(city, { type: 'zone', zone: 'I' }, 28, 29);
  city.tax.R = 0.12;
  Sim.refreshNetworks(city);
  const json = Sim.serialize(city);
  const copy = Sim.deserialize(json);

  assert.equal(copy.money, city.money);
  assert.equal(copy.tax.R, 0.12);
  assert.equal(copy.tiles.length, city.tiles.length);
  assert.equal(copy.tiles[idx(28, 30)].road, true);
  assert.equal(copy.tiles[idx(28, 29)].z, 'I');
  assert.ok(copy.tiles[idx(28, 30)].net >= 0, 'derived network state is rebuilt');
});

test('deserialize rejects invalid save data', () => {
  assert.throws(() => Sim.deserialize('{"v":99}'), /Ongeldig/);
  assert.throws(() => Sim.deserialize('not json'));
});

test('higher residential taxes lower happiness', () => {
  const city = flatCity(3);
  roadRow(city, 30, 24, 30);
  // Power and water so that happiness is not dominated by missing utilities.
  Sim.applyAction(city, { type: 'service', service: 'power' }, 26, 29);
  city.tiles[idx(23, 31)].g = 'water';
  Sim.applyAction(city, { type: 'service', service: 'water' }, 24, 31);
  Sim.applyAction(city, { type: 'zone', zone: 'R' }, 27, 31);
  Sim.refreshNetworks(city);
  city.tiles[idx(27, 31)].b = { t: 'R', lvl: 1 };
  city.tax.R = Sim.DEFAULT_TAX;
  Sim.simulateDay(city, () => 0.99); // no spawns, just state refresh
  const low = city.tiles[idx(27, 31)].happy;

  city.tax.R = 0.2;
  Sim.simulateDay(city, () => 0.99);
  const high = city.tiles[idx(27, 31)].happy;
  assert.ok(high < low, `happy low-tax ${low}, high-tax ${high}`);
});

test('inspect describes a tile', () => {
  const city = flatCity();
  roadRow(city, 30, 24, 26);
  const rows = Sim.inspect(city, 25, 30);
  const labels = rows.map((r) => r[0]);
  assert.ok(labels.includes('Terrein'));
  assert.ok(labels.includes('Weg'));
  assert.equal(Sim.inspect(city, -1, 0), null);
});

import type { Vec3 } from '../core/math';
import { fromLonLat, toLonLat, type LonLat } from '../vector/geo';
import { setSmooth } from './geometry';
import { EARTH_RADIUS_KM, MOUNTAIN_DEFAULTS, VEGETATION_DEFAULTS, newId, type Item, type MapDoc, type PathNode, type RiverSection, type VPath } from './model';

const FORMAT = 'worldbuilder-map';

const ll = (v: Vec3): LonLat => {
  const [lon, lat] = toLonLat(...v);
  return [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
};

function pathOut(path: VPath) {
  return {
    closed: path.closed,
    nodes: path.nodes.map((n) => ({ p: ll(n.p), hin: n.hin && ll(n.hin), hout: n.hout && ll(n.hout), ...(n.corner ? { corner: true } : {}), ...(n.section ? { section: n.section } : {}) })),
  };
}

function pathIn(raw: ReturnType<typeof pathOut>): VPath {
  return {
    closed: raw.closed,
    nodes: raw.nodes.map((n) => ({ p: fromLonLat(n.p), hin: n.hin && fromLonLat(n.hin), hout: n.hout && fromLonLat(n.hout), ...(n.corner ? { corner: true } : {}), ...(n.section ? { section: n.section } : {}) })),
  };
}

/** Documents are saved with positions as [lon, lat] degrees so files stay readable. */
export function serializeDoc(doc: MapDoc): string {
  const items = doc.items.map((it) => {
    const out: Record<string, unknown> = { ...it };
    delete out.rev;
    if ('path' in it && it.path) out.path = pathOut(it.path);
    if ('at' in it) out.at = ll(it.at);
    return out;
  });
  return JSON.stringify({ format: FORMAT, version: doc.version, seed: doc.seed, planet: doc.planet, palette: doc.palette ?? {}, items }, null, 1);
}

export function parseDoc(json: string): MapDoc {
  const d = JSON.parse(json);
  if (d.format !== FORMAT) throw new Error('Not a WorldBuilder map file');
  if (d.version > 1) throw new Error(`Map file version ${d.version} is newer than this app supports`);
  const items: Item[] = d.items.map((raw: Record<string, unknown>) => {
    const it = { ...raw, rev: 0, id: (raw.id as string) ?? newId() } as Record<string, unknown>;
    if (raw.path) it.path = pathIn(raw.path as ReturnType<typeof pathOut>);
    if (raw.at) it.at = fromLonLat(raw.at as LonLat);
    // Fill in settings added after a file was saved.
    if (raw.kind === 'forest') Object.assign(it, { ...VEGETATION_DEFAULTS, ...(raw.trees ? { vegetation: raw.trees } : {}) }, { ...it, trees: undefined });
    if (raw.kind === 'mountains') Object.assign(it, { ...MOUNTAIN_DEFAULTS }, { ...it });
    return it as unknown as Item;
  });
  const radiusKm = Number(d.planet?.radiusKm);
  return { version: 1, seed: d.seed ?? 'atlas', planet: { radiusKm: radiusKm > 0 ? radiusKm : EARTH_RADIUS_KM }, palette: d.palette ?? {}, items };
}

export function cloneItems(items: Item[]): Item[] {
  return structuredClone(items);
}

// ---------------------------------------------------------------- sample map

function smoothPath(points: LonLat[], closed: boolean): VPath {
  const path: VPath = { closed, nodes: points.map((p): PathNode => ({ p: fromLonLat(p), hin: null, hout: null })) };
  for (let i = 0; i < path.nodes.length; i++) setSmooth(path, i, true);
  return path;
}

function withSections(path: VPath, sections: RiverSection[]): VPath {
  sections.forEach((sec, i) => path.nodes[i] && (path.nodes[i].section = sec));
  return path;
}

/** A small hand-made map used for "Open sample" and for automated screenshots. */
export function sampleDoc(): MapDoc {
  const item = <T extends Omit<Item, 'id' | 'rev'>>(x: T) => ({ id: newId(), rev: 0, ...x }) as unknown as Item;
  return {
    version: 1,
    seed: 'atlas',
    planet: { radiusKm: EARTH_RADIUS_KM },
    items: [
      item({ kind: 'land', op: 'add', rough: 0.8, path: smoothPath([[-30, 38], [-8, 46], [14, 40], [22, 22], [10, 4], [-4, 10], [-20, 6], [-34, 18]], true) }),
      item({ kind: 'land', op: 'add', rough: 0.8, path: smoothPath([[12, 10], [30, 14], [40, 0], [30, -16], [14, -10]], true) }),
      item({ kind: 'land', op: 'cut', rough: 0.5, path: smoothPath([[-6, 30], [2, 33], [6, 28], [-2, 24]], true) }),
      item({ kind: 'land', op: 'add', rough: 1, path: smoothPath([[-50, 20], [-44, 24], [-41, 18], [-47, 15]], true) }),
      // Rivers are clipped to the land, so running one past the coast ends it neatly at the shore.
      item({ kind: 'river', width: 0.35, rough: 0.6, path: withSections(smoothPath([[4, 36], [-2, 28], [-12, 20], [-19, 9], [-24, 1]], false), ['meander', 'oxbow', 'braided', 'meander']) }),
      item({ kind: 'border', line: 'national', path: smoothPath([[14, 40], [8, 30], [12, 18], [10, 4]], false) }),
      item({ kind: 'mountains', ...MOUNTAIN_DEFAULTS, path: smoothPath([[-3, 43], [6, 42.5], [12, 39], [9, 35.5], [2, 37], [-4, 39.5]], true) }),
      item({ kind: 'forest', ...VEGETATION_DEFAULTS, path: smoothPath([[-30, 19], [-22, 21], [-16, 16], [-19, 10], [-27, 9], [-31, 13]], true) }),
      item({ kind: 'symbol', symbol: 'city', at: fromLonLat([-14, 19]), size: 0.9 }),
      item({ kind: 'symbol', symbol: 'town', at: fromLonLat([24, 2]), size: 0.6 }),
      item({ kind: 'label', text: 'Westmarch', style: 'region', size: 2.2, at: fromLonLat([-14, 30]), path: null }),
      item({ kind: 'label', text: 'Aurel', style: 'place', size: 1.2, at: fromLonLat([-14, 16.5]), path: null }),
      item({ kind: 'label', text: 'Mirror Sea', style: 'water', size: 1.8, at: fromLonLat([2, 0]), path: smoothPath([[-8, -6], [2, -9], [12, -24]], false) }),
    ],
  };
}

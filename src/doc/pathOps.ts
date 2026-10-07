import type { Vec3 } from '../core/math';
import { angle, azimuthal, rotation, segmentCount, splitSegment } from './geometry';
import { pathOf, type Item, type PathNode, type VPath } from './model';
import { centroid } from './transform';

/** Fewest nodes a path can have and still draw: a loop needs three, a line two. */
export const minNodes = (path: VPath): number => (path.closed ? 3 : 2);

/** Apply a function to every position of a path (nodes and handles), in place. */
export function mapPath(path: VPath, fn: (v: Vec3) => Vec3): void {
  for (const n of path.nodes) {
    n.p = fn(n.p);
    if (n.hin) n.hin = fn(n.hin);
    if (n.hout) n.hout = fn(n.hout);
  }
}

/** Apply a function to every position of an item (its path, its anchor), in place. */
export function mapItem(item: Item, fn: (v: Vec3) => Vec3): void {
  const path = pathOf(item);
  if (path) mapPath(path, fn);
  if (item.kind === 'symbol' || item.kind === 'label') item.at = fn(item.at);
}

/** Every position an item occupies: nodes, handles and anchors (for sizing a selection). */
export function itemPositions(item: Item): Vec3[] {
  const out: Vec3[] = [];
  const path = pathOf(item);
  if (path) for (const n of path.nodes) out.push(n.p);
  if (item.kind === 'symbol' || item.kind === 'label') out.push(item.at);
  return out;
}

export function selectionCentre(items: Item[]): Vec3 {
  return centroid(items.flatMap(itemPositions));
}

/** Run the path the other way. River stretches travel with their stretch, not their node. */
export function reversePath(path: VPath): void {
  const n = path.nodes.length;
  const sections = path.nodes.map((node) => node.section);
  path.nodes.reverse();
  path.nodes.forEach((node, j) => {
    [node.hin, node.hout] = [node.hout, node.hin];
    // The stretch now leaving node j was the one that arrived at it before.
    const from = path.closed ? (((n - 2 - j) % n) + n) % n : n - 2 - j;
    if (from >= 0 && sections[from]) node.section = sections[from];
    else delete node.section;
  });
}

// ---------------------------------------------------------------- splitting

/**
 * Cut a path at one of its nodes. An open path gives two paths that share that node's position; a
 * closed one is opened there, giving one path that starts and ends at the node. Paths are copies.
 */
export function splitAtNode(path: VPath, i: number): VPath[] {
  const copy = structuredClone(path);
  const n = copy.nodes.length;
  if (!copy.closed) {
    if (i <= 0 || i >= n - 1) return [copy];
    const head = copy.nodes.slice(0, i + 1);
    const tail = copy.nodes.slice(i);
    const twin = structuredClone(copy.nodes[i]);
    head[i].hout = null;
    delete head[i].section;
    tail[0] = { ...twin, hin: null };
    return [
      { closed: false, nodes: head },
      { closed: false, nodes: tail },
    ];
  }
  const rotated = [...copy.nodes.slice(i), ...copy.nodes.slice(0, i)];
  const start = rotated[0];
  const end = structuredClone(start);
  start.hin = null;
  end.hout = null;
  delete end.section;
  return [{ closed: false, nodes: [...rotated, end] }];
}

/**
 * Split a closed path along the straight line between two of its nodes: two closed paths, one on
 * each side. Null if either side would be left with fewer than two nodes of its own.
 */
export function splitClosed(path: VPath, i: number, j: number): [VPath, VPath] | null {
  const n = path.nodes.length;
  if (!path.closed || i === j || n < 4) return null;
  const arc = (from: number, to: number): PathNode[] => {
    const out: PathNode[] = [];
    for (let k = from; ; k = (k + 1) % n) {
      out.push(structuredClone(path.nodes[k]));
      if (k === to) break;
    }
    return out;
  };
  const out = [arc(i, j), arc(j, i)].map((nodes): VPath => {
    const first = nodes[0], last = nodes[nodes.length - 1];
    first.hin = null;
    last.hout = null;
    first.corner = last.corner = true;
    delete last.section;
    const shape: VPath = { closed: true, nodes };
    // A sliver of two nodes (one curve and the chord) is still a shape: give it a middle.
    while (shape.nodes.length < 3) splitSegment(shape, 0, 0.5);
    return shape;
  });
  return [out[0], out[1]];
}

// ---------------------------------------------------------------- joining

export interface Oriented {
  /** Copies of the two paths, turned so that `first` ends where `second` begins. */
  first: VPath;
  second: VPath;
  /** Angle between the two ends being joined (radians). */
  gap: number;
}

/**
 * Pick the pair of ends of two open paths that are closest and turn the paths (as copies) so the
 * first ends where the second starts. With `preferFlow` (rivers) a pairing that keeps both paths
 * running the way they already do wins unless another is much closer.
 */
export function orientForJoin(a: VPath, b: VPath, preferFlow = false): Oriented & { cost: number } {
  const ra = structuredClone(a), rb = structuredClone(b);
  reversePath(ra);
  reversePath(rb);
  const A = structuredClone(a), B = structuredClone(b);
  const end = (p: VPath) => p.nodes[p.nodes.length - 1].p;
  const start = (p: VPath) => p.nodes[0].p;
  const turn = preferFlow ? 1.5 : 1;
  const options: (Oriented & { cost: number })[] = [
    { first: A, second: B, gap: angle(end(A), start(B)), cost: 0 },
    { first: B, second: A, gap: angle(end(B), start(A)), cost: 0 },
    { first: A, second: rb, gap: angle(end(A), start(rb)), cost: 0 },
    { first: ra, second: B, gap: angle(end(ra), start(B)), cost: 0 },
  ];
  options.forEach((o, k) => (o.cost = o.gap * (k >= 2 ? turn : 1)));
  return options.reduce((best, o) => (o.cost < best.cost ? o : best));
}

/**
 * Join two open paths end to start. Ends within `weldRadius` (radians) become one node; farther
 * apart they are bridged by a straight stretch.
 */
export function joinPaths(first: VPath, second: VPath, weldRadius: number): VPath {
  const nodes = structuredClone(first.nodes);
  const rest = structuredClone(second.nodes);
  const last = nodes[nodes.length - 1], head = rest[0];
  if (angle(last.p, head.p) <= weldRadius) {
    const shift = rotation(head.p, last.p);
    const welded: PathNode = { p: last.p, hin: last.hin, hout: head.hout && shift(head.hout), corner: true };
    if (head.section) welded.section = head.section;
    nodes[nodes.length - 1] = welded;
    nodes.push(...rest.slice(1));
  } else {
    const section = head.section ?? nodes[nodes.length - 2]?.section;
    if (section) last.section = section;
    nodes.push(...rest);
  }
  return { closed: false, nodes };
}

/** Join any number of open paths into one, always taking the nearest remaining path next. */
export function chainJoin(paths: VPath[], weldRadius: number, preferFlow = false): VPath {
  let acc = structuredClone(paths[0]);
  const rest = paths.slice(1);
  while (rest.length) {
    let pick = 0;
    let best = orientForJoin(acc, rest[0], preferFlow);
    for (let i = 1; i < rest.length; i++) {
      const o = orientForJoin(acc, rest[i], preferFlow);
      if (o.cost < best.cost) {
        best = o;
        pick = i;
      }
    }
    acc = joinPaths(best.first, best.second, weldRadius);
    rest.splice(pick, 1);
  }
  return acc;
}

// ---------------------------------------------------------------- cutting across

/** Where a sample index of a flattened path (see `flatten`) sits on the path: segment and fraction. */
export function locateSample(path: VPath, seg: number[], index: number): { seg: number; t: number } {
  const k = Math.max(0, Math.min(seg.length - 1, Math.floor(index)));
  const s = seg[k];
  const first = seg.indexOf(s), last = seg.lastIndexOf(s);
  // An open path's final point is its end node, not a sample of the last stretch.
  const samples = !path.closed && s === segmentCount(path) - 1 ? last - first : last - first + 1;
  return { seg: s, t: Math.max(0, Math.min(1, (index - first) / Math.max(1, samples))) };
}

/** Insert nodes at the given places without changing the shape; returns each one's final index. */
export function insertAt(path: VPath, places: { seg: number; t: number }[]): number[] {
  const ranked = places.map((l, k) => ({ seg: l.seg, t: Math.max(0.03, Math.min(0.97, l.t)), k })).sort((a, b) => a.seg - b.seg || a.t - b.t);
  // Work from the back, and re-measure a fraction once the stretch before it has been shortened.
  let prevSeg = -1, prevT = 1;
  for (const l of [...ranked].reverse()) {
    splitSegment(path, l.seg, l.seg === prevSeg ? l.t / prevT : l.t);
    prevSeg = l.seg;
    prevT = l.t;
  }
  const out: number[] = new Array(places.length);
  ranked.forEach((l, r) => (out[l.k] = l.seg + 1 + r));
  return out;
}

export interface Crossing {
  /** Fractional sample index along the outline. */
  outline: number;
  /** Fractional sample index along the stroke. */
  stroke: number;
}

/** Every place a stroke crosses an outline (flat xyz), in the order the stroke meets them. */
export function crossings(outline: number[], closed: boolean, stroke: Vec3[]): Crossing[] {
  const n = outline.length / 3;
  if (n < 2 || stroke.length < 2) return [];
  const proj = azimuthal(centroid(stroke.concat([[outline[0], outline[1], outline[2]]])));
  const O: [number, number][] = [];
  for (let i = 0; i < n; i++) O.push(proj.forward(outline[i * 3], outline[i * 3 + 1], outline[i * 3 + 2]));
  const S = stroke.map((v) => proj.forward(v[0], v[1], v[2]));
  const out: Crossing[] = [];
  const outSegs = closed ? n : n - 1;
  for (let j = 0; j < S.length - 1; j++) {
    const [ax, ay] = S[j], [bx, by] = S[j + 1];
    const minX = Math.min(ax, bx), maxX = Math.max(ax, bx), minY = Math.min(ay, by), maxY = Math.max(ay, by);
    for (let i = 0; i < outSegs; i++) {
      const [cx, cy] = O[i], [dx, dy] = O[(i + 1) % n];
      if (Math.max(cx, dx) < minX || Math.min(cx, dx) > maxX || Math.max(cy, dy) < minY || Math.min(cy, dy) > maxY) continue;
      const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-15) continue;
      const v = ((cx - ax) * sy - (cy - ay) * sx) / den;
      const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
      if (v >= 0 && v < 1 && u >= 0 && u < 1) out.push({ stroke: j + v, outline: i + u });
    }
  }
  return out.sort((p, q) => p.stroke - q.stroke);
}

/**
 * Cut a path along a stroke drawn across it. A line is cut where the stroke first crosses it; a
 * closed shape is cut between the first and last crossing, along a straight line. `base` is the
 * path's flattened samples (what `flatten` returns). Null if the stroke misses.
 */
export function cutPath(path: VPath, base: { pts: number[]; seg: number[] }, stroke: Vec3[]): VPath[] | null {
  const hits = crossings(base.pts, path.closed, stroke);
  if (!hits.length) return null;
  const work = structuredClone(path);
  if (!path.closed) {
    const [at] = insertAt(work, [locateSample(path, base.seg, hits[0].outline)]);
    return splitAtNode(work, at);
  }
  const a = hits[0], b = hits[hits.length - 1];
  if (hits.length < 2 || Math.abs(a.outline - b.outline) < 1e-6) return null;
  const [i, j] = insertAt(work, [locateSample(path, base.seg, a.outline), locateSample(path, base.seg, b.outline)]);
  return splitClosed(work, i, j);
}

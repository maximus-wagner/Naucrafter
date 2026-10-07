import { halfedgeEnd, type SphereMesh } from '../world/sphereMesh';
import { chaikinClosed, chaikinOpen } from './geo';

/**
 * A run of Voronoi edges separating two labels, between two junctions (Voronoi vertices where
 * three labels meet) or forming a closed loop.
 */
export interface BorderChain {
  /** Label of the cells on the chain's left / right (seen from outside, walking along it). */
  left: number;
  right: number;
  closed: boolean;
  /** Triangles (Voronoi vertices) along the chain; first/last are junctions unless closed. */
  nodes: number[];
  /** One half-edge per segment; its start cell is on the left, its end cell on the right. */
  edges: number[];
  /** Smoothed geometry, flat xyz (endpoints fixed for open chains). */
  xyz: number[];
  /** Per smoothed segment: index into `edges` it came from. */
  segSource: number[];
}

export interface BorderNetwork {
  chains: BorderChain[];
  /** Closed rings (flat xyz) around every region with this label, region on the left. */
  ringsFor(label: number): number[][];
}

/**
 * Trace the borders between labelled cells as a network of chains. Regions are assembled from
 * shared chains, so neighbouring regions always fit together exactly after smoothing.
 */
export function borderNetwork(mesh: SphereMesh, labels: ArrayLike<number>, smoothing = 2): BorderNetwork {
  const { triangles: T, twin, circum } = mesh;
  const nh = T.length;
  const tri = (h: number) => (h / 3) | 0;
  const isJunction = (t: number) => {
    const a = labels[T[t * 3]], b = labels[T[t * 3 + 1]], c = labels[T[t * 3 + 2]];
    return a !== b && b !== c && a !== c;
  };
  // Directed border edge for half-edge h (a→b, labels differ) runs tri(twin h) → tri(h) with a on
  // its left. The continuation at tri(h) for the same left label X leaves through the half-edge g
  // of that triangle that ends at an X cell and starts at a non-X cell.
  const next = (h: number) => {
    const t = tri(h), X = labels[T[h]];
    for (let e = 0; e < 3; e++) {
      const g = t * 3 + e;
      if (labels[halfedgeEnd(T, g)] === X && labels[T[g]] !== X) return twin[g];
    }
    return -1;
  };

  const visited = new Uint8Array(nh);
  const chains: BorderChain[] = [];
  const trace = (h0: number) => {
    const nodes = [tri(twin[h0])];
    const edges: number[] = [];
    let h = h0, closed = false;
    for (let guard = 0; guard < nh; guard++) {
      visited[h] = visited[twin[h]] = 1;
      edges.push(h);
      nodes.push(tri(h));
      if (isJunction(tri(h))) break;
      h = next(h);
      if (h === h0) {
        closed = true;
        nodes.pop();
        break;
      }
    }
    const raw: number[] = [];
    for (const t of nodes) raw.push(circum[t * 3], circum[t * 3 + 1], circum[t * 3 + 2]);
    let xyz: number[], segSource: number[];
    if (closed) {
      xyz = chaikinClosed(raw, smoothing);
      // Closed Chaikin emits two points per source segment.
      segSource = Array.from({ length: xyz.length / 3 }, (_, k) => Math.min(edges.length - 1, k >> smoothing));
    } else {
      const s = chaikinOpen(raw, edges.map((_, i) => i), smoothing);
      xyz = s.pts;
      segSource = s.attrs;
    }
    chains.push({ left: labels[T[h0]], right: labels[halfedgeEnd(T, h0)], closed, nodes, edges, xyz, segSource });
  };

  for (let t = 0; t < nh / 3; t++) {
    if (!isJunction(t)) continue;
    for (let e = 0; e < 3; e++) {
      const h = twin[t * 3 + e];
      if (!visited[h]) trace(h);
    }
  }
  for (let h = 0; h < nh; h++) {
    if (!visited[h] && labels[T[h]] !== labels[halfedgeEnd(T, h)]) trace(h);
  }

  const byLabel = new Map<number, number[]>();
  chains.forEach((c, i) => {
    for (const l of [c.left, c.right]) {
      if (!byLabel.has(l)) byLabel.set(l, []);
      byLabel.get(l)!.push(i);
    }
  });

  const ringsFor = (label: number): number[][] => {
    const rings: number[][] = [];
    const open: { pts: number[]; from: number; to: number }[] = [];
    for (const i of byLabel.get(label) ?? []) {
      const c = chains[i];
      const fwd = c.left === label;
      const pts = fwd ? c.xyz : reversePoints(c.xyz);
      if (c.closed) rings.push(pts);
      else open.push({ pts, from: fwd ? c.nodes[0] : c.nodes[c.nodes.length - 1], to: fwd ? c.nodes[c.nodes.length - 1] : c.nodes[0] });
    }
    const startAt = new Map<number, number>();
    open.forEach((d, i) => startAt.set(d.from, i));
    const used = new Uint8Array(open.length);
    for (let i = 0; i < open.length; i++) {
      if (used[i]) continue;
      const ring: number[] = [];
      let j = i;
      for (let guard = 0; guard <= open.length && j !== undefined && !used[j]; guard++) {
        used[j] = 1;
        const p = open[j].pts;
        for (let k = 0; k < p.length - 3; k++) ring.push(p[k]); // drop last point: next chain starts there
        j = startAt.get(open[j].to)!;
      }
      if (ring.length >= 9) rings.push(ring);
    }
    return rings;
  };

  return { chains, ringsFor };
}

function reversePoints(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 3; i >= 0; i -= 3) out.push(pts[i], pts[i + 1], pts[i + 2]);
  return out;
}

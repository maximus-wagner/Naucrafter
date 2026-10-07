import type { Vec3 } from '../core/math';
import { fitStroke, type P2 } from './fit';
import { azimuthal, splitSegment, unit } from './geometry';
import type { PathNode, VPath } from './model';

/**
 * Convert a freehand stroke on the sphere into a smooth, editable Bézier path. The stroke is
 * flattened with an azimuthal-equidistant projection around its centre (distances stay nearly true),
 * curve-fitted, and the nodes are projected back. `tolerance` is in radians.
 */
export function strokeToPath(stroke: Vec3[], closed: boolean, tolerance: number): VPath | null {
  if (stroke.length < 2) return null;
  let sx = 0, sy = 0, sz = 0;
  for (const p of stroke) {
    sx += p[0];
    sy += p[1];
    sz += p[2];
  }
  const c = unit(sx, sy, sz);
  // Strokes reaching round the far side of the planet can't be flattened; keep their raw points.
  if (stroke.some((p) => p[0] * c[0] + p[1] * c[1] + p[2] * c[2] < -0.5)) {
    const step = Math.max(1, Math.floor(stroke.length / 40));
    return { closed, nodes: stroke.filter((_, i) => i % step === 0).map((p) => ({ p, hin: null, hout: null })) };
  }
  const proj = azimuthal(c);
  const flat = stroke.map((p): P2 => proj.forward(p[0], p[1], p[2]));
  const back = ([x, y]: P2): Vec3 => proj.inverse(x, y);
  const segs = fitStroke(flat, closed, tolerance, tolerance * 1.2);
  if (!segs.length) return null;

  const nodes: PathNode[] = segs.map((s, i) => {
    const prev = i > 0 ? segs[i - 1] : closed ? segs[segs.length - 1] : null;
    const node: PathNode = { p: back(s.p0), hin: prev ? back(prev.c1) : null, hout: back(s.c0) };
    if (s.corner) node.corner = true;
    return node;
  });
  if (!closed) {
    const last = segs[segs.length - 1];
    nodes.push({ p: back(last.p1), hin: back(last.c1), hout: null });
  }
  const path: VPath = { closed, nodes };
  // Closed shapes need a few nodes to be pleasant to edit.
  while (closed && path.nodes.length < 3) splitSegment(path, 0, 0.5);
  return path;
}

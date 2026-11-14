/**
 * Minimal TrueType (sfnt `glyf`) reader: glyph outlines by glyph id, advances, cmap and
 * line metrics. Pure; no DOM. CFF-flavoured fonts (`OTTO`) return `null` from `parseSfnt`
 * so the caller falls back to `FontFace` text.
 */

/** Outline in font units, y up. Commands as in `PathData`: 0 move, 1 line, 2 quad, 4 close. */
export type Outline = { cmds: number[]; pts: number[] };

export type SfntFace = {
  unitsPerEm: number;
  /** Face bounding box `[xMin, yMin, xMax, yMax]` in font units (`head`). */
  bbox: [number, number, number, number];
  numGlyphs: number;
  ascender: number;
  descender: number;
  lineGap: number;
  outline(gid: number): Outline | null;
  advance(gid: number): number;
  glyphFor(codePoint: number): number;
};

type Tables = Map<string, { off: number; len: number }>;

export function parseSfnt(bytes: Uint8Array, faceIndex = 0): SfntFace | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let base = 0;
  if (dv.getUint32(0) === 0x74746366 /* ttcf */) {
    const count = dv.getUint32(8);
    if (faceIndex >= count) return null;
    base = dv.getUint32(12 + 4 * faceIndex);
  }
  const tag = dv.getUint32(base);
  if (tag !== 0x00010000 && tag !== 0x74727565 /* true */) return null;
  const tables: Tables = new Map();
  const n = dv.getUint16(base + 4);
  for (let i = 0; i < n; i++) {
    const r = base + 12 + 16 * i;
    const name = String.fromCharCode(bytes[r], bytes[r + 1], bytes[r + 2], bytes[r + 3]);
    tables.set(name, { off: dv.getUint32(r + 8), len: dv.getUint32(r + 12) });
  }
  const head = tables.get("head");
  const maxp = tables.get("maxp");
  const loca = tables.get("loca");
  const glyf = tables.get("glyf");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  if (!head || !maxp || !loca || !glyf || !hhea || !hmtx) return null;
  const unitsPerEm = dv.getUint16(head.off + 18);
  const longLoca = dv.getInt16(head.off + 50) === 1;
  const numGlyphs = dv.getUint16(maxp.off + 4);
  const numHMetrics = dv.getUint16(hhea.off + 34);
  const cmap = readCmap(dv, tables.get("cmap"));
  const cache = new Map<number, Outline | null>();

  const glyphRange = (gid: number): [number, number] => {
    if (longLoca) return [dv.getUint32(loca.off + 4 * gid), dv.getUint32(loca.off + 4 * gid + 4)];
    return [dv.getUint16(loca.off + 2 * gid) * 2, dv.getUint16(loca.off + 2 * gid + 2) * 2];
  };

  const appendGlyph = (
    gid: number,
    out: Outline,
    m: [number, number, number, number, number, number],
    depth: number,
  ) => {
    if (gid < 0 || gid >= numGlyphs || depth > 8) return;
    const [start, end] = glyphRange(gid);
    if (end <= start) return;
    const g = glyf.off + start;
    const contours = dv.getInt16(g);
    if (contours >= 0) appendSimple(dv, g, contours, out, m);
    else {
      let p = g + 10;
      for (;;) {
        const flags = dv.getUint16(p);
        const child = dv.getUint16(p + 2);
        p += 4;
        let dx: number;
        let dy: number;
        if (flags & 0x0001) {
          dx = flags & 0x0002 ? dv.getInt16(p) : 0;
          dy = flags & 0x0002 ? dv.getInt16(p + 2) : 0;
          p += 4;
        } else {
          dx = flags & 0x0002 ? dv.getInt8(p) : 0;
          dy = flags & 0x0002 ? dv.getInt8(p + 1) : 0;
          p += 2;
        }
        let a = 1;
        let b = 0;
        let c = 0;
        let d = 1;
        if (flags & 0x0008) {
          a = d = dv.getInt16(p) / 16384;
          p += 2;
        } else if (flags & 0x0040) {
          a = dv.getInt16(p) / 16384;
          d = dv.getInt16(p + 2) / 16384;
          p += 4;
        } else if (flags & 0x0080) {
          a = dv.getInt16(p) / 16384;
          b = dv.getInt16(p + 2) / 16384;
          c = dv.getInt16(p + 4) / 16384;
          d = dv.getInt16(p + 6) / 16384;
          p += 8;
        }
        // Child point (x, y) lands at m(a x + c y + dx, b x + d y + dy).
        const cm: [number, number, number, number, number, number] = [
          m[0] * a + m[2] * b,
          m[1] * a + m[3] * b,
          m[0] * c + m[2] * d,
          m[1] * c + m[3] * d,
          m[0] * dx + m[2] * dy + m[4],
          m[1] * dx + m[3] * dy + m[5],
        ];
        appendGlyph(child, out, cm, depth + 1);
        if (!(flags & 0x0020)) break;
      }
    }
  };

  return {
    unitsPerEm,
    numGlyphs,
    ascender: dv.getInt16(hhea.off + 4),
    descender: dv.getInt16(hhea.off + 6),
    lineGap: dv.getInt16(hhea.off + 8),
    bbox: [
      dv.getInt16(head.off + 36),
      dv.getInt16(head.off + 38),
      dv.getInt16(head.off + 40),
      dv.getInt16(head.off + 42),
    ],
    outline(gid) {
      let o = cache.get(gid);
      if (o === undefined) {
        const out: Outline = { cmds: [], pts: [] };
        appendGlyph(gid, out, [1, 0, 0, 1, 0, 0], 0);
        o = out.cmds.length ? out : null;
        cache.set(gid, o);
      }
      return o;
    },
    advance(gid) {
      const i = Math.min(gid, numHMetrics - 1);
      return dv.getUint16(hmtx.off + 4 * i);
    },
    glyphFor: cmap,
  };
}

function appendSimple(dv: DataView, g: number, contours: number, out: Outline, m: number[]) {
  const ends: number[] = [];
  let p = g + 10;
  for (let i = 0; i < contours; i++, p += 2) ends.push(dv.getUint16(p));
  const count = contours ? ends[contours - 1] + 1 : 0;
  p += 2 + dv.getUint16(p);
  const flags = new Uint8Array(count);
  for (let i = 0; i < count;) {
    const f = dv.getUint8(p++);
    flags[i++] = f;
    if (f & 8) {
      let r = dv.getUint8(p++);
      while (r-- > 0 && i < count) flags[i++] = f;
    }
  }
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  let v = 0;
  for (let i = 0; i < count; i++) {
    const f = flags[i];
    if (f & 2) {
      const d = dv.getUint8(p++);
      v += f & 16 ? d : -d;
    } else if (!(f & 16)) {
      v += dv.getInt16(p);
      p += 2;
    }
    xs[i] = v;
  }
  v = 0;
  for (let i = 0; i < count; i++) {
    const f = flags[i];
    if (f & 4) {
      const d = dv.getUint8(p++);
      v += f & 32 ? d : -d;
    } else if (!(f & 32)) {
      v += dv.getInt16(p);
      p += 2;
    }
    ys[i] = v;
  }
  const push = (cmd: number, ...xy: number[]) => {
    out.cmds.push(cmd);
    for (let k = 0; k < xy.length; k += 2) {
      out.pts.push(m[0] * xy[k] + m[2] * xy[k + 1] + m[4], m[1] * xy[k] + m[3] * xy[k + 1] + m[5]);
    }
  };
  let s = 0;
  for (const e of ends) {
    const n = e - s + 1;
    if (n < 2) {
      s = e + 1;
      continue;
    }
    const on = (i: number) => (flags[s + (i % n)] & 1) !== 0;
    const X = (i: number) => xs[s + (i % n)];
    const Y = (i: number) => ys[s + (i % n)];
    // Start on an on-curve point, or the midpoint of two off-curve points.
    let first = 0;
    let sx: number;
    let sy: number;
    if (on(0)) {
      sx = X(0);
      sy = Y(0);
      first = 1;
    } else if (on(n - 1)) {
      sx = X(n - 1);
      sy = Y(n - 1);
      first = 0;
    } else {
      sx = (X(0) + X(n - 1)) / 2;
      sy = (Y(0) + Y(n - 1)) / 2;
      first = 0;
    }
    push(0, sx, sy);
    const last = on(0) ? n : on(n - 1) ? n - 1 : n;
    let cx = NaN;
    let cy = NaN;
    for (let i = first; i <= last; i++) {
      const closing = i === last;
      const px = closing ? sx : X(i);
      const py = closing ? sy : Y(i);
      const isOn = closing || on(i);
      if (isOn) {
        if (Number.isNaN(cx)) push(1, px, py);
        else push(2, cx, cy, px, py);
        cx = NaN;
      } else if (Number.isNaN(cx)) {
        cx = px;
        cy = py;
      } else {
        const mx = (cx + px) / 2;
        const my = (cy + py) / 2;
        push(2, cx, cy, mx, my);
        cx = px;
        cy = py;
      }
    }
    out.cmds.push(4);
    s = e + 1;
  }
}

function readCmap(dv: DataView, cmap: { off: number; len: number } | undefined): (cp: number) => number {
  if (!cmap) return () => 0;
  const n = dv.getUint16(cmap.off + 2);
  let best = -1;
  let bestRank = -1;
  let symbol = false;
  for (let i = 0; i < n; i++) {
    const r = cmap.off + 4 + 8 * i;
    const pid = dv.getUint16(r);
    const eid = dv.getUint16(r + 2);
    const sub = cmap.off + dv.getUint32(r + 4);
    const fmt = dv.getUint16(sub);
    if (fmt !== 4 && fmt !== 12) continue;
    const rank = fmt === 12 ? 3 : pid === 3 && eid === 1 ? 2 : pid === 0 ? 2 : pid === 3 && eid === 0 ? 1 : 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = sub;
      symbol = pid === 3 && eid === 0;
    }
  }
  if (best < 0) return () => 0;
  const sub = best;
  let lookup: (cp: number) => number;
  if (dv.getUint16(sub) === 12) {
    const groups = dv.getUint32(sub + 12);
    lookup = (cp) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = sub + 16 + 12 * mid;
        const a = dv.getUint32(g);
        const b = dv.getUint32(g + 4);
        if (cp < a) hi = mid - 1;
        else if (cp > b) lo = mid + 1;
        else return dv.getUint32(g + 8) + cp - a;
      }
      return 0;
    };
  } else {
    const segX2 = dv.getUint16(sub + 6);
    const ends = sub + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    lookup = (cp) => {
      if (cp > 0xffff) return 0;
      for (let i = 0; i < segX2; i += 2) {
        if (cp > dv.getUint16(ends + i)) continue;
        const start = dv.getUint16(starts + i);
        if (cp < start) return 0;
        const delta = dv.getInt16(deltas + i);
        const ro = dv.getUint16(ranges + i);
        if (ro === 0) return (cp + delta) & 0xffff;
        const gi = dv.getUint16(ranges + i + ro + 2 * (cp - start));
        return gi === 0 ? 0 : (gi + delta) & 0xffff;
      }
      return 0;
    };
  }
  // Symbol-encoded fonts map U+F0xx; text often carries the plain byte instead.
  return symbol ? (cp) => lookup(cp) || (cp < 0x100 ? lookup(0xf000 + cp) : 0) : lookup;
}

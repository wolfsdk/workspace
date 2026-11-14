// The series of a PowerPoint chart as a pack target. A series keeps its numbers in two places that must agree:
// the cache inside the chart part (what a viewer draws) and the chart's embedded workbook (what "Edit Data"
// opens). A refresh writes both; a series whose workbook cell holds a formula is refused, never overwritten.
import { cellName, parseRange } from "./a1.ts";
import { PackError } from "./errors.ts";
import { plainNumber } from "./numfmt.ts";
import { NS, type OoxmlPackage } from "./ooxml.ts";
import { XlsxWorkbook } from "./xlsx.ts";
import { applySplices, childrenNamed, descendantsNamed, firstChild, firstDescendant, leafText, namespace, type Splice, type XNode } from "./xml.ts";

export type SeriesPoints = { capacity: number; values: Map<number, number> };

export class Chart {
  readonly part: string;
  private readonly pkg: OoxmlPackage;
  private readonly src: string;
  private readonly root: XNode;
  private readonly c: (local: string) => string;

  constructor(pkg: OoxmlPackage, part: string) {
    this.pkg = pkg;
    this.part = part;
    const { src, root } = pkg.xml(part);
    this.src = src;
    this.root = root;
    this.c = namespace(root, NS.chart, "c");
  }

  private seriesName(series: XNode): string | undefined {
    const tx = firstChild(series, "tx");
    const v = tx === undefined ? undefined : firstDescendant(tx, "v");
    return v === undefined ? undefined : leafText(this.src, v);
  }

  /** The series `reference` names: `@n` (the n-th series of the chart) or its name. */
  series(reference: string): XNode {
    const all = descendantsNamed(this.root, "ser");
    let found: XNode[];
    if (/^@\d+$/.test(reference)) {
      const at = all[Number(reference.slice(1)) - 1];
      found = at === undefined ? [] : [at];
    } else {
      found = all.filter((s) => this.seriesName(s) === reference);
    }
    const [series] = found;
    if (series === undefined) throw new PackError("address-unresolved", `the chart ${this.part} has no series ${JSON.stringify(reference)}`);
    if (found.length > 1) throw new PackError("address-ambiguous", `the chart ${this.part} has several series named ${JSON.stringify(reference)}`);
    return series;
  }

  private numberCache(series: XNode): { ref: XNode; cache: XNode } {
    const values = firstChild(series, "val") ?? firstChild(series, "yVal");
    const ref = values === undefined ? undefined : firstChild(values, "numRef");
    const cache = ref === undefined ? undefined : firstChild(ref, "numCache");
    if (ref === undefined || cache === undefined) throw new PackError("unsupported-target", `a series of ${this.part} keeps its values in no number cache, which a pack does not fill`);
    return { ref, cache };
  }

  /** The cached numbers of a series by point index, and how many points it has. */
  read(series: XNode): SeriesPoints {
    const { cache } = this.numberCache(series);
    const values = new Map<number, number>();
    const pts = childrenNamed(cache, "pt");
    for (const pt of pts) {
      const v = firstChild(pt, "v");
      const n = Number(v === undefined ? Number.NaN : leafText(this.src, v));
      if (Number.isFinite(n)) values.set(Number(pt.attrs.idx), n);
    }
    const count = firstChild(cache, "ptCount");
    return { capacity: count === undefined ? pts.length : Number(count.attrs.val), values };
  }

  /** Splices of the chart part that give `points` (index to number) to `series`. */
  splices(series: XNode, points: ReadonlyMap<number, number>, order: number): Splice[] {
    const { cache } = this.numberCache(series);
    const pts = childrenNamed(cache, "pt");
    const out: Splice[] = [];
    const c = this.c;
    for (const [index, value] of [...points].sort((a, b) => a[0] - b[0])) {
      const text = plainNumber(value);
      const existing = pts.find((p) => Number(p.attrs.idx) === index);
      const v = existing === undefined ? undefined : firstChild(existing, "v");
      if (v !== undefined) {
        out.push({ start: v.openEnd, end: v.closeStart, text, order });
      } else if (existing !== undefined) {
        out.push({ start: existing.openEnd, end: existing.closeStart, text: `<${c("v")}>${text}</${c("v")}>`, order });
      } else {
        const before = pts.find((p) => Number(p.attrs.idx) > index);
        const last = pts[pts.length - 1];
        const count = firstChild(cache, "ptCount");
        const at = before !== undefined ? before.start : last !== undefined ? last.end : count !== undefined ? count.end : cache.openEnd;
        out.push({ start: at, end: at, text: `<${c("pt")} idx="${index}"><${c("v")}>${text}</${c("v")}></${c("pt")}>`, order });
      }
    }
    return out;
  }

  /** Write the chart's changed splices back, and the same numbers into its embedded workbook. */
  write(changes: readonly { series: XNode; points: ReadonlyMap<number, number>; order: number }[]): void {
    const splices = changes.flatMap((c) => this.splices(c.series, c.points, c.order));
    this.pkg.setText(this.part, applySplices(this.src, splices, this.part));
    for (const change of changes) this.writeWorkbook(change.series, change.points);
  }

  private writeWorkbook(series: XNode, points: ReadonlyMap<number, number>): void {
    const { ref } = this.numberCache(series);
    const formula = firstChild(ref, "f");
    const workbookRel = this.pkg.relationships(this.part).find((r) => r.type.endsWith("/package"));
    if (formula === undefined || workbookRel === undefined) return;
    const bytes = this.pkg.bytes(workbookRel.target);
    if (bytes === undefined) throw new PackError("package-missing-part", `the chart ${this.part} names the embedded workbook ${workbookRel.target}, which the package does not hold`);
    const m = /^(?:'((?:[^']|'')+)'|([^'!]+))!(.+)$/.exec(leafText(this.src, formula).trim());
    if (m === null) throw new PackError("unsupported-target", `the series formula ${JSON.stringify(leafText(this.src, formula))} of ${this.part} is not a sheet range`);
    const range = parseRange(m[3] ?? "");
    const vertical = range.from.column === range.to.column;
    if (!vertical && range.from.row !== range.to.row) throw new PackError("unsupported-target", `the series range of ${this.part} is a block, not one row or one column`);
    const writes = [...points].map(([index, value]) => ({ ref: cellName(vertical ? { column: range.from.column, row: range.from.row + index } : { column: range.from.column + index, row: range.from.row }), value }));
    const workbook = new XlsxWorkbook(bytes, workbookRel.target);
    workbook.writeNumbers((m[1] ?? m[2] ?? "").replace(/''/g, "'"), writes);
    this.pkg.setBytes(workbookRel.target, workbook.save());
  }
}

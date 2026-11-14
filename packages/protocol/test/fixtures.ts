import type { Change, Op, TransactionSummary } from "../src/index.ts";
import type { HistoryEntry } from "../src/index.ts";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal stored (uncompressed) ZIP writer: local headers, central directory, end record. */
export function writeZip(items: { name: string; data: string }[]): Uint8Array {
  const out: number[] = [];
  const u16 = (n: number) => out.push(n & 0xff, (n >>> 8) & 0xff);
  const u32 = (n: number) => out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  const enc = new TextEncoder();
  const rows = items.map((it) => {
    const data = enc.encode(it.data);
    const name = enc.encode(it.name);
    const offset = out.length;
    u32(0x04034b50);
    u16(20);
    u16(0x0800);
    u16(0);
    u16(0);
    u16(0x21);
    u32(crc32(data));
    u32(data.length);
    u32(data.length);
    u16(name.length);
    u16(0);
    out.push(...name, ...data);
    return { name, crc: crc32(data), size: data.length, offset };
  });
  const cdStart = out.length;
  for (const r of rows) {
    u32(0x02014b50);
    u16(20);
    u16(20);
    u16(0x0800);
    u16(0);
    u16(0);
    u16(0x21);
    u32(r.crc);
    u32(r.size);
    u32(r.size);
    u16(r.name.length);
    u16(0);
    u16(0);
    u16(0);
    u16(0);
    u32(0);
    u32(r.offset);
    out.push(...r.name);
  }
  const cdSize = out.length - cdStart;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(rows.length);
  u16(rows.length);
  u32(cdSize);
  u32(cdStart);
  u16(0);
  return Uint8Array.from(out);
}

const hex = (c: string) => c.repeat(64);

/** One applied batch of two ops on a sheet: op 0 changes A1, op 1 changes B2, and a recalculated
 * dependent (C3) carries no `cause`. */
export function twoOpEntry(): HistoryEntry {
  const ops: Op[] = [
    { op: "set", target: "sheet:#1/cell:A1", value: { type: "number", number: 1 } },
    { op: "set", target: "sheet:#1/cell:B2", value: { type: "number", number: 2 } },
  ];
  const diff: Change[] = [
    { address: "sheet:#1/cell:A1", change: "modified", kind: "cell", parts: ["xl/worksheets/sheet1.xml"], property: "value", cause: 0 },
    { address: "sheet:#1/cell:B2", change: "modified", kind: "cell", parts: ["xl/worksheets/sheet1.xml"], property: "value", cause: 1 },
    { address: "sheet:#1/cell:C3", change: "modified", kind: "cell", parts: ["xl/worksheets/sheet1.xml"], property: "value" },
  ];
  return {
    revision: 1,
    label: "Edit two cells",
    source: "test",
    ops,
    diff,
    transaction: { base_sha256: hex("a"), result_sha256: hex("b"), committed: true } as unknown as TransactionSummary,
    baseSha256: hex("a"),
    resultSha256: hex("b"),
    appliedAt: Date.UTC(2026, 0, 1),
  };
}

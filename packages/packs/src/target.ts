// What every target document (DOCX, PPTX) gives the planner and the applier.
import type { PackBinding, RoomOp } from "@wolfsdk/protocol/workspace";
import { PackError } from "./errors.ts";

/** The ops that bring one target up to date, and what a person should know about how it was fitted. An empty `ops`
 * is a target that is already fresh. */
export type Planned = { ops: RoomOp[]; notes: string[] };

export type FitBinding = Pick<PackBinding, "id" | "target_address" | "fit_policy">;

/** `address` without the key `prefix` (`table:`, `bookmark:`) it may carry: a pack may write either form. */
export function withoutPrefix(address: string, prefix: string): string {
  return address.startsWith(prefix) ? address.slice(prefix.length) : address;
}

/** What a table does with a block of `rows` x `columns` values when it has `rowCapacity` x `columnCapacity` cells. */
export type TableFit = { writeRows: number; writeColumns: number; growRows: number; notes: string[] };

export function fitTable(binding: FitBinding, what: string, source: { rows: number; columns: number }, capacity: { rows: number; columns: number }): TableFit {
  const rowOverflow = Math.max(0, source.rows - capacity.rows);
  const columnOverflow = Math.max(0, source.columns - capacity.columns);
  const notes: string[] = [];
  if (binding.fit_policy === "fail" && (rowOverflow > 0 || columnOverflow > 0)) {
    throw new PackError("table-overflow", `${what} has ${capacity.rows} rows and ${capacity.columns} columns, the source has ${source.rows} and ${source.columns}`);
  }
  if (binding.fit_policy === "grow" && columnOverflow > 0) {
    throw new PackError("table-overflow", `${what} has ${capacity.columns} columns, the source has ${source.columns}: a table grows by rows, not columns`);
  }
  const grow = binding.fit_policy === "grow" ? rowOverflow : 0;
  if (binding.fit_policy !== "grow" && rowOverflow > 0) notes.push(`${rowOverflow} source rows do not fit ${what} and are not written`);
  if (columnOverflow > 0) notes.push(`${columnOverflow} source columns do not fit ${what} and are not written`);
  if (grow > 0) notes.push(`${what} grows by ${grow} rows`);
  if (source.rows < capacity.rows) notes.push(`${capacity.rows - source.rows} rows of ${what} are not bound and keep their content`);
  return { writeRows: Math.min(source.rows, capacity.rows), writeColumns: Math.min(source.columns, capacity.columns), growRows: grow, notes };
}

/** `row` cut to `width` cells and padded with empty text up to it: the text of a row a table grows by. */
export function paddedRow(row: readonly string[], width: number): string[] {
  return Array.from({ length: width }, (_, i) => row[i] ?? "");
}

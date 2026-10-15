import type { ReportDefinition } from "@/modules/reports/registry";
import { formatCell } from "@/modules/reports/format";
import type { ReportPayload } from "@/modules/reports/types";

/**
 * Phase 16 — CSV export. Starts with a UTF-8 byte-order mark so Excel reads the file as UTF-8.
 * Text cells that begin with = + - @ or a control character get a leading apostrophe, so a
 * product name cannot run as a formula when the file is opened.
 */

const BOM = "\uFEFF";
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvField(value: string, isText: boolean): string {
  let out = value;
  if (isText && FORMULA_START.test(out)) out = `'${out}`;
  if (/[",\r\n]/.test(out)) out = `"${out.replace(/"/g, '""')}"`;
  return out;
}

export function buildCsv(def: ReportDefinition, payload: ReportPayload): string {
  const header = def.columns.map((c) => csvField(c.label, true)).join(",");
  const body = payload.rows.map((row) =>
    def.columns.map((c) => csvField(formatCell(c, row, "csv"), c.type === "text")).join(","),
  );
  return `${BOM}${[header, ...body].join("\r\n")}\r\n`;
}

import ExcelJS from "exceljs";
import type { ReportDefinition, ReportColumn } from "@/modules/reports/registry";
import {
  excelNumberFormat,
  formatCell,
  formatValue,
  numericCellValue,
} from "@/modules/reports/format";
import type { ExportMeta, ReportPayload, ReportRow } from "@/modules/reports/types";

/**
 * Phase 16 — Excel export (.xlsx) via exceljs. Money, quantity and percentage cells are real
 * numbers with number formats, so totals can be summed in the sheet. Dates are Excel dates.
 * The header row is frozen and filterable. The sheet opens with the report context.
 */

const HEADER_FILL = "FFEFE7D6";

function sheetName(title: string): string {
  // Excel allows at most 31 characters and forbids : \ / ? * [ ]
  return title.replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || "Report";
}

function cellValue(column: ReportColumn, row: ReportRow): ExcelJS.CellValue {
  const raw = row[column.key];
  if (column.type === "date") {
    if (typeof raw !== "string" || !raw) return null;
    return new Date(`${raw}T00:00:00Z`);
  }
  if (column.type === "datetime") {
    if (typeof raw !== "string" || !raw) return null;
    return new Date(raw);
  }
  if (column.type === "bool") {
    return raw === true ? "Yes" : raw === false ? "No" : null;
  }
  if (column.type === "period") {
    return formatCell(column, row, "csv");
  }
  const numeric = numericCellValue(column.type, raw);
  if (numeric !== null) return numeric;
  if (raw === null || raw === undefined || raw === "") return null;
  return String(raw);
}

function dateFormatFor(type: ReportColumn["type"]): string | null {
  if (type === "date") return "dd-mmm-yyyy";
  if (type === "datetime") return "dd-mmm-yyyy hh:mm";
  return null;
}

export async function buildXlsx(
  def: ReportDefinition,
  payload: ReportPayload,
  meta: ExportMeta,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "RestroNex";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(sheetName(def.title));
  const columnCount = def.columns.length;

  sheet.addRow([def.title]).font = { bold: true, size: 14 };
  sheet.addRow([`Business: ${meta.businessName}`]);
  sheet.addRow([`Outlets: ${meta.outletLabel}`]);
  if (meta.dateLabel) sheet.addRow([`Period: ${meta.dateLabel}`]);
  if (meta.search) sheet.addRow([`Search: ${meta.search}`]);
  sheet.addRow([`Generated: ${meta.generatedAt} (Asia/Kolkata)`]);
  sheet.addRow([`Basis: ${meta.basis}`]).font = { italic: true, color: { argb: "FF555555" } };
  sheet.addRow([]);

  sheet.addRow(["Summary"]).font = { bold: true };
  for (const item of def.summary) {
    const raw = payload.summary[item.key];
    const numeric = numericCellValue(item.type, raw);
    const row = sheet.addRow([item.label, numeric ?? formatValue(item.type, raw, {}, "csv")]);
    const fmt = excelNumberFormat(item.type);
    if (fmt && numeric !== null) row.getCell(2).numFmt = fmt;
  }
  sheet.addRow([]);

  const header = sheet.addRow(def.columns.map((c) => c.label));
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  const headerRowNumber = header.number;

  for (const row of payload.rows) {
    const values = def.columns.map((c) => cellValue(c, row));
    const excelRow = sheet.addRow(values);
    def.columns.forEach((c, index) => {
      const cell = excelRow.getCell(index + 1);
      const fmt = excelNumberFormat(c.type) ?? dateFormatFor(c.type);
      if (fmt && cell.value !== null) cell.numFmt = fmt;
    });
  }

  sheet.views = [{ state: "frozen", ySplit: headerRowNumber }];
  if (payload.rows.length > 0) {
    sheet.autoFilter = {
      from: { row: headerRowNumber, column: 1 },
      to: { row: headerRowNumber, column: columnCount },
    };
  }
  def.columns.forEach((c, index) => {
    sheet.getColumn(index + 1).width = Math.min(44, Math.max(14, c.label.length + 6));
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

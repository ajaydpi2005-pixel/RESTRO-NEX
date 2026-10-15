import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildCsv, csvField } from "@/modules/reports/csv";
import {
  excelNumberFormat,
  formatCell,
  formatDateTime,
  formatDay,
  formatMoney,
  formatPercent,
  formatPeriod,
  formatQty,
  formatUnitCost,
  formatValue,
  numericCellValue,
  paiseToRupees,
  toPdfText,
} from "@/modules/reports/format";
import { buildPdf } from "@/modules/reports/pdf";
import {
  REPORT_GROUPS,
  REPORT_SLUGS,
  REPORTS,
  findReport,
  reportsInGroup,
} from "@/modules/reports/registry";
import {
  EXPORT_ROW_LIMIT,
  MAX_RANGE_DAYS,
  addDays,
  daysBetween,
  exportRowsError,
  isIsoDate,
  istToday,
  pageCount,
  pageOffset,
  parseReportFilters,
} from "@/modules/reports/schemas";
import { buildXlsx } from "@/modules/reports/xlsx";
import type { ExportMeta, ReportPayload } from "@/modules/reports/types";
import { reportHref, exportHref } from "@/modules/reports/urls";

// Phase 16 defines the report functions; Phase 17 adds the channel report.
const MIGRATION = [
  "supabase/migrations/20261014100000_reports.sql",
  "supabase/migrations/20261015100000_online_ordering.sql",
]
  .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
  .join("\n");

const TODAY = "2026-10-15";

describe("registry", () => {
  it("has 25 reports across the five groups (Phase 16 spec plus the Phase 17 channel report)", () => {
    expect(REPORTS).toHaveLength(25);
    expect(REPORT_GROUPS.map((g) => g.key)).toEqual([
      "sales",
      "financial",
      "inventory",
      "staff",
      "customer",
    ]);
    const counts = Object.fromEntries(
      REPORT_GROUPS.map((g) => [g.key, reportsInGroup(g.key).length]),
    );
    expect(counts).toEqual({ sales: 7, financial: 5, inventory: 5, staff: 4, customer: 4 });
  });

  it("uses unique slugs and finds each one", () => {
    expect(new Set(REPORT_SLUGS).size).toBe(REPORTS.length);
    for (const def of REPORTS) expect(findReport(def.slug)).toBe(def);
    expect(findReport("no-such-report")).toBeNull();
  });

  it("maps every report to an RPC that exists in the migration", () => {
    const declared = new Set(
      [...MIGRATION.matchAll(/create or replace function public\.(report_\w+)\(/g)].map(
        (m) => m[1],
      ),
    );
    const rpcs = new Set(REPORTS.map((r) => r.rpc));
    expect(rpcs.size).toBe(22);
    for (const rpc of rpcs) expect(declared.has(rpc), rpc).toBe(true);
  });

  it("only refers to column keys the migration actually builds", () => {
    for (const def of REPORTS) {
      for (const key of [...def.columns.map((c) => c.key), ...def.summary.map((s) => s.key)]) {
        if (key === "period_start" || key === "period_end") continue;
        // Keys are either quoted labels or bare SQL identifiers, so match a whole word.
        expect(new RegExp(`\\b${key}\\b`).test(MIGRATION), `${def.slug}.${key}`).toBe(true);
      }
    }
  });

  it("gives every bar column to a real money column, and every grain choice a period column", () => {
    for (const def of REPORTS) {
      if (def.bar) {
        const column = def.columns.find((c) => c.key === def.bar);
        expect(column, def.slug).toBeDefined();
        expect(column?.type, def.slug).toBe("money");
      }
      if (def.grain?.choose) {
        expect(def.columns[0]?.type, def.slug).toBe("period");
      }
    }
  });

  it("keeps money columns free of raw percentages and vice versa", () => {
    for (const def of REPORTS) {
      for (const c of def.columns) {
        if (c.key.endsWith("_minor")) expect(c.type, `${def.slug}.${c.key}`).toBe("money");
      }
    }
  });
});

describe("schemas", () => {
  it("reads the IST date, not the UTC date", () => {
    // 20:00 UTC on 14 Oct is 01:30 on 15 Oct in Kolkata.
    expect(istToday(new Date("2026-10-14T20:00:00Z"))).toBe("2026-10-15");
    // 18:00 UTC on 14 Oct is 23:30 on 14 Oct in Kolkata.
    expect(istToday(new Date("2026-10-14T18:00:00Z"))).toBe("2026-10-14");
  });

  it("does calendar arithmetic without drift", () => {
    expect(addDays("2026-10-15", -29)).toBe("2026-09-16");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-09-16", "2026-10-15")).toBe(29);
    expect(daysBetween("2026-10-15", "2026-10-15")).toBe(0);
  });

  it("rejects impossible dates", () => {
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("15/10/2026")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
  });

  it("defaults to the last 30 days, page 1, all outlets, day grain", () => {
    const def = findReport("sales-daily")!;
    const parsed = parseReportFilters({}, def, TODAY);
    expect(parsed.error).toBeNull();
    expect(parsed.filters).toEqual({
      from: "2026-09-16",
      to: "2026-10-15",
      outletId: null,
      search: "",
      grain: "day",
      page: 1,
    });
  });

  it("caps the range at 400 days, inclusive of the rule in the database", () => {
    const def = findReport("sales-daily")!;
    const ok = parseReportFilters({ from: addDays(TODAY, -MAX_RANGE_DAYS), to: TODAY }, def, TODAY);
    expect(ok.error).toBeNull();
    const tooLong = parseReportFilters(
      { from: addDays(TODAY, -MAX_RANGE_DAYS - 1), to: TODAY },
      def,
      TODAY,
    );
    expect(tooLong.error).toMatch(/400 days/);
    expect(tooLong.filters.from).toBe("2026-09-16");
  });

  it("reports an inverted range and falls back to the defaults", () => {
    const def = findReport("sales-daily")!;
    const parsed = parseReportFilters({ from: "2026-10-10", to: "2026-10-01" }, def, TODAY);
    expect(parsed.error).toMatch(/start is after the end/);
    expect(parsed.filters.to).toBe(TODAY);
  });

  it("flags bad dates, bad outlets, bad grains and bad pages", () => {
    const def = findReport("sales-daily")!;
    expect(parseReportFilters({ from: "2026-02-31" }, def, TODAY).error).toMatch(/real date/);
    expect(parseReportFilters({ outlet: "main" }, def, TODAY).error).toMatch(/outlet/);
    const chooser = REPORTS.find((r) => r.grain?.choose)!;
    expect(parseReportFilters({ grain: "year" }, chooser, TODAY).error).toMatch(
      /day, week or month/,
    );
    expect(parseReportFilters({ page: "0" }, def, TODAY).error).toMatch(/page/);
    expect(parseReportFilters({ page: "abc" }, def, TODAY).error).toMatch(/page/);
  });

  it("accepts a grain only for reports that offer one", () => {
    const chooser = REPORTS.find((r) => r.grain?.choose)!;
    expect(parseReportFilters({ grain: "week" }, chooser, TODAY).filters.grain).toBe("week");
    const fixed = REPORTS.find((r) => r.grain && !r.grain.choose)!;
    expect(parseReportFilters({ grain: "week" }, fixed, TODAY).filters.grain).toBe(
      (fixed.grain as { value: string }).value,
    );
  });

  it("ignores date filters on reports that have none, and trims search", () => {
    const stock = findReport("inventory-stock")!;
    const parsed = parseReportFilters({ from: "garbage", q: "  rice  " }, stock, TODAY);
    expect(parsed.error).toBeNull();
    const search = findReport("sales-product")!;
    expect(parseReportFilters({ q: "x".repeat(200) }, search, TODAY).filters.search).toHaveLength(
      80,
    );
    expect(parseReportFilters({ q: "  rice  " }, search, TODAY).filters.search).toBe("rice");
  });

  it("pages in 25s and never reports zero pages", () => {
    expect(pageOffset(1)).toBe(0);
    expect(pageOffset(3)).toBe(50);
    expect(pageCount(0)).toBe(1);
    expect(pageCount(25)).toBe(1);
    expect(pageCount(26)).toBe(2);
  });

  it("refuses to export above the 20,000-row cap", () => {
    expect(EXPORT_ROW_LIMIT).toBe(20000);
    expect(exportRowsError(20000)).toBeNull();
    expect(exportRowsError(20001)).toMatch(/capped at 20,000/);
  });
});

describe("format", () => {
  it("shows paise as rupees to two decimals, in three styles", () => {
    expect(formatMoney(12345, "ui")).toBe("₹123.45");
    expect(formatMoney(12345, "csv")).toBe("123.45");
    expect(formatMoney(12345, "pdf")).toBe("Rs. 123.45");
  });

  it("groups Indian digits on screen and keeps CSV plain", () => {
    expect(formatMoney(123456789, "ui")).toBe("₹12,34,567.89");
    expect(formatMoney(123456789, "csv")).toBe("1234567.89");
    expect(formatMoney(-500, "csv")).toBe("-5.00");
  });

  it("rounds to the nearest paisa", () => {
    expect(paiseToRupees(1.4)).toBe(0.01);
    expect(paiseToRupees(-1)).toBe(-0.01);
  });

  it("shows unit cost to four decimals", () => {
    expect(formatUnitCost(4, "csv")).toBe("0.0400");
    expect(formatUnitCost(10, "ui")).toBe("₹0.1000");
    expect(formatUnitCost(4, "pdf")).toBe("Rs. 0.0400");
  });

  it("keeps quantities to three decimals and percentages to two", () => {
    expect(formatQty(1.5, "ui")).toBe("1.5");
    expect(formatQty(1234.5, "csv")).toBe("1234.5");
    expect(formatPercent(12.3456, "ui")).toBe("12.35%");
    expect(formatPercent(12.3456, "csv")).toBe("12.35");
  });

  it("labels periods as a day, a calendar month, or a range", () => {
    expect(formatDay("2026-10-15")).toBe("15 Oct 2026");
    expect(formatPeriod("2026-10-15", "2026-10-15")).toBe("15 Oct 2026");
    expect(formatPeriod("2026-10-01", "2026-10-31")).toBe("Oct 2026");
    expect(formatPeriod("2026-10-12", "2026-10-18")).toBe("12 Oct 2026 – 18 Oct 2026");
  });

  it("shows times in Asia/Kolkata", () => {
    expect(formatDateTime("2026-10-15T08:30:00Z", "csv")).toBe("2026-10-15 14:00");
    expect(formatDateTime("2026-10-15T08:30:00Z", "ui")).toContain("14:00");
  });

  it("renders booleans, text and empties without throwing", () => {
    expect(formatValue("bool", true, {}, "ui")).toBe("Yes");
    expect(formatValue("bool", false, {}, "csv")).toBe("No");
    expect(formatValue("text", null, {}, "ui")).toBe("—");
    expect(formatValue("money", undefined, {}, "csv")).toBe("0.00");
  });

  it("uses the period's end date for a range in CSV", () => {
    expect(
      formatCell(
        { key: "period_start", label: "P", type: "period" },
        { period_start: "2026-10-12", period_end: "2026-10-18" },
        "csv",
      ),
    ).toBe("2026-10-12 to 2026-10-18");
  });

  it("gives Excel numeric values and number formats", () => {
    expect(numericCellValue("money", 1234)).toBe(12.34);
    expect(numericCellValue("text", "abc")).toBeNull();
    expect(numericCellValue("money", null)).toBeNull();
    expect(excelNumberFormat("money")).toBe("#,##0.00");
    expect(excelNumberFormat("unit_cost")).toBe("#,##0.0000");
    expect(excelNumberFormat("text")).toBeNull();
  });

  it("keeps PDF text inside the standard font set", () => {
    expect(toPdfText("₹5 − 2")).toBe("Rs. 5 - 2");
    expect(toPdfText("“quoted” ‘x’")).toBe("\"quoted\" 'x'");
  });
});

describe("csv", () => {
  const def = findReport("staff-discounts")!;
  it("starts with a byte-order mark and uses CRLF", () => {
    const payload: ReportPayload = { total: 0, rows: [], summary: {} };
    const out = buildCsv(def, payload);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.endsWith("\r\n")).toBe(true);
    expect(out.split("\r\n")[0]).toContain("Staff");
  });

  it("writes money as plain rupees with two decimals", () => {
    const row: Record<string, unknown> = {
      user_id: "u1",
      user_name: "Asha",
      orders: 3,
      discounted_orders: 1,
      gross_minor: 150000,
      manual_minor: 5000,
      promotion_minor: 0,
      total_discount_minor: 5000,
      discount_pct: 3.33,
    };
    const out = buildCsv(def, { total: 1, rows: [row], summary: {} });
    const line = out.split("\r\n")[1]!;
    expect(line).toContain("1500.00");
    expect(line).toContain("50.00");
    expect(line).not.toContain("₹");
  });

  it("escapes commas, quotes and formula-like text", () => {
    expect(csvField("a,b", true)).toBe('"a,b"');
    expect(csvField('say "hi"', true)).toBe('"say ""hi"""');
    expect(csvField("=HYPERLINK(1)", true)).toBe("'=HYPERLINK(1)");
    expect(csvField("+42", true)).toBe("'+42");
    expect(csvField("@cmd", true)).toBe("'@cmd");
    // A number is not text, so it is never prefixed.
    expect(csvField("-5.00", false)).toBe("-5.00");
  });

  it("guards a product name that starts with a formula character", () => {
    const products = findReport("sales-product")!;
    const row: Record<string, unknown> = {
      item_id: "p1",
      item_name: "=SUM(A1)",
      item_kind: "menu",
      category: "Mains",
      orders: 1,
      quantity: 2,
      gross_minor: 1000,
      share_pct: 100,
    };
    const out = buildCsv(products, { total: 1, rows: [row], summary: {} });
    expect(out).toContain("'=SUM(A1)");
  });
});

describe("xlsx round trip", () => {
  const def = findReport("sales-daily")!;
  const payload: ReportPayload = {
    total: 2,
    rows: [
      {
        period_start: "2026-10-14",
        period_end: "2026-10-14",
        orders: 4,
        gross_minor: 123456,
        discount_minor: 0,
        net_sales_minor: 123456,
        tax_minor: 6173,
        billed_minor: 129629,
        avg_order_minor: 30864,
      },
      {
        period_start: "2026-10-15",
        period_end: "2026-10-15",
        orders: 1,
        gross_minor: 1000,
        discount_minor: 100,
        net_sales_minor: 900,
        tax_minor: 45,
        billed_minor: 945,
        avg_order_minor: 945,
      },
    ],
    summary: {
      orders: 5,
      gross_minor: 124456,
      discount_minor: 100,
      net_sales_minor: 124356,
      tax_minor: 6218,
      billed_minor: 130574,
      avg_order_minor: 26114,
    },
  };
  const meta: ExportMeta = {
    businessName: "Demo",
    outletLabel: "All outlets",
    from: "2026-10-14",
    to: "2026-10-15",
    dateLabel: "14 Oct 2026 – 15 Oct 2026",
    search: "",
    generatedAt: "15 Oct 2026, 14:00",
    basis: def.basis,
  };

  it("writes real numbers that read back to the same money", async () => {
    const buffer = await buildXlsx(def, payload, meta);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0]!;
    expect(sheet.name).toBe(def.title);

    // Find the header row by its first column label.
    let headerRow = 0;
    sheet.eachRow((row, n) => {
      if (!headerRow && row.getCell(1).value === "Period") headerRow = n;
    });
    expect(headerRow).toBeGreaterThan(0);
    const headers = sheet.getRow(headerRow).values as unknown[];
    const grossCol = headers.indexOf("Gross sales");
    const dataRow = sheet.getRow(headerRow + 1);
    expect(dataRow.getCell(grossCol).value).toBe(1234.56);
    expect(dataRow.getCell(grossCol).numFmt).toBe("#,##0.00");
    // Period cells are text, so a range can read "12 Oct to 18 Oct" in the sheet. A single day is ISO.
    expect(dataRow.getCell(1).value).toBe("2026-10-14");
    expect(sheet.views[0]).toMatchObject({ state: "frozen" });
  });
});

/**
 * Raw PDF plus every inflated content stream. pdfkit compresses page content and writes text as
 * hex glyph strings inside TJ arrays, so decode those too.
 */
function pdfText(buffer: Buffer): string {
  const raw = buffer.toString("latin1");
  const parts = [raw];
  const starts = [...raw.matchAll(/stream\r?\n/g)];
  for (const match of starts) {
    const start = (match.index ?? 0) + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    try {
      const content = inflateSync(buffer.subarray(start, end)).toString("latin1");
      // Each TJ array holds kerned pieces of one string. Join the pieces so words read whole.
      const joined = content.replace(/\[([^\]]*)\]\s*TJ/g, (_, inner: string) => {
        const pieces = [...inner.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) =>
          Buffer.from(m[1]!, "hex").toString("latin1"),
        );
        return `(${pieces.join("")}) Tj`;
      });
      parts.push(joined);
    } catch {
      // Not a compressed stream (e.g. the end of "endstream" matched). Skip it.
    }
  }
  return parts.join("\n");
}

describe("pdf", () => {
  const def = findReport("staff-discounts")!;
  const payload: ReportPayload = {
    total: 1,
    rows: [
      {
        user_id: "u1",
        user_name: "Asha",
        orders: 3,
        discounted_orders: 1,
        gross_minor: 150000,
        manual_minor: 5000,
        promotion_minor: 0,
        total_discount_minor: 5000,
        discount_pct: 3.33,
      },
    ],
    summary: {
      orders: 3,
      discounted_orders: 1,
      gross_minor: 150000,
      manual_minor: 5000,
      promotion_minor: 0,
      total_discount_minor: 5000,
      discount_pct: 3.33,
    },
  };
  const meta: ExportMeta = {
    businessName: "Demo",
    outletLabel: "All outlets",
    from: "2026-09-16",
    to: "2026-10-15",
    dateLabel: "16 Sep 2026 – 15 Oct 2026",
    search: "",
    generatedAt: "15 Oct 2026, 14:00",
    basis: def.basis,
  };

  it("starts with the PDF header and ends with an end-of-file marker", async () => {
    const buffer = await buildPdf(def, payload, meta);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("sets the document title and prints money with the Rs. prefix", async () => {
    const buffer = await buildPdf(def, payload, meta);
    const text = pdfText(buffer);
    expect(text).toContain(`(${def.title})`);
    expect(text).toContain("Rs. 1,500.00");
    expect(text).not.toContain("₹");
  });

  it("uses landscape for wide reports and portrait for narrow ones", async () => {
    const wide = findReport("sales-daily")!;
    const wideBuffer = await buildPdf(
      wide,
      { total: 0, rows: [], summary: {} },
      { ...meta, basis: wide.basis },
    );
    expect(wideBuffer.toString("latin1")).toContain("841.89 595.28");
    const narrow = findReport("staff-refunds")!;
    expect(narrow.columns.length).toBeLessThanOrEqual(5);
    const narrowBuffer = await buildPdf(
      narrow,
      { total: 0, rows: [], summary: {} },
      { ...meta, basis: narrow.basis },
    );
    expect(narrowBuffer.toString("latin1")).toContain("595.28 841.89");
  });
});

describe("urls", () => {
  const def = findReport("sales-daily")!;
  const filters = {
    from: "2026-10-01",
    to: "2026-10-15",
    outletId: null,
    search: "",
    grain: "day" as const,
    page: 1,
  };

  it("carries only the filters that apply to the report", () => {
    const href = reportHref(
      def,
      "b1",
      { ...filters, outletId: "00000000-0000-0000-0000-000000000001" },
      { page: "2" },
    );
    expect(href).toContain("business=b1");
    expect(href).toContain("from=2026-10-01");
    expect(href).toContain("outlet=00000000-0000-0000-0000-000000000001");
    expect(href).toContain("page=2");
  });

  it("builds export links with the report and format", () => {
    const href = exportHref(def, "b1", filters, "pdf");
    expect(href.startsWith("/api/reports/export?")).toBe(true);
    expect(href).toContain("report=sales-daily");
    expect(href).toContain("format=pdf");
  });
});

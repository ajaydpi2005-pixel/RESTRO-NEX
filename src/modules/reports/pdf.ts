import PDFDocument from "pdfkit";
import type { ReportDefinition } from "@/modules/reports/registry";
import { formatCell, formatValue, toPdfText } from "@/modules/reports/format";
import type { ExportMeta, ReportPayload, ReportRow } from "@/modules/reports/types";
import type { ReportColumn } from "@/modules/reports/registry";

/**
 * Phase 16 — PDF export via pdfkit, using the standard Helvetica fonts. Those fonts have no ₹,
 * so money reads "Rs." (toPdfText and the pdf style take care of it). Reports with more than
 * five columns are printed landscape. Header rows repeat on each page, and pages are numbered.
 */

const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";
const FONT_ITALIC = "Helvetica-Oblique";
const CELL_PAD = 3;
const MAX_WEIGHT_SAMPLE = 200;

/** Column weights from the header and a sample of values, so wide text gets the room. */
function columnWeights(def: ReportDefinition, rows: ReportRow[]): number[] {
  return def.columns.map((column) => {
    let longest = column.label.length;
    for (const row of rows.slice(0, MAX_WEIGHT_SAMPLE)) {
      longest = Math.max(longest, formatCell(column, row, "pdf").length);
    }
    return Math.min(36, Math.max(7, longest * 0.9));
  });
}

function alignFor(column: ReportColumn): "left" | "right" {
  return ["money", "unit_cost", "int", "points", "qty", "percent"].includes(column.type)
    ? "right"
    : "left";
}

export function buildPdf(
  def: ReportDefinition,
  payload: ReportPayload,
  meta: ExportMeta,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const landscape = def.columns.length > 5;
    const doc = new PDFDocument({
      size: "A4",
      layout: landscape ? "landscape" : "portrait",
      margin: 36,
      bufferPages: true,
      info: { Title: toPdfText(def.title), Author: "RestroNex", Creator: "RestroNex" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottomLimit = () => doc.page.height - doc.page.margins.bottom - 24;

    // ── header
    doc
      .font(FONT_BOLD)
      .fontSize(16)
      .fillColor("#000")
      .text(toPdfText(def.title), left, doc.page.margins.top, { width });
    doc.font(FONT).fontSize(9).fillColor("#333");
    const context = [
      `Business: ${meta.businessName}`,
      `Outlets: ${meta.outletLabel}`,
      meta.dateLabel ? `Period: ${meta.dateLabel}` : "",
      meta.search ? `Search: ${meta.search}` : "",
      `Generated: ${meta.generatedAt} (Asia/Kolkata)`,
    ].filter(Boolean);
    for (const line of context) doc.text(toPdfText(line), left, doc.y, { width });
    doc.moveDown(0.4);
    doc
      .font(FONT_ITALIC)
      .fontSize(8)
      .fillColor("#555")
      .text(toPdfText(meta.basis), left, doc.y, { width });
    doc.moveDown(0.6);

    // ── summary
    doc.font(FONT_BOLD).fontSize(10).fillColor("#000").text("Summary", left, doc.y, { width });
    doc.font(FONT).fontSize(9);
    for (const item of def.summary) {
      const value = formatValue(item.type, payload.summary[item.key], {}, "pdf");
      doc
        .font(FONT)
        .text(toPdfText(`${item.label}: `), left, doc.y, { width, continued: true })
        .font(FONT_BOLD)
        .text(toPdfText(value), { width, continued: false });
    }
    doc.moveDown(0.8);

    // ── table
    const columns = def.columns;
    const weights = columnWeights(def, payload.rows);
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / weightSum) * width);
    const xs = widths.reduce<number[]>((acc, w, i) => {
      acc.push(i === 0 ? left : acc[i - 1]! + widths[i - 1]!);
      return acc;
    }, []);

    const drawHeader = (y: number): number => {
      doc.font(FONT_BOLD).fontSize(8).fillColor("#000");
      const heights = columns.map((c, i) =>
        doc.heightOfString(toPdfText(c.label), { width: widths[i]! - CELL_PAD * 2 }),
      );
      const rowHeight = Math.max(...heights) + CELL_PAD * 2;
      doc.save().rect(left, y, width, rowHeight).fill("#EFE7D6").restore();
      columns.forEach((c, i) => {
        doc.fillColor("#000").text(toPdfText(c.label), xs[i]! + CELL_PAD, y + CELL_PAD, {
          width: widths[i]! - CELL_PAD * 2,
          align: alignFor(c),
        });
      });
      return y + rowHeight;
    };

    let y = doc.y;
    y = drawHeader(y);

    if (payload.rows.length === 0) {
      doc
        .font(FONT_ITALIC)
        .fontSize(9)
        .fillColor("#555")
        .text("No rows for this filter.", left, y + 6, { width });
    }

    doc.font(FONT).fontSize(8);
    for (const row of payload.rows) {
      const cells = columns.map((c) => toPdfText(formatCell(c, row, "pdf")));
      const heights = cells.map((t, i) =>
        doc.heightOfString(t, { width: widths[i]! - CELL_PAD * 2 }),
      );
      const rowHeight = Math.max(...heights) + CELL_PAD * 2;
      if (y + rowHeight > bottomLimit()) {
        doc.addPage();
        y = doc.page.margins.top;
        y = drawHeader(y);
        doc.font(FONT).fontSize(8);
      }
      doc.fillColor("#000");
      cells.forEach((text, i) => {
        doc.text(text, xs[i]! + CELL_PAD, y + CELL_PAD, {
          width: widths[i]! - CELL_PAD * 2,
          align: alignFor(columns[i]!),
          lineBreak: true,
        });
      });
      y += rowHeight;
      doc
        .save()
        .moveTo(left, y)
        .lineTo(left + width, y)
        .lineWidth(0.3)
        .strokeColor("#CCCCCC")
        .stroke()
        .restore();
    }

    // ── footers
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc
        .font(FONT)
        .fontSize(8)
        .fillColor("#666")
        .text(
          `RestroNex · ${toPdfText(def.title)} · Page ${i - range.start + 1} of ${range.count}`,
          left,
          doc.page.height - 28,
          {
            width,
            align: "right",
            lineBreak: false,
          },
        );
    }

    doc.end();
  });
}

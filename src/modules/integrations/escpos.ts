/**
 * Phase 18 — ESC/POS byte builder for network receipt and kitchen printers.
 * Pure: it returns bytes and never touches a socket.
 *
 * Text is plain ASCII. Anything outside printable ASCII becomes "?", because most
 * thermal printers have no Unicode code pages set up by default. Lines wrap at the
 * printer's column width.
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export const PAPER_WIDTHS = [32, 42, 48] as const;
export type PaperWidth = (typeof PAPER_WIDTHS)[number];
export const MAX_LINES = 200;
export const MAX_LINE_CHARS = 200;

export interface PrintLine {
  text: string;
  bold?: boolean;
  center?: boolean;
}

export function toPrinterAscii(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?");
}

/** Wraps one line at the column width, breaking at spaces where it can. */
export function wrapLine(text: string, width: number): string[] {
  const clean = toPrinterAscii(text);
  if (clean.length <= width) return [clean];
  const out: string[] = [];
  let rest = clean;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0 || out.length === 0) out.push(rest);
  return out;
}

export function buildEscPosDocument(lines: PrintLine[], width: PaperWidth = 32): Uint8Array {
  const bytes: number[] = [ESC, 0x40]; // initialise the printer

  for (const line of lines.slice(0, MAX_LINES)) {
    bytes.push(ESC, 0x61, line.center ? 1 : 0); // justification: 0 left, 1 centre
    bytes.push(ESC, 0x45, line.bold ? 1 : 0); // emphasis on or off
    for (const part of wrapLine(line.text.slice(0, MAX_LINE_CHARS), width)) {
      for (let i = 0; i < part.length; i++) bytes.push(part.charCodeAt(i));
      bytes.push(LF);
    }
  }

  bytes.push(ESC, 0x45, 0); // emphasis off
  bytes.push(ESC, 0x64, 4); // feed four lines before the cut
  bytes.push(GS, 0x56, 0x42, 0x00); // partial cut
  return Uint8Array.from(bytes);
}

/** Starts a rich tip, which rides in `Ui.tip` like a plain one; no plain tip begins with it. */
const MARK = "\u{1}";

export interface RichTip {
  title: string;
  /** A muted line under the title (e.g. the model). */
  sub?: string;
  /** Text under the title, across the whole width. */
  body?: string;
  /** Label and value pairs: a muted label, then a value that wraps; pairs with no value are left out. */
  rows?: readonly (readonly [string, string])[];
  /** Small and muted, under a line: what a click does. */
  hint?: string;
}

/** What TipLayer draws (widgets.slint `TipParts`); `rich` false: the tip is a plain string. */
export interface TipParts {
  rich: boolean;
  title: string;
  sub: string;
  body: string;
  rows: { label: string; value: string }[];
  hint: string;
}

/** One line of the encoding: no newlines or tabs inside. */
const line = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The tip string for `t`: the title, the subtitle, the body, a "label\tvalue" line per row, then the hint. */
export function richTip(t: RichTip): string {
  const rows = (t.rows ?? []).filter(([, v]) => line(v) !== "").map(([l, v]) => `${line(l)}\t${line(v)}`);
  return MARK + [line(t.title), line(t.sub ?? ""), line(t.body ?? ""), ...rows, line(t.hint ?? "")].join("\n");
}

const plain: TipParts = { rich: false, title: "", sub: "", body: "", rows: [], hint: "" };

/** `tip` read back (Ui.tip-parts); a plain tip gives `rich` false. */
export function tipParts(tip: string): TipParts {
  if (!tip.startsWith(MARK)) return plain;
  const [title = "", sub = "", body = "", ...rest] = tip.slice(MARK.length).split("\n");
  const hint = rest.pop() ?? "";
  const rows = rest.map((r) => {
    const tab = r.indexOf("\t");
    return { label: r.slice(0, tab), value: r.slice(tab + 1) };
  });
  return { rich: true, title, sub, body, rows, hint };
}

// "Forward to AI" (Person Hub's personAi.ts forwardedNote / splitForwarded): a message of the conversation sent to the
// person's AI as the subject of a question. The note carries a clearly marked <forwarded-message> block (author, time,
// attachments with their URLs and, when fetched, their files on this PC, the full text), then the user's question (a
// default one when empty). The AI thread reads the block back so the note shows as a quote and the question. Pure.
import { attachmentKind, formatBytes, formatDuration } from "./model/conversation.ts";
import type { Message } from "./model/types.ts";

export const FORWARD_DEFAULT_QUESTION = "What should I reply to this?";
const FWD_OPEN = "<forwarded-message>";
const FWD_CLOSE = "</forwarded-message>";
const LEAD = "The user forwarded this message from the conversation:";

/** A forwarded message as the AI thread shows it above the question. */
export interface ForwardedQuote {
  from: string;
  at?: string;
  text: string;
  attachment?: string;
}

/** "image · photo.png (1.2 MB)" / "voice message · 0:47" for a forwarded message's attachments. */
export function forwardAttachmentInfo(m: Pick<Message, "attachments" | "voice">): string {
  return (m.attachments ?? [])
    .filter(Boolean)
    .map((a) => {
      const k = attachmentKind(a);
      const kind = m.voice ? "voice message" : k !== "file" ? k : /\.pdf$/i.test(a.name ?? "") || a.type === "application/pdf" ? "pdf" : "file";
      const extra = [a.duration ? formatDuration(a.duration) : "", a.size ? formatBytes(a.size) : ""].filter(Boolean).join(", ");
      return `${kind} · ${a.name || "file"}${extra ? ` (${extra})` : ""}`;
    })
    .join("; ");
}

/** The note to the AI with a forwarded message. `files`: its attachments fetched to this PC (paths the agent can read). */
export function forwardedNote(o: { message: Pick<Message, "content" | "timestamp" | "attachments" | "voice">; from: string; question: string; files?: readonly string[] }): string {
  const m = o.message;
  const at = (m.timestamp ?? "").slice(0, 16).replace("T", " ");
  const info = forwardAttachmentInfo(m);
  const lines = [
    FWD_OPEN,
    `From: ${o.from}`,
    at ? `Time: ${at}` : "",
    info ? `Attachment: ${info}` : "",
    ...(m.attachments ?? []).filter((a) => a?.url).map((a) => `Attachment URL: ${a.url}`),
    ...(o.files ?? []).map((f) => `Attachment file on this PC: ${f}`),
    "Text:",
    (m.content ?? "").trim() || "(no text)",
    FWD_CLOSE,
  ].filter(Boolean);
  const q = o.question.trim() || FORWARD_DEFAULT_QUESTION;
  return `${LEAD}\n${lines.join("\n")}\n\n${q}`;
}

/** A note to the AI split into the forwarded message (if any) and the question. */
export function splitForwarded(text: string): { forwarded: ForwardedQuote | null; question: string } {
  const s = text ?? "";
  const i = s.indexOf(FWD_OPEN);
  const j = s.indexOf(FWD_CLOSE, i + 1);
  if (i < 0 || j < 0) return { forwarded: null, question: s };
  const body = s.slice(i + FWD_OPEN.length, j).replace(/^\n/, "").split("\n");
  const q: ForwardedQuote = { from: "", text: "" };
  let k = 0;
  for (; k < body.length; k++) {
    const l = body[k] ?? "";
    if (l === "Text:") {
      k++;
      break;
    }
    const [key, ...rest] = l.split(": ");
    const v = rest.join(": ");
    if (key === "From") q.from = v;
    else if (key === "Time") q.at = v;
    else if (key === "Attachment") q.attachment = v;
  }
  const t = body.slice(k).join("\n").trim();
  q.text = t === "(no text)" ? "" : t;
  const before = s.slice(0, i).replace(new RegExp(`${LEAD}\\s*$`), "").trim();
  const after = s.slice(j + FWD_CLOSE.length).trim();
  return { forwarded: q, question: [before, after].filter(Boolean).join("\n\n") };
}

/** Files of the forwarded message worth handing to the AI: images and PDFs under 20 MB, at most 4. */
export function forwardableFiles(m: Pick<Message, "attachments" | "voice">): { url: string; name: string }[] {
  return (m.attachments ?? [])
    .filter((a) => a?.url && (attachmentKind(a, m.voice) === "image" || /\.pdf$/i.test(a.name ?? "") || a.type === "application/pdf") && !(a.size && a.size > 20 << 20))
    .slice(0, 4)
    .map((a) => ({ url: a.url, name: a.name || "attachment" }));
}

// One Claude Code turn: the stream-json it prints, as events (agent.rs `parse_claude`), and the
// process. Always a new session in a scratch folder: nothing from the copied chats is resumed.

export type Event =
  | { type: "session"; id: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "text_final"; text: string }
  | { type: "thinking_final"; text: string }
  | { type: "tool"; id: string; name: string; summary: string; input: string }
  | { type: "tool_result"; id: string; result: string; is_error: boolean }
  | { type: "result"; cost_usd: number | null; duration_ms: number; turns: number; input_tokens: number; output_tokens: number; cached: number }
  | { type: "error"; text: string };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json | undefined };

const obj = (v: Json | undefined): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");
const num = (v: Json | undefined): number => (typeof v === "number" ? v : 0);

/** The input's most telling field, one line (agent.rs `tool_summary`). */
export function toolSummary(input: Json | undefined): string {
  const o = obj(input);
  for (const k of ["command", "file_path", "filePath", "path", "pattern", "url", "query", "description", "prompt"]) {
    const v = o[k];
    if (typeof v === "string") return [...(v.split("\n")[0] ?? "")].slice(0, 120).join("");
  }
  const t = JSON.stringify(input ?? null);
  return t === "{}" || t === "null" ? "" : [...t].slice(0, 120).join("");
}

/** A tool result's text (agent.rs `text_of`). */
export function textOf(c: Json | undefined): string {
  if (c === null || c === undefined) return "";
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return JSON.stringify(c);
  return c
    .map((b) => {
      const type = obj(b).type;
      if (type === "text") return str(obj(b).text);
      if (typeof type === "string") return `[${type}]`;
      return str(b);
    })
    .join("\n");
}

export function parseClaude(line: Json): Event[] {
  const v = obj(line);
  const parent = v.parent_tool_use_id;
  if (parent !== undefined && parent !== null) return [];
  switch (str(v.type)) {
    case "system": {
      if (v.subtype !== "init") return [];
      const id = str(v.session_id);
      return id ? [{ type: "session", id }] : [];
    }
    case "stream_event": {
      const e = obj(v.event);
      const d = obj(e.delta);
      if (e.type !== "content_block_delta") return [];
      if (d.type === "text_delta") return [{ type: "text_delta", text: str(d.text) }];
      if (d.type === "thinking_delta") return [{ type: "thinking_delta", text: str(d.thinking) }];
      return [];
    }
    case "assistant": {
      const out: Event[] = [];
      for (const b of arr(obj(v.message).content)) {
        const block = obj(b);
        if (block.type === "text") out.push({ type: "text_final", text: str(block.text) });
        else if (block.type === "thinking") out.push({ type: "thinking_final", text: str(block.thinking) });
        else if (block.type === "tool_use") {
          out.push({ type: "tool", id: str(block.id), name: str(block.name), summary: toolSummary(block.input), input: JSON.stringify(block.input ?? null, null, 2) });
        }
      }
      return out;
    }
    case "user": {
      const out: Event[] = [];
      for (const b of arr(obj(v.message).content)) {
        const block = obj(b);
        if (block.type === "tool_result") {
          out.push({ type: "tool_result", id: str(block.tool_use_id), result: textOf(block.content), is_error: block.is_error === true });
        }
      }
      return out;
    }
    case "result": {
      const u = obj(v.usage);
      const out: Event[] = [];
      if (v.is_error === true || v.subtype !== "success") {
        out.push({ type: "error", text: typeof v.result === "string" ? v.result : str(v.subtype) });
      }
      const cached = num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
      const cost = num(v.total_cost_usd);
      out.push({
        type: "result",
        cost_usd: cost > 0 ? cost : null,
        duration_ms: num(v.duration_ms),
        turns: num(v.num_turns),
        input_tokens: num(u.input_tokens) + cached,
        output_tokens: num(u.output_tokens),
        cached,
      });
      return out;
    }
    default:
      return [];
  }
}

/** What goes to Claude's stdin (agent.rs `claude_message`). */
export function claudeMessage(prompt: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } })}\n`;
}

/** A cheap, tool-less, session-less run: nothing is written to the real Claude projects folder. */
export function claudeArgs(model: string): string[] {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", model,
    "--effort", "low",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--tools", "",
  ];
}

export interface TurnOptions {
  bin: string;
  cwd: string;
  model: string;
  prompt: string;
  onEvent: (e: Event) => void;
}

export interface Turn {
  stop(): void;
  done: Promise<number>;
}

export function startTurn(o: TurnOptions): Turn {
  const proc = Bun.spawn([o.bin, ...claudeArgs(o.model)], { cwd: o.cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  proc.stdin.write(claudeMessage(o.prompt));
  void proc.stdin.end();
  const read = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          let v: Json;
          try {
            v = JSON.parse(line) as Json;
          } catch {
            nl = buf.indexOf("\n");
            continue;
          }
          for (const e of parseClaude(v)) o.onEvent(e);
        }
        nl = buf.indexOf("\n");
      }
    }
  })();
  return {
    stop: () => proc.kill(),
    done: read.then(() => proc.exited),
  };
}

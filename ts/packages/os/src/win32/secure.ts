// What has the keyboard focus on Windows, for computer use's refusal to type secrets: UI Automation's focused
// element (IsPassword) and the process that owns it (consent.exe, CredentialUIBroker.exe…). UI Automation calls
// into the focused app and can wait on it, so it runs in one hidden powershell.exe kept for the purpose (a line in,
// a JSON line out), never on Harbor's main thread; it quits when Harbor's end of the pipe closes.
import { type SecureFocus, parseWinFocus } from "../screen/secure.ts";

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
while ($null -ne ($l = [Console]::In.ReadLine())) {
  try {
    $c = [System.Windows.Automation.AutomationElement]::FocusedElement.Current
    $p = ''
    try { $p = (Get-Process -Id $c.ProcessId).ProcessName } catch {}
    $o = @{ ok = $true; password = [bool]$c.IsPassword; process = $p; cls = [string]$c.ClassName; type = [string]$c.ControlType.ProgrammaticName }
  } catch { $o = @{ ok = $false; error = [string]$_.Exception.Message } }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
`;

/** powershell.exe's command line for the helper. */
export function helperCommand(): string[] {
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")];
}

interface Helper {
  p: ReturnType<typeof Bun.spawn>;
  lines: AsyncIterator<string>;
}

let helper: Helper | null = null;
/** Calls go one at a time: each waits for the one before. */
let queue: Promise<unknown> = Promise.resolve();

async function* linesOf(s: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of s) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line !== "") yield line;
    }
  }
}

function start(): Helper {
  const p = Bun.spawn(helperCommand(), { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true });
  p.unref();
  return { p, lines: linesOf(p.stdout as ReadableStream<Uint8Array>)[Symbol.asyncIterator]() };
}

function stop(): void {
  try {
    helper?.p.kill();
  } catch {}
  helper = null;
}

/** The first answer waits for PowerShell to start and load UI Automation (about a second); later ones take milliseconds. */
const FIRST_MS = 6000;
const NEXT_MS = 1500;

async function ask(): Promise<SecureFocus> {
  const first = helper === null;
  const h = (helper ??= start());
  const stdin = h.p.stdin as import("bun").FileSink;
  stdin.write("?\n");
  stdin.flush();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), first ? FIRST_MS : NEXT_MS)));
  try {
    const r = await Promise.race([h.lines.next(), late]);
    if (r === "late") {
      // A hung app (or PowerShell): a fresh helper next time.
      stop();
      return { state: "unknown", why: "UI Automation didn't answer in time" };
    }
    if (r.done) {
      stop();
      return { state: "unknown", why: "the UI Automation helper quit" };
    }
    return parseWinFocus(r.value);
  } finally {
    clearTimeout(timer);
  }
}

/** What has the keyboard focus now; "unknown" when Windows won't say (never throws). */
export function secureFocus(): Promise<SecureFocus> {
  const next = queue.then(ask, ask).catch((e: unknown): SecureFocus => {
    stop();
    return { state: "unknown", why: e instanceof Error ? e.message : String(e) };
  });
  queue = next;
  return next;
}

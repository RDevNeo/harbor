// Windows' own Open dialog (or its folder dialog) for Harbor's file pickers: run by PowerShell (Windows Forms) in a
// process of its own, so Harbor's window keeps drawing while it's open. It prints the chosen paths, one a line,
// and exits 1 when cancelled.

export interface PickOptions {
  title?: string;
  multiple?: boolean;
  /** A name and its patterns: ["Images", ["*.png", "*.jpg"]]. */
  filter?: readonly [string, readonly string[]];
  dir?: string;
  directory?: boolean;
}

/** A PowerShell string literal (single quotes, a quote doubled). */
const lit = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/** The script that shows the dialog. */
export function pickerScript(o: PickOptions): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    // An owner on top of everything: the dialog comes up in front of Harbor, not behind it.
    "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'CenterScreen' }",
    "$owner.Show(); $owner.Activate()",
  ];
  if (o.directory) {
    lines.push("$d = New-Object System.Windows.Forms.FolderBrowserDialog", "$d.ShowNewFolderButton = $true");
    if (o.title) lines.push(`$d.Description = ${lit(o.title)}`);
    if (o.dir) lines.push(`$d.SelectedPath = ${lit(o.dir)}`);
    lines.push("if ($d.ShowDialog($owner) -ne 'OK') { exit 1 }", "$d.SelectedPath");
  } else {
    lines.push("$d = New-Object System.Windows.Forms.OpenFileDialog", `$d.Multiselect = $${o.multiple ? "true" : "false"}`);
    if (o.title) lines.push(`$d.Title = ${lit(o.title)}`);
    if (o.filter) lines.push(`$d.Filter = ${lit(`${o.filter[0]} (${o.filter[1].join(", ")})|${o.filter[1].join(";")}|All files (*.*)|*.*`)}`);
    if (o.dir) lines.push(`$d.InitialDirectory = ${lit(o.dir)}`);
    lines.push("if ($d.ShowDialog($owner) -ne 'OK') { exit 1 }", "$d.FileNames");
  }
  return lines.join("\n");
}

/** powershell.exe's command line for it (the script as -EncodedCommand: nothing to quote). */
export function pickerCommand(o: PickOptions): string[] {
  const enc = Buffer.from(pickerScript(o), "utf16le").toString("base64");
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc];
}

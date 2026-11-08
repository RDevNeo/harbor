# Harbor patches: your own buttons and panels

A patch adds buttons over the composer and panels beside the chat, for the chats in a folder.
Harbor writes this file to `~/.harbor/patches/README.md`; it isn't a patch itself.

## Where

- `<folder>/.harbor/patches/<name>.ts` (or `.js`, `.mjs`): for chats in that folder or below it
  (a chat in a worktree gets the worktree's own `.harbor/patches/`, and its project's).
- `~/.harbor/patches/<name>.ts`: for every chat on this PC.

Harbor picks a new or changed file up within about two seconds, with no restart.

## Trust

A patch is code that runs inside Harbor, so it runs only after the user trusts it. Until then a
"patch to trust" chip shows over the composer; its menu opens the file and trusts it. Trust is for
that exact content: any edit asks again. A patch can import only Node's and Bun's own modules
(`node:fs`, `bun`), never other files or packages, and can't `import()` or `require()` by a name
worked out as it runs, so trusting the file covers everything it runs. Agents: after writing or
changing a patch, tell the user to trust it with the chip over the composer.

## Format

```ts
// .harbor/patches/dev.ts
export default {
  icon: "flask",                     // optional: a Harbor icon name, for its buttons and panels
  actions: [
    { title: "Run tests", run: "bun test" },                     // a command, in a terminal pane
    { title: "Explain the schema", prompt: "Read db/schema.ts and explain it." }, // sends this message
    { title: "Dashboard", url: "https://example.com/dashboard" }, // opens the page
  ],
  panels: [
    { title: "App", url: "http://localhost:3000" },              // a page in Harbor's browser
    {
      title: "Worktrees",                                         // a list, drawn by Harbor
      items: async ({ sh }) =>
        (await sh("git worktree list")).split("\n").filter(Boolean)
          .map((line) => ({ title: line.split(/\s+/)[0], detail: line })),
    },
  ],
};
```

- An action has a `title` and exactly one of:
  - `run`: a shell command, run with `bash -lc` in the chat's folder, in a terminal pane at the
    bottom of the window, which stays open after it ends;
  - `prompt`: a message sent to the chat's agent, as if the user typed it;
  - `url`: an `http(s)` page, opened in the user's browser; nothing goes into the chat. Use it
    rather than `run: "xdg-open …"`. These are the buttons the phone app shows too.
- A panel has a `title` and either:
  - `url`: a page shown in Harbor's own browser, in the right-hand pane (`localhost:3000` works);
  - `items({ cwd, root, sh })`: returns (or resolves to) rows `{ title, detail?, section?,
    trailing?, url? }`, at most 500. `cwd` is the chat's folder, `root` the folder holding the
    patch's `.harbor/`, and `sh(command)` runs a command in `root` and resolves with its output (it
    rejects on a non-zero exit). Rows with a `section` are grouped under it; a row with a `url`
    opens it when clicked. A panel's refresh button calls `items` again. 10 s at most.
- Panels also get a button over the composer, which opens them.
- Keep titles short (they're buttons). `note` on a panel is shown under its title.

A patch that fails to load, or isn't shaped like this, shows why in a notice and in its chip's
menu; the version before it stays until it's fixed.

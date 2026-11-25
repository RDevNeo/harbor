# Hub's design system

One look for Hub's three tabs (Projects, Persons, Routine) on the PC (Slint) and on Android (Java views). Each tab
stays its own "app" with its own data and screens. They share the frame, the tokens and the components, so a
sidebar, a row, a header, a card, a button or a dialog reads the same in every tab.

**Reference look: Projects.** Projects' sidebar and chat were the most finished UI. Persons and Routine take its
metrics, and the shared parts were extended only where they needed more (avatars, presence, unread pills, chips).

| Where | Desktop (Slint) | Android |
| --- | --- | --- |
| Colours | `ts/packages/ui/slint/theme.slint` (generated from `src/theme.ts`) | `Ui.java` palette (`theme()`) |
| Sizes, type, states | `slint/ds-tokens.slint` (`Ds`) | `Ds.java` (constants) |
| Base widgets | `slint/widgets.slint` (Btn, Input, SearchField, PopoverFrame, MenuItem, Badge, Card, Empty, Toggle…) | `Ui.java` (text, icon, button, input, card, cardRow, listRow…) |
| List parts | `slint/ds-list.slint` | `Ds.java` |
| Surfaces, controls | `slint/ds-surface.slint` | `Ds.java` |
| One import | `slint/ds.slint` re-exports all of the above | `Ds` + `Ui` |

A tab's own file builds its pages from these and doesn't draw its own row, section head, dialog, menu, chip or toast.
A new shared need goes into `ds-*.slint` / `Ds.java` first and is then used by the tab.

## Audit: what each tab used before

| Block | Projects (reference) | Persons (before) | Routine (before) | Unified |
| --- | --- | --- | --- | --- |
| Tab switcher | in the sidebar's header (icons); since fork's 81cf8de5 a labelled tab row across the window | TabFrame's top row (labelled) | TabFrame's top row | **The window's tab row** (`tabs.slint` AppTabs, 46px), the same in every tab |
| Sidebar frame | bg200, 1px border, 11/13px padding, 256px | bg200, right hairline, 264px | none: sections as pills over the page | **SideSurface** + **SideHead**, 256px (`Ds.side-w`), in all three tabs |
| Sidebar header row | hide, tabs, refresh, search (28px ghost icon buttons) | none | none | **SideHead**: hide on the left (every tab; Ctrl+B), the tab's ghost icon buttons on the right |
| Section head | "PROJECTS": 11px/500, 0.6 spacing, gray-800, 18px | "STORES": 11px/600, 0.4 spacing, subtle, chevron, dot, blue pill, + | none | **SectionHead**: Projects' caps; optional fold chevron, status dot, blue count pill, + (a 22px ghost Btn); a folding head is one click / hover target across the row (pointer, accent fill) except its + |
| List row | ProjectRow / ThreadRow: 32 (34 head, 46 two-line), radius 6, accent on hover and selected, chevron 0..22, 16px lead at 22 (8 unfolded), title 14px at 46 (32), meta 12.5px gray-800 | PersonRow 30/38/52, gray-100 hover, 13px titles, 10.5px meta, avatars 22–36 | section pills 40px, radius 8 | **ListRow** on Projects' metrics: avatars 22 (one line) / 28 (two lines), second line 11.5px, unread CountPill and meta on the right, marks (channel, crown…) after the title |
| Lead mark | 16px letter square (radius 4, gray-300/400) or the project's picture | store picture 20px (radius 5) or a 9px colour dot | glyphs 16px | **LeadLetter** (picture, else letter on gray, or on a store's colour), **Avatar** (photo / initials, presence), a glyph, or a dot |
| Fold | chevron 12px gray-800 at x 5, hover fg | chevron 11–12px in-line | n/a | the same chevron in ListRow and SectionHead |
| Settled fold | "Settled (N)", hairline to the edge, chevron up/down | "› Settled (N)" 11.5px | n/a | **FoldBar** (Projects') |
| Counts / badges | gray mono numbers, StatusView words | Pill 16px (ink or blue) | n/a | **CountPill** (ink: unread on a row; blue: a section's total), meta numbers 12.5px gray-800 |
| Status dots | 6px amber / blue (LeadMark) | 7px Discord colours | n/a | **StatusDot**, tones via `Ds.tone()` / `Ds.tone-dot()` (green, amber, red, blue, muted) |
| Page header bar | chat TopBar 46px, hairline | chat header 56px (36px avatar) | none | **PageBar** 46px + 1px line, the one header of every page (Projects' TopBar is built on it): padding 18/10, 8 top and bottom, ShowSideBtn first while the sidebar is hidden, breadcrumb `icon section / title sub` at 14px; a person's chat: 28px avatar, 14px name |
| Page title | Settings 24px | "All people" 18px/600 | Title 24px/700 | **PageHead** 20px/600, −0.4 spacing, sub 13px subtle, actions on the right |
| Detail panel | team panel (now a floating card) | Panel 340px, top bar 44px, sections 11px caps | n/a | **PanelSurface** 340px, 46px top bar (in line with PageBar), **PanelSection** (caps title + small ghost action) |
| Cards | `Card` (bg100, border, radius 8) | upload cards radius 6 | `Card` | `Card`; thumbnails radius 6 |
| Buttons | `Btn` (primary, outline, ghost, ghost-muted, destructive; normal/sm/xs/icon sizes) | `Btn` + a custom + square | `Btn` + IconBtn (round 32) | **Btn** everywhere; icon buttons are `Btn` icon-xs/icon-sm ghost-muted (radius 6) |
| Chips | n/a | f-chips 26px blue when on; account chip 26px gray-100 | Chip 32px (gray-1000 when on), segment pills 30px | **Chip** 32px (sm 26px), gray-200 → primary fill when on, red when danger |
| Inputs | `Input` 36px, `SearchField` | `Input`, `SearchField` in a framed box, custom notes box | `Input` | `Input`, `SearchField`, **TextBox** (multi-line, same frame), **Field** (label + input), **FieldLabel** |
| Composer | Composer (radius 12) | own composer (radius 10) | Coach input row | Persons keeps its own (AI toggle, attach, subject) on the radius-xl frame |
| Menus | PopoverFrame + MenuItem / MenuLabel / MenuSeparator | own Menu (gray-100 in dark, 30/40px rows) | n/a | **MenuPanel** + MenuItem (now with `danger`) / MenuLabel / MenuSeparator; channel marks in the icon's place |
| Dialogs | app.slint: scrim, radius 12, 25px padding, 20px title, × in the corner, Cancel + primary | own Dialog (16px title, 20px padding) | Sheet (radius 14, 17px title, round close) | **DialogFrame** (app.slint's) + **DialogActions** |
| Toast | PopoverFrame over the bottom edge, 14px, xs Btn | an inverted dark pill | n/a | **Toast** (Projects') |
| Empty states | `Empty` (40px tile, 16px title, desc, primary action) | a centred line | Muted text in a card | `Empty` for empty lists; **Hint** / **Muted** for one-line notes |
| Spinner | `Spinner` | `Spinner` | "Loading…" text | `Spinner` |

## Tokens (`Ds`, `ds-tokens.slint`)

- **Spacing**: 2, 4, 6, 8, 10, 12, 16, 20, 24 (`sp1`…`sp9`).
- **Radii**: 4 tags and small marks, 6 rows and buttons (`radius-md`), 8 cards and popovers (`radius-lg`), 12 dialogs
  and the composer (`radius-xl`); pills are height / 2.
- **Type**: 11 caps heads (500, 0.6px spacing, gray-800) · 11.5 a row's second line · 12.5 a row's meta · 13 notes
  and descriptions · 14 body (row titles, buttons, inputs) · 15 card titles · 20 page and dialog titles (600, −0.4) ·
  24 big numbers. Fonts: Geist, Geist Mono for numbers that line up, Lucide for icons.
- **Icons**: 12 (row marks), 14 (row and menu glyphs), 16 (buttons), 24 (empty states).
- **Rows**: 32 one line, 34 head row, 46 two lines. Lead column: chevron 0..22, lead mark at 22 (8 without a fold),
  title at 46 (32). Indent 16px per level.
- **Frames**: sidebar 256px (Persons and Routine take Projects' resizable width, so the header's buttons line up),
  padding 11 (13 at the top), header row 28, first row 7px under it (`side-list-top`); page bar 46; detail panel 340; a page's column
  at most 680px with 24px sides.
- **States**: hover = selected = `Theme.accent` on rows; pressed toggles use `Btn.pressed`; disabled is 50% opacity.
- **Tones**: `Ds.tone(t)` (text) and `Ds.tone-dot(t)` (dots) for green / amber (yellow) / red / blue / muted, from
  Theme's scales. Presence keeps Discord's own colours (online, idle, dnd, offline).

## Layout rules (every tab)

1. The window's tab row on top (Projects | Persons | Routine), from `tabs.slint`.
2. Under it a **sidebar** (SideSurface, 256px) on the left: the SideHead row (28px: hide-sidebar on the left, the
   tab's ghost icon buttons on the right), then the tab's list: SectionHeads, ListRows, FoldBars. Every tab's sidebar
   hides with that button or Ctrl+B (the `toggle_sidebar` binding) and comes back from **ShowSideBtn** at the page's
   top-left (in the PageBar, or before the PageHead). Each tab keeps its own state: Projects' `sidebar-open`,
   `PersonsBus.side-hidden`, `RoutineBus.side-hidden` (shell.ts `tabSidebarKey` routes Ctrl+B to the tab on screen).
3. The **page** on the right, always under a **PageBar** (46px + line; same height, baseline and show-sidebar spot in
   every tab): a chat or a person ("hub / chat", the person), All people ("Persons / All people  68 people"), Routine's
   screens ("Routine / Today"). A screen's column may still open with a PageHead.
4. An optional **detail panel** (PanelSurface, 340px) on the far right, its top bar in line with the PageBar.
5. Overlays: MenuPanel at the pointer, DialogFrame over a scrim, Toast over the bottom edge.

Per tab:

- **Projects**: sidebar = projects (head rows with chevron and letter square) and their chats (two-line rows on a
  guide line), Threads, Settled; page = the chat; team = the corner badge's floating card.
- **Persons**: sidebar = All people, then STORES / CREATORS / SPOKPAY sections (stores as head rows with their
  picture or colour square, people as avatar rows with channel mark, status line, time and unread), Settled folds;
  page = All people (PageHead, search, rows) or a person's chat (PageBar); panel = the person's details.
- **Routine**: sidebar = Today (with its %), History, Sleep, Goals, Coach as glyph rows, then PLAN (the current plan,
  Import); page = the screen's column (PageHead, Cards, Chips); the goal form, plans, wake times and import are
  DialogFrames.

## Scrolling (every tab)

One scrollbar everywhere: a thin thumb over the content's right edge (4px, 6px under the pointer, radius = half its
width, `Theme.fg` at 22–42%), no track and no arrows. It shows while the content scrolls and about a second after, or
while the pointer is on the right edge, where it can be dragged (a click beside it jumps there). Shared in
`widgets.slint` (re-exported by `ds.slint`):

- **Scroll**: a scrolling page or list, in place of std-widgets' `ScrollView` (same `content-*`, `visible-*`,
  `scrolled`; its own bars off, the thumb over it). Persons (sidebar, All people, chat, panel), Settings, PRs, the PR
  page, the palette, Add project.
- **ScrollThumb**: the thumb alone, laid over a `Flickable` or a `ListView` (bars off) that a page drives itself:
  Projects' chat and sidebar, Routine's screens and Coach, a PR's code (a ListView: only the rows on screen exist).

No tab imports `ScrollView` or shows a stock scrollbar. Small strips (chips, the composer's field, popover lists) keep
a bare `Flickable` with no thumb.

## Text input (every tab)

Tabs never handle printable keys themselves. Every text field is a shared one: `Input` and `SearchField` (one line,
Enter is their `accepted`), `TextBox` (notes: Enter is a new line), `ComposeField` (a composer's field, Persons' and
Routine's Coach: **Enter sends, Shift+Enter is a new line**, Esc asks the composer; Projects' composer keeps its own
field on the same rule through shell.ts `composerKey`). What a key does before the text input sees it is decided once,
in `logic/keys.ts` `textKey` (unit tested), reached from Slint through the `TextKeys` global (widgets.slint) that
shell.ts binds:

- **AltGr as Ctrl+Alt** (Brazilian ABNT2: Ctrl+Alt+Q = `/`, Ctrl+Alt+W = `?`): the window's capture (app.slint) has
  it typed again without Ctrl into whatever field has the focus, in every tab; Ctrl+Alt+letter or digit stays a shortcut.
- **Space** and every other printable key always go to the focused field: no tab, row or page binds them.
- A tab's FocusScope may take Escape (close a menu or dialog) and shortcuts with Ctrl or Alt, never a printable key.

## Android (`Ds.java`)

The phone keeps its own scale (dp, larger touch targets, the serif page titles). It shares the same components:

- `Ds.pageTitle` — a tab's title ("Hub", "Persons", "Routine"): serif bold 26sp.
- `Ds.sectionHead` — "PROJECTS", "CREATORS": 11.5sp semi-bold G600, 0.06em spacing, with an optional fold chevron,
  unread pill and +.
- `Ds.row` / `Ds.inset` — a side-panel row: min 44dp, 12dp radius press fill, G100 when selected, 8dp in from the edges.
- `Ds.letter` — the project / store letter square (20dp, radius 5).
- `Ds.chevron` — the fold chevron (14dp, G600).
- `Ds.foldBar` — "Settled (N)", the hairline and the chevron.
- `Ds.pill` — unread / count pill (ink or blue).
- `Ds.chip` — a pill choice or quick action (INK when on).
- `Ds.card` — a content card (CARD fill, LINE border, 16dp radius, 14/12dp padding).

Used by Projects' drawer (Sidebar.java), Persons (PersonsHome, PersonsUi, PersonsPanel) and Routine (Routine.java).

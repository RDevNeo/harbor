# Hub's design system

One look for Hub's tabs (Projects, Persons, Routine, Collector) on the PC (Slint) and on Android (Java views). Each tab
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
- **Collector**: sidebar = the four views as glyph rows (Collector with "running" while a run goes, Available,
  Approved and Restricted with their counts; the lists' bar: the filter SearchField full width, then 34px framed Sort
  and platform menu buttons, MenuItems and PlatRows with the tick on the left, brand mark, count); page = PageBar ("Collector / Collect leads", "Collector / Available  6 leads" with
  Copy JSONL on the right), then a column: on Collector the form Card (platform Chips, Instagram's "· needs sign-in"
  and, when picked, the session Well; search Input, Leads with −/+, Collect/Stop, Last upload Chips), one line under
  it while a run goes (Spinner + "3 of 20 · Checking @x…", or how it ended), then the run's leads; on Available and
  Restricted one framed SearchField, then the leads. A lead is a bordered card (radius 8): 44px Avatar, name, platform
  Tag, handle, the short profile link, the email with its source (or "Add email", which turns into an Input with Save /
  Cancel), the 3 newest videos as 64×48 thumbnails (a click opens one, the title is its tip), Restrict / Unrestrict and
  Send (ghost-muted sm Btns); a lead with a Reach shows its icon after the handle (24px, the brand's mark on its tint).
  A click elsewhere on a card opens the lead's detail: the SpokPay CRM's creator profile dialog on Hub's tokens (720
  wide, radius 12, a scrolling body, a fixed footer with Open channel / Edit; tiles and rows on `fg` at 3.5%, caps heads
  at 35%), Edit a DialogFrame (512); on the phone a full-screen profile (CollectorCreator.Detail): the top bar (back,
  the name, "3 of 121", previous / next), the 88dp picture, name, platform · handle, tags, the stat tiles, Send
  message and Open channel, chips (Edit profile, Approve to Persons › Creators, Restrict, Copy link), then cards:
  Recent videos, Bio, Contact (the email and its source, a pencil to type one; Reach), Links, Note; the review bar
  under it. Under the footer's row (Quick note Input, the
  "Approve to: …" trigger and its menu above it, Open channel / Edit) the review bar: three equal 56px cells with
  hairlines, Reject (red-900) / Skip (fg 60%) / Approve (green-900), icon + 15px/500 label + 16px outlined key caps,
  the cell tinted 8% on hover; keys R S A, ← ↓ →, N (the note) only while no field has the focus. Send message is a DialogFrame (760): templates on the left, channel Chips, To, Subject, a
  TextBox, the CRM's guard lines; Send… turns it into a 448 confirm ("Send it?") with Back / Send now. Phone: the title,
  three Chips (Collector, Available n, Restricted n), the same cards in one scrolling column (an email dialog), Send
  message as a screen over the tab.

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

The phone keeps its own scale (dp, larger touch targets). Every tab has the same frame (Headquarters' phone shell is
the model: a slim top bar with the sidebar button, a sheet from the left, the tab bar always under the page):

- **Top bar** (`Ds.TopBar`, `Base.frame`): 52dp + hairline on every page of every tab, chats too. Far left the
  side-panel button (`Ds.sideButton`, Lucide panel-left, 40dp round press; a sub-page such as Settings, Search or a
  person's Details has `Ds.backButton` there instead), then the page's name (16sp semi-bold, an optional 12sp line
  under it; a person's chat puts their 32dp avatar before it), the page's actions on the right (`Ds.barButton`,
  20dp glyphs). No big serif tab titles: the tab bar says which tab, the top bar which page. Projects' first page
  is "Projects" (a tap on the title picks the workspaces shown; Add project, Search); a Projects chat's
  title opens its menu (Rename, Settle, Copy link, Delete…); its team is a swipe to the left (no team or menu
  buttons on the phone).
- **Drawer** (`Base.installTab`, `Ds.drawer`, `Ds.drawerHead`, `Ds.drawerWidth`): the tab's side list sliding in
  from the left over the page and the tab bar (84% of the width, at most 340dp), as Headquarters' sheet: on the page's
  own black (BG, not a lighter slab), a hairline down its right edge and no shadow, the page beside it faded under an
  80% black scrim. Its head (`Ds.drawerHead`) is the same in every tab: the tab's name in the top bar's title style
  (16sp semi-bold) at the rows' glyph column (20dp), 52dp tall with the top bar's hairline under it, the tab's
  buttons on the right. Opened by the top bar's button or a swipe right anywhere (not on something that scrolls
  sideways), closed by a swipe left, the scrim or Back; picking a row closes it. Page rows are `Ds.navRow` in every
  tab (18dp glyph, 15sp label, quiet count; G200 on the page shown). Projects: "Projects" (workspaces, Add project,
  Search), then Projects, Settings, Workspaces & PCs and the chat list (Sidebar), New session at the bottom (no
  avatar, no theme button: the phone is always black). Persons: "Persons" (its magnifier opens All people), then
  Stores, Creators, SpokPay, Personal (PersonsHome; no All people row, no connection chips: only a sign-in waiting
  for its QR code shows). Routine: Today, History, Sleep, Goals, Coach. Collector: Collector, Available, Approved,
  Restricted with their counts.
- **Tab bar** (`Tabs.around`): Projects, Persons, Routine, Collector, on every page including chats; it steps aside
  only while the keyboard is up. Every tab carries a count on its icon's corner (`Ds.pill`), as WhatsApp's and the PC's tab
  row (same routes): Projects the chats that need you, Persons everyone's unread messages, Routine today's goals still
  to do (`v1/routine/pending`), Collector its finished runs not looked at; read on each screen, on the PC's state
  changes and every 5 s while Hub is in front. Tapping a tab brings back the page it showed (Projects: the chat, else the
  workspace; never Hub's start screen, which is the drawer's Workspaces & PCs).

Components:

- `Ds.pageTitle` — kept for older callers; no tab draws a big title any more.
- `Ds.sectionHead` — "PROJECTS", "CREATORS": 11.5sp semi-bold G600, 0.06em spacing, with an optional fold chevron,
  unread pill and +.
- `Ds.row` / `Ds.inset` — a side-panel row: min 44dp, 12dp radius press fill, G100 when selected, 8dp in from the edges.
- `Ds.letter` — the project / store letter square (20dp, radius 5).
- `Ds.chevron` — the fold chevron (14dp, G600).
- `Ds.foldBar` — "Settled (N)", the hairline and the chevron.
- `Ds.pill` — unread / count pill (ink or blue).
- `Ds.chip` — a pill choice or quick action (INK when on).
- `Ds.card` — a content card (CARD fill, LINE border, 16dp radius, 14/12dp padding).

- `Thumbs` — pictures in long lists (Collector's leads): only for rows on screen (a recycled row drops the request
  it no longer shows), the newest request first, decoded and centre-cropped to the size drawn, cached in memory and
  in the app's cache folder. Lists of many cards are `ListView`s with a holder per row, PAGE (40) at a time with
  "Show more"; no video plays in a list (thumbnails only).

Used by Projects (Chats, Chat, Sidebar.java), Persons (PersonsHome, PersonsList, PersonsChat, PersonsSr, PersonsPanel),
Routine (Routine.java) and Collector (Collector.java).

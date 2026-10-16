# Design direction

Status update (2026-10-16): M7.5 is implemented as recorded below. M8 adds the
separate transfer workflow described in [the transfer guide](ADO-EXPORT.md).
Empty labels must occupy a readable full-width region; notification header and
content widths must align; destructive destination selects need a visible labelled
field. Board lists need an ample trailing card-drop target. Bucket grouping gains
permission-checked top-bar dragging, keyboard reorder and Add bucket, sharing state
with Settings. User search uses one labelled picker with Search/Enter and a result
dropdown, retaining selected chips when multiple people may be chosen.

ADO transfer is a separate lazy project interface, preserving the existing
Excel/offline Export dialog. Its preview distinguishes selected items, added parents,
creates, updates, pending links, conflicts and omitted data. Incoming changes and
ID reconciliation are PM-only. Per-project mappings avoid assuming one ADO process.
Use the existing tokens, Material/CDK, keyboard/focus and responsive rules below.

The owner approved this design direction on 2026-10-13. Milestone M4.5 implements it, M6 theming builds on its
tokens, and M6.5 polishes every screen against it. SPEC.md stays the source of truth: if this document and the
spec ever disagree, the spec wins and this document is corrected.

The approved mockups are on the owner's design canvas (the link is kept outside the repository). Its three artboards are the design direction
(tokens, signals, labels, fonts, feedback), the board and the item drawer, each in light and dark. Values in this
document win over the canvas where they differ; the differences are listed at the end.

**Calm canvas, vivid signals.** Quiet slate surfaces and one indigo primary colour keep the chrome out of the way.
Colour is spent only where it carries meaning: labels, item types, status, priority and anything overdue.

## 1. Principles

1. **Content first.** Quiet chrome, generous whitespace, one primary colour. The work is the loudest thing on screen.
2. **Colour means something.** Labels, types, status, priority and overdue dates carry colour; nothing else does.
   Every colour signal is paired with an icon or a word, so it still reads in grayscale and for colour-blind users.
3. **Edit where you look.** Click a value to change it. Fewer forms, fewer Save buttons, every change undoable.
4. **Instant and honest.** Changes appear at once; the server answer confirms or rolls back, with a clear reason.
5. **Kind to everyone.** Keyboard first, visible focus, WCAG 2.2 AA contrast, reduced motion, works at phone width.

## 2. Tokens

All visual values are CSS custom properties on `:root`, prefixed `--k-`. Components use tokens only and never name
a colour, size or shadow directly (SPEC §6: theming uses CSS custom properties only; SPEC §11: no hard-coded brand
colours). Dark mode redefines the colour tokens under `[data-theme='dark']`; the user's mode setting (M6) sets that
attribute, and "use default" follows the admin default.

### 2.1 Colour

| Token                       | Light                 | Dark                  | Use                                           |
| --------------------------- | --------------------- | --------------------- | --------------------------------------------- |
| `--k-ground`                | `#F6F7F9`             | `#0E1117`             | Page background                               |
| `--k-sidebar`               | `#FBFBFC`             | `#0B0E13`             | App sidebar                                   |
| `--k-surface`               | `#FFFFFF`             | `#161B24`             | Cards, drawer, menus, dialogs                 |
| `--k-sunken`                | `#EDEFF3`             | `#121720`             | Board columns, skeletons, segmented controls  |
| `--k-border`                | `#E3E6EC`             | `#252C38`             | Hairlines and card edges                      |
| `--k-border-strong`         | `#CBD2DC`             | `#3A4456`             | Dividers, dashed drop targets, drag handles   |
| `--k-control-border`        | `#7E889A`             | `#6B7588`             | Input and checkbox outlines (3:1 on surface)  |
| `--k-text`                  | `#111827`             | `#E6E9EF`             | Body text                                     |
| `--k-text-2`                | `#3F4756`             | `#C3CAD6`             | Secondary text                                |
| `--k-muted`                 | `#5B6474`             | `#9AA4B5`             | Captions, metadata, placeholders              |
| `--k-primary`               | `#4F46E5`             | `#8B93FF`             | Primary buttons, selection, focus ring, links |
| `--k-on-primary`            | `#FFFFFF`             | `#0E1117`             | Text on `--k-primary`                         |
| `--k-primary-soft`          | `#EEF0FF`             | `#1D2040`             | Selected rows, active chips, current project  |
| `--k-primary-line`          | `#A5B4FC`             | `#4B52A8`             | Borders of active chips and drop slots        |
| `--k-primary-ink`           | `#3730A3`             | `#C7CBFF`             | Text on `--k-primary-soft`                    |
| `--k-accent`                | = primary             | = primary             | Small highlights: unread badge, active sprint |
| `--k-warn-soft` / `-ink`    | `#FFF1E6` / `#A14A08` | `#3A2410` / `#FDBA74` | Blocked, due soon                             |
| `--k-danger-soft` / `-ink`  | `#FDECEC` / `#B91C1C` | `#3A1517` / `#FCA5A5` | Overdue, destructive actions, errors          |
| `--k-success-soft` / `-ink` | `#E6F6EC` / `#166D3B` | `#13291C` / `#86EFAC` | Done, completed checklists                    |
| `--k-toast`                 | `#1F2430`             | `#2A3140`             | Toast background (text `#F3F4F6`)             |
| `--k-toast-action`          | `#A5B4FC`             | `#A5B4FC`             | Undo and other toast actions                  |
| `--k-scrim`                 | `rgba(17,24,39,.32)`  | `rgba(5,7,10,.55)`    | Behind the drawer and dialogs                 |

SPEC §6 themes have a primary and an accent colour. The canvas uses a single indigo; it is the primary, and the
accent defaults to the same value so the default look is unchanged. Admin and user themes (M6) override
`--k-primary` and `--k-accent`; the soft, line and ink variants are derived from them so contrast still holds.

### 2.2 Type scale

The UI font is the admin's choice (section 6), Figtree by default, exposed as `--k-font`. Item keys (`KLO-142`)
use `--k-font-mono`, JetBrains Mono, bundled, so keys line up.

| Token         | Size / line height | Weight | Use                                    |
| ------------- | ------------------ | ------ | -------------------------------------- |
| `--k-display` | 28 / 1.2           | 700    | Rare page titles                       |
| `--k-h1`      | 22–24 / 1.25       | 700    | Page header, drawer title              |
| `--k-title`   | 20 / 1.3           | 600    | Dialog and section titles              |
| `--k-body`    | 14 / 1.5           | 400    | Default text, card titles (weight 500) |
| `--k-body-sm` | 13 / 1.45          | 400    | Field values, menus, toasts            |
| `--k-small`   | 12 / 1.4           | 500    | Metadata, captions, pills              |
| `--k-mono`    | 11.5–12 / 1.4      | 500    | Item keys                              |

Headings use a slight negative letter spacing (−0.01em). Text sizes are set in `rem` so browser zoom and the
user's base font size apply.

### 2.3 Spacing

A 4 px grid: `--k-space-1` 4, `-2` 8, `-3` 12, `-4` 16, `-6` 24, `-8` 32 px. Cards use 12 px padding and 8–9 px
between rows; columns 10 px padding with 10 px between cards and 16 px between columns; the page gutter is 24 px
(16 px at phone width).

### 2.4 Radii

| Token             | Value  | Use                                      |
| ----------------- | ------ | ---------------------------------------- |
| `--k-radius-sm`   | 6 px   | Type icon tiles, key badges, kbd         |
| `--k-radius-md`   | 10 px  | Cards, inputs, buttons (8 px), toasts    |
| `--k-radius-lg`   | 14 px  | Board columns, popovers (12 px), dialogs |
| `--k-radius-full` | 999 px | Pills, labels, avatars                   |

### 2.5 Elevation

Three levels, used sparingly: cards rest, menus float, dragged cards lift.

| Token       | Light                                                        | Dark                          |
| ----------- | ------------------------------------------------------------ | ----------------------------- |
| `--k-rest`  | `0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.08)` | `0 1px 2px rgba(0,0,0,.4)`    |
| `--k-float` | `0 8px 24px rgba(16,24,40,.12)`                              | `0 12px 28px rgba(0,0,0,.5)`  |
| `--k-lift`  | `0 18px 36px rgba(16,24,40,.22)`                             | `0 18px 36px rgba(0,0,0,.55)` |

The drawer uses `-24px 0 48px rgba(16,24,40,.18)` over `--k-scrim`. A dragged card lifts (`--k-lift`, a 2° tilt
and `--k-border-strong`); its drop position is a dashed `--k-primary-line` slot on `--k-primary-soft`.

## 3. Semantic colours

Each signal pairs colour with an icon or text. Icons are 24-unit stroke SVGs (section 5).

### 3.1 Item types

Shown as a stroke icon in a 20–24 px tile of the type's soft colour.

| Type       | Icon           | Light colour / tile   | Dark colour / tile    |
| ---------- | -------------- | --------------------- | --------------------- |
| Epic       | Lightning bolt | `#7C3AED` / `#F3EEFF` | `#A78BFA` / `#2A1F45` |
| Feature    | Stacked layers | `#2563EB` / `#EAF1FF` | `#60A5FA` / `#17243F` |
| User Story | Bookmark       | `#15803D` / `#E8F7EE` | `#4ADE80` / `#13291C` |
| Task       | Checked square | `#0E7490` / `#E7F6FA` | `#22D3EE` / `#10262D` |
| Bug        | Bug            | `#DC2626` / `#FDECEC` | `#F87171` / `#341618` |

### 3.2 Status

Pills with an icon and the status name.

| Status      | Icon                    | Light fill / text     | Dark fill / text      |
| ----------- | ----------------------- | --------------------- | --------------------- |
| Not started | Empty circle            | `#EEF0F4` / `#3F4756` | `#252C38` / `#C3CAD6` |
| In progress | Circle with clock hands | `#E6EEFF` / `#1D4ED8` | `#17243F` / `#93C5FD` |
| Blocked     | Circle with a bar       | warn soft / warn ink  | warn soft / warn ink  |
| Done        | Circle with a tick      | success soft / ink    | success soft / ink    |

### 3.3 Priority

Four rising bars; the number of coloured bars is the priority, the rest use `--k-border-strong`. Always with an
accessible name ("Priority 2, high") and, in the drawer, the text.

| Priority    | Bars | Colour    |
| ----------- | ---- | --------- |
| 1 · Highest | 4    | `#DC2626` |
| 2 · High    | 3    | `#EA580C` |
| 3 · Medium  | 2    | `#2563EB` |
| 4 · Low     | 1    | `#6B7280` |

### 3.4 Due dates

- **Overdue** (due before today and not Done, as decided in M4): calendar icon and text such as "2 days overdue"
  on danger soft / danger ink.
- **Due soon** (today to 3 days ahead): "due in 3 days" on warn soft / warn ink.
- Otherwise the date in `--k-muted` on `--k-sunken`.
- Blocked cards (an open "blocked by" dependency) show a "Blocked" pill in warn colours.

## 4. Labels

Labels are per project, named and coloured, managed by PMs and Leads (SPEC §3.2).

### 4.1 Palette

A curated palette of twelve plus a custom colour picker (any hex):

| Red       | Orange    | Amber     | Lime      | Green     | Teal      |
| --------- | --------- | --------- | --------- | --------- | --------- |
| `#E5484D` | `#F76B15` | `#FFB224` | `#99D52A` | `#30A46C` | `#12A594` |

| Cyan      | Blue      | Indigo    | Violet    | Pink      | Slate     |
| --------- | --------- | --------- | --------- | --------- | --------- |
| `#05A2C2` | `#0090FF` | `#3E63DD` | `#8E4EC6` | `#C2378E` | `#6B7280` |

### 4.2 Styles

The label style is a per-project setting controlled by PMs (`Project.settings.labelStyle`, SPEC §4 and §6).

- **A · Tinted (`TINTED`)**: a soft fill of the label colour (14 % alpha in light, 24 % in dark) with text in a
  darker (light mode) or lighter (dark mode) shade of the same hue, plus a dot in the full colour. Calm; suits
  projects with many labels.
- **B · Solid (`SOLID`, default)**: full-colour fill with automatically chosen text and a translucent dot. The
  strongest cue at a glance.
- **C · Cover bar (`COVER`)**: tinted pills plus a 6 px bar in the first label's colour across the top of the card.

The style applies to cards, the drawer, the backlog and label pickers alike. Label pills are 20–24 px high, 11–12
px semibold text.

### 4.3 Automatic contrast rule

Label text is either `#111827` or `#FFFFFF`, whichever has the higher WCAG contrast ratio with the fill. If neither
reaches 4.5:1 (possible only for custom colours in a narrow mid-luminance band), the fill used for display is
darkened or lightened in small steps until the chosen text reaches 4.5:1; the stored colour is unchanged. Tinted
text shades are checked the same way against the tinted fill on `--k-surface`. The rule is one pure function shared
by every label rendering and unit-tested against the curated palette and edge colours.

With this rule, Amber, Lime, Orange, Green, Teal, Cyan, Blue and Red take dark text, and Indigo, Violet, Pink and
Slate take white text.

## 5. Icons

- One bundled set of inline SVG icons on a 24-unit grid, 2 px stroke, round caps and joins, `currentColor`, drawn
  at 13–18 px. The canvas icons are the reference; an open-source set with a compatible licence may supply the
  rest if its files are copied into the repository.
- No icon fonts and nothing loaded from external hosts at runtime (SPEC §5: no outbound calls; target servers may
  have no internet access). Icons are compiled into the web build.
- Decorative icons are `aria-hidden="true"`; icon-only buttons have an `aria-label`; meaningful icons (priority,
  type on its own) have `role="img"` and a name.

## 6. Fonts

One UI font for everyone, chosen by the admin under Branding (SPEC §6, M6); there is no per-user override. Item
keys always use the bundled JetBrains Mono.

| Preset                | Source                           | Font stack                                                                  |
| --------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| Figtree (default)     | Bundled                          | `Figtree, system-ui, -apple-system, 'Segoe UI', sans-serif`                 |
| Atkinson Hyperlegible | Bundled                          | `'Atkinson Hyperlegible', system-ui, -apple-system, 'Segoe UI', sans-serif` |
| IBM Plex Sans         | Bundled                          | `'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif`         |
| Georgia               | Installed on the user's computer | `Georgia, 'Times New Roman', Times, serif`                                  |
| Arial                 | Installed on the user's computer | `Arial, 'Helvetica Neue', Helvetica, 'Liberation Sans', sans-serif`         |

- Bundled fonts are open-source (SIL Open Font Licence) WOFF2 files with their licence texts, shipped in the web
  build and served by the app; `font-display: swap`. M4.5 bundles Figtree and JetBrains Mono; M6 adds the other
  two presets with the admin setting.
- **Upload rule (M6):** an admin may upload their own font instead of a preset: one regular file and an optional
  bold file, WOFF2 recommended, WOFF, TTF and OTF accepted. Files are checked by content (not only by extension),
  stored on the server outside the web root and served by the app itself from its own origin with
  `X-Content-Type-Options: nosniff`. The stack is `'<uploaded>', Figtree, system-ui, sans-serif`, so Figtree takes
  over if the file cannot be loaded. Missing bold is synthesized by the browser.

## 7. App shell

- **Sidebar** (232 px, `--k-sidebar`): the app logo and name from admin branding (M6; until then neutral
  placeholders, never a vendor name), then "My work", Notifications with an unread badge (M5), a **Projects**
  section that doubles as the project switcher (key badge plus name; the current project highlighted in primary
  soft), and the user menu at the bottom (avatar, name, role; opens settings, theme and sign out). Admins get the
  admin entries and the All/My projects toggle (SPEC §3.1). "My work" is the "all their work" list (section 9) for
  the signed-in user. At tablet width the sidebar collapses to icons; at phone width it becomes a menu button.
- **Header**: breadcrumb ("Projects / Demo project"), page title, search ("Search or jump to KLO-…", `/`) and the
  primary "New item" button.
- **Project tabs**: Board, Backlog, Sprints, Settings, with a 2 px primary underline on the current tab.
- **Board toolbar**: sprint chip (current sprint, primary soft), filter chips (dashed when empty: Assignee, Label,
  Type, Due), the quick person filter (overlapping avatars of project members), then "Group by" as a segmented
  control (Bucket, Status, Assignee, Sprint).

## 8. Board card anatomy

Top to bottom, inside a `--k-surface` card with `--k-border`, `--k-radius-md` and `--k-rest`:

1. Cover bar, 6 px, only with the `COVER` label style.
2. Meta row: type icon tile, item key in mono, optional "Blocked" pill, priority bars at the far right.
3. Title, 14 px medium, at most two lines.
4. Labels, wrapping.
5. Footer: due pill, checklist progress (`3/5` and a 34 px bar that turns success green when complete), assignee
   avatars at the far right, overlapping by 6 px.

Done cards dim the title to `--k-muted` at 80 % opacity. Columns are 288 px wide on `--k-sunken` with
`--k-radius-lg`; the column header holds a coloured dot, the bucket name, a count pill, "Add a card" and an
options menu; quick-add sits at the top of the column (SPEC §6) and "Add a card" at the bottom. Empty filtered
columns show a dashed note ("No cards for Mia Member here").

## 9. Assignee avatars

- Avatars show initials on a colour derived from the user id (stable across sessions; text meets 4.5:1), 24 px on
  cards, 30 px in the toolbar, 40 px in hover cards.
- **Hover card**: hovering or focusing an avatar opens, after a short delay, a card (`--k-float`, 264 px) with the
  avatar, name and email and two actions: **Filter board to this person** and **View all their work**. It stays
  open while the pointer or focus is inside it and closes on Esc. On touch, a tap opens it.
- **Filter board to this person**, and clicking an avatar in the toolbar, applies the quick person filter: the
  avatar gets a 2 px primary ring and `aria-pressed="true"`, the others fade to 45 %, a removable chip with the
  person's name appears, and only their cards stay on the board. Clicking again or removing the chip clears it.
  It combines with the other filters.
- **View all their work** lists that person's items across every project the viewer can open, each limited by the
  viewer's own access in that project (SPEC §6). M4.5 adds its API endpoint with permission tests.

## 10. Item drawer

- A 640 px drawer from the right (full width on phones) over `--k-scrim`, deep-linkable (SPEC §6). The board stays
  visible and loaded behind it.
- **Top bar**: ancestor breadcrumb (type icon, key, title; links when visible, plain titles otherwise, as decided
  in M4), then Copy link, More actions (delete and others) and Close (Esc).
- **Heading**: type tile with key and type, the title as a 24 px heading that becomes a text field on click, then
  two large pills: status (with its icon and colour) and bucket.
- **Fields**: a two-column list (116 px labels) of Assignees, Labels, Sprint (with dates and state), Priority,
  Dates (start → due, with a due-soon or overdue pill), Team, and Parent.
- **Inline editing**: every value is a button that opens an in-place editor (picker, menu, date picker or text
  field). Changes save immediately, show at once and offer Undo in a toast; there are no Save buttons except for
  the description and notes, which save with their Save button or Ctrl/Cmd+Enter and cancel on Esc (not on
  blur, which would also save when Cancel is clicked). Values the caller cannot
  change are plain text, not disabled buttons (the API decides; SPEC §3.4).
- **Sections**: Description (rich text; images can be pasted or dropped in, PNG, JPEG, GIF or WebP, shown inline
  at full drawer width, with a hint under the editor; M5 per SPEC §5 and §6), Checklist (progress count and bar,
  drag handles, checkboxes, "Add a line"), Dependencies ("Blocked by" rows in warn colours), Children, Attachments
  (M5), and Activity with All / Notes / History filters and the note composer ("type @ to mention someone, paste or
  drop an image"; M5).
- **Full-size image view** (M5): clicking or pressing Enter on an image in a description or note opens it at full
  size in a modal viewer over `--k-scrim`, scaled to fit the window (never above its natural size), with the
  image's alternative text as its name and a Close button. Esc, the Close button or a click on the backdrop closes
  it and returns focus to the image. When the description or note holds several images, the left and right arrow
  keys (and two arrow buttons) step through them. The viewer loads the same app-served image; it offers no
  download or link to another host.

## 11. Feedback

- **Toasts** (bottom left, `--k-toast`, `role="status"`): a short sentence of what happened ("KLO-14 moved to In
  Progress · status set to In progress") with an **Undo** action for reversible changes. They stay 6 s, longer
  while hovered or focused; Undo sends the inverse change. Errors use the same toast with the API's reason and no
  Undo; one toast at a time, the newest replacing the last.
- **Confirm dialogs** replace every browser `confirm()` / `alert()`: a titled dialog naming the thing and the
  consequence ("Delete KLO-4 and its 3 children?"), a destructive button in danger colours on the right and
  Cancel, which has initial focus. Focus is trapped and returns to the trigger.
- **Empty states**: a dashed box with a one-line title, one sentence of what to do next and, where the user may
  act, one primary button ("No sprints yet · Plan two weeks of work at a time · Create a sprint").
- **Skeletons**: loading lists and boards show `--k-sunken` shapes of the content they replace (card outlines,
  text bars, label pills) instead of spinners; no shimmer under reduced motion.
- **Optimistic changes**: moves and edits apply at once and roll back with an error toast if the API refuses.

## 12. Keyboard shortcuts

Single-key shortcuts work when focus is not in a text field. M4.5 keeps the existing ones (Esc closes the drawer);
the full set and a command palette arrive in M6.5 (SPEC §10).

| Key     | Action                     |
| ------- | -------------------------- |
| `C`     | Create an item             |
| `/`     | Search or jump to an item  |
| `J` `K` | Next / previous card       |
| `Enter` | Open the selected card     |
| `M`     | Move to bucket…            |
| `A`     | Assign…                    |
| `L`     | Add a label…               |
| `Esc`   | Close the drawer or a menu |

A `?` dialog lists them. Every drag-and-drop action also has a keyboard path (the menus above, and keyboard
ordering controls). The help dialog has an **Enable single-key shortcuts** switch, saved on this browser;
turning it off leaves the Search or jump and Keyboard shortcuts buttons available (WCAG 2.1.4).

## 13. Accessibility (WCAG 2.2 AA)

- Contrast: text 4.5:1 (3:1 at 24 px, or 18.66 px bold, and above); icons, control outlines and focus indicators
  3:1 against adjacent colours. The tokens above meet this in both modes; label text follows section 4.3.
- Focus: a visible 2 px `--k-primary` ring with 2 px offset on every focusable element (`:focus-visible`); focus
  is never hidden behind sticky headers or the drawer (2.4.11); the drawer and dialogs trap focus and restore it
  on close.
- Keyboard: everything reachable and operable by keyboard, in a logical order; no keyboard traps; dragging has
  a non-drag alternative (2.5.7).
- Targets: at least 24 × 24 px (2.5.8); primary controls 36–44 px.
- Semantics: real buttons and links, landmarks (`nav`, `main`, `aside`), headings per section, labelled form
  fields, `aria-pressed` on toggles, `aria-live` for toasts, names on icon-only buttons.
- Colour is never the only signal (section 3).
- Motion: transitions of 150–200 ms; `prefers-reduced-motion` removes drag tilts, slides and shimmer.
- Layout: works at 320 px width and 200 % zoom without horizontal page scrolling (the board scrolls inside its
  own area).

## 14. Differences from the canvas

The canvas is a mockup; where it and this document differ, this document holds:

- The canvas mockups load Figtree, Atkinson Hyperlegible, IBM Plex Sans and JetBrains Mono from a web font
  service so the mockups render; the app bundles them (section 6).
- The canvas picks label text with a simple luminance threshold, which puts white text on some bright colours
  below 4.5:1. The app uses the rule in 4.3, so Orange, Green, Teal, Cyan, Blue and Red labels get dark text.
- Pink is `#C2378E` (canvas `#D6409F`) and the Done and warning inks are `#166D3B` and `#A14A08` (canvas
  `#15803D` and `#B45309`), so their text reaches 4.5:1.
- The canvas's compact density switch was a design lever, not a v1 feature.
- The canvas names the app "Kloister" in the sidebar; the app shows the admin-set name and logo (SPEC §1, §6).

Where the first implementation (M4.5) does not yet match this document, the difference is recorded here and in
docs/DECISIONS.md:

- Cards show "Blocked" for items whose status is Blocked, not from an open "blocked by" dependency (section 3.4):
  list responses carry no dependencies.
- The quick person filter reuses the board's Assignee chip ("Assignee: Mia Member") plus "Clear filters" instead
  of a separate removable person chip (section 9).

M5 adds:

- The bell opens a notifications page rather than a dropdown, and at narrow widths a bell button with the count
  sits in the top bar (section 7).
- Editable descriptions and notes have Image and View images buttons next to the formatting buttons, so images can
  be added and viewed full size without a mouse (section 10).

M6 adds:

- Themes have a third mode, "Same as the device", which follows the operating system (the M4.5 behaviour) and is
  the default. A chosen primary or accent colour is shown as chosen only where it reaches the contrast in section 2.1;
  otherwise a darker (light mode) or lighter (dark mode) shade is shown, and the picker names it. The built-in indigo
  keeps the designed tokens above.
- The user menu's "Settings and theme" opens a settings page rather than a theme submenu (section 7).
- Admin settings are one page with tabs (Branding, Security, Storage, Backups, Logs) under the sidebar's Settings link.

M6.7 adds (SPEC §3.6, §6):

- The sidebar's project list starts with "Personal", the signed-in user's private personal space.
- My work gets a list view grouped by due date and a board view with the four statuses as columns; cards there show
  a project chip ("Personal" for personal tasks) and their bucket as a small tag.
- Both work views share source, project, type, label and due filters, created/Done switches and project grouping.
  Labels retain their project identity. A Material status select on editable work cards provides the keyboard
  alternative to dragging; the normal project endpoint applies the bucket rule. J/K focuses work links.
- Personal board, backlog, sprint and drawer screens reuse the existing project presentation. Assignment,
  member/team management, mentions and archiving controls are omitted. Settings retain buckets, labels and
  label style; personal tasks show `#number`. The owner is implicit, without membership or assignment rows.

M6.5 resolves and adds:

- The sidebar now collapses to a 72 px icon rail at 600–1023 px and becomes a menu below 600 px. Names remain
  available to screen readers; project keys are the rail's project markers. Search and shortcut help also have
  sidebar entry points, and the project header has Search or jump.
- The item drawer is a modal dialog with a CDK focus trap and focus return, replacing its earlier complementary
  landmark. Its **Board order** field and checklist up/down buttons are non-drag alternatives for ordering;
  bucket, status, sprint and assignee fields cover the other board drops. These controls use existing permission
  capabilities and endpoints. The canvas does not show the Board order field or checklist ordering buttons.
- Mentions now use a CDK overlay anchored to the caret, falling back above it near the viewport edge.
- Label rows have a fixed maximum width and aligned preview/actions; at phone width the preview occupies a
  second row so the name stays editable. Font samples wrap rather than shrinking text.
- Default-theme editing previews for its admin editor even with a personal theme, then restores their personal
  preference on save, cancel or leaving the tab. Theme swatches have one tab stop per group and wrap with arrows;
  the native custom-colour input is separately labelled.
- Search in the lazy command palette covers project names and screens, and exact project-item keys jump through
  the usual guarded routes. J/K moves actual focus through visible board cards; Enter uses the card link. Single
  characters are ignored in editors, during composition, and while an overlay is open, and can be disabled.
- Long boards retain variable-height cards and all keyboard links. Offscreen card painting is deferred with
  `content-visibility`; focused and dragged cards render fully. This preserves label wrapping and existing drag
  semantics without a fixed-height virtual list. A 1,000-card fixture records frame timings in the browser report.
- Done titles and unselected person-filter avatars keep full opacity so their text retains its AA contrast.
  The selected avatar's primary ring and the named Assignee chip carry the selection; this differs from the
  mockup's 80 % Done-title opacity and 45 % fade on the other avatars.
- Older list screens now use the shared empty/loading presentation. Wide tables scroll inside named keyboard
  regions, with hidden text contained there; sign-in and password screens have real headings. Dialog entry and
  exit use the motion token; reduced motion removes transitions, animations and drag tilt.
- Drawer details, settings presentation and command-dialog styles load with their lazy screens to keep the
  unchanged initial bundle budget. These changes resolve the deferred tablet rail, drawer focus trap and
  caret-mention differences above; the blocked-status and person-chip differences remain.

M6.8 adds (SPEC §6.1–6.3), without changing the approved artboards:

- Card and drawer actions add an overlapping-squares icon with a **Duplicate item** tooltip on hover/focus
  and the same accessible name. A dialog offers one copy per selected person or a copy
  count with optional assignments, previews the resulting titles and assignees, and confirms **Create N copies**.
  New tasks start with fresh progress; keep dates/sprint and copy attachments are explicit options. The dialog
  explains the difference between several people sharing one task and each person having their own copy.
- My work and project screens add **Export…**, with current-filtered versus all-eligible scope, included details
  and counts. Name the latter **All my work** or **All visible project items** to identify its source. My work
  keeps its assigned/created/personal source rules, Done option and unarchived-project limits in either case.
  **Include files for offline use** produces an archive with the workbook and permitted files/content; a plain
  workbook is the smaller default. State that these snapshots support offline reading, while recovery requires
  backups. Export controls use readable scope, not the ADO role restriction.
- A single **Help & FAQ** sidebar entry keeps support easy to find without adding several learning links.
  Its searchable page groups short how-to articles, labels role requirements and offers **Take the tour**.
- The tour is a short guided visit to pages, with brief instructions, step count, Back/Next and Skip. It combines
  common steps with the user's effective permissions in the chosen project/team and any system-admin tools.
  Replaying after a role change uses current permissions. It never performs real edits, blocks password change,
  or runs automatically just because a role changed. Empty projects have explanatory steps rather than broken
  targets. Keep the usual path within 2–3 minutes; put optional detail in linked FAQ articles.
- Tour navigation and overlays use existing tokens and shared/CDK components, with keyboard focus management,
  visible focus, screen-reader instructions and reduced motion. On phones, instructions must not hide their
  target or require horizontal page scrolling. Load tour, help and export presentation lazily within the
  unchanged bundle budget. Material dialogs use the shared 640 px size token with viewport limits;
  the tour's lower-page panel keeps its focused instructions and controls visible at phone width.
  Help procedures remain separate from the short introduction. Export previews name effective filters
  in ordinary language, while the server calculates scope and item counts across every matching page.

M7.5 implements the reported UI refinements:

- Empty labels span the available row; populated label grids keep their layout.
  Notification header and content share a responsive readable width. Delete bucket
  destinations use outlined labelled fields, clear when the source changes and
  retain confirmation.
- Bucket boards offer Add bucket, a draggable top bar with double-click name editing and
  a compact keyboard-accessible Rename/Move left/Move right menu for board managers and personal owners.
  Card lists have generous trailing drop targets and separate drag connections.
- Project manager, member and team-member searches use one outlined input plus
  Search/Enter and Material autocomplete results with name/email. Committed users
  appear as removable chips. Multi-person chips persist across queries; edited
  single choices and outdated query responses are invalidated. Team search stays
  local to active project members.

M8 adds a lazy project ADO transfer tab with Export CSV, PM-only incoming review,
settings and recovery. The existing snapshot action stays separate. Outbound
scope, selected/ancestor rows, file counts and losses are explicit. Incoming rows
have identity, selection, manual matching, reverse-type and parent-omission controls.
Field review shows current local, incoming and both confirmed baselines as escaped
text, with explicit choices and a required renewed preview after changes. Settings
use outlined Material fields, existing-resource selects and per-type date controls.
Changing a file resets file-specific approvals; changing project/capabilities clears
drafts and discards delayed responses. Layout uses existing tokens, wraps mapping
rows at phone width and retains named keyboard controls. CSV freshness/provenance
and cancellation duplicate risks are visible before actions.

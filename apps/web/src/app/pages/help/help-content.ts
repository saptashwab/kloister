/** One bundled searchable procedure with explicit permission requirements. */
export interface HelpArticle {
  /** Stable fragment identifier. */
  id: string;
  /** Searchable title. */
  title: string;
  /** Required role/scope explanation. */
  role: string;
  /** Detailed procedure, bundled for servers without external access. */
  text: string;
  /** Optional step-by-step sections, shown below the summary text. */
  sections?: readonly HelpSection[];
}

/** One heading of a longer how-to, with optional numbered steps and a screenshot. */
export interface HelpSection {
  /** Section heading. */
  heading: string;
  /** Explanatory paragraph. */
  text?: string;
  /** Numbered steps, in order. */
  steps?: readonly string[];
  /** A screenshot served by the app itself, loaded only when shown. */
  image?: { src: string; alt: string };
}

/** The step-by-step ADO transfer guide; screenshots show example data. */
const ADO_GUIDE: readonly HelpSection[] = [
  {
    heading: 'Two ways to start',
    text: 'Work can start on either side. Starting in Kloister: export it to ADO, import it there, bring ADO’s export back to link the new IDs, then send state and assignee (steps 2 to 4). Starting in ADO: export it from ADO and import it into Kloister as new items (step 5). After either start, items are linked by ADO ID and you can keep both sides in step in both directions (step 7).',
  },
  {
    heading: 'Who can do what',
    text: 'Project PMs can do everything below, including transfer settings and bringing ADO files back. Project Leads can export to ADO. Members, Viewers and system administrators without a project role cannot transfer. Personal spaces and archived projects are excluded. In ADO, importing CSV files needs Project Administrators membership in the ADO project.',
  },
  {
    heading: 'Before you start: work that exists on both sides',
    text: 'Kloister links an ADO row to a Kloister item only through the reference it put into a create file, or by your hand match to an item still waiting for its returned ID. It cannot link an item that already existed in ADO to one that already existed in Kloister, and titles are never used to match. So when the same work already exists on both sides, importing either way creates a duplicate.',
    steps: [
      'Choose one side as the source for each piece of work before the first transfer.',
      'Starting in Kloister: export only items that do not exist in ADO yet (use exact items or a subtree instead of the whole project). If ADO already has some of them, close or remove those ADO items first, or leave them out of the export.',
      'Starting in ADO: import only rows that do not exist in Kloister yet. Use Detailed review to select individual rows, or export a narrower ADO query. If Kloister already has some of them, delete or archive the Kloister copies first, or leave those rows out.',
      'After the first transfer, use only linked items for updates. A row that matches no linked item always needs your confirmation before it becomes a new item.',
    ],
  },
  {
    heading: 'Before you start: protect valuable data',
    text: 'Use Detailed review for the first transfer of a project and whenever a file contains more than you meant to change. Quick review takes a field changed on one side only, and a cell someone cleared counts as a change: if a date, iteration, assignee or description was emptied in ADO since the last sync, a Quick import empties it in Kloister too.',
    steps: [
      'Export from ADO only the columns you want to sync. A column that is not in the file is never changed in Kloister.',
      'Before the first import into ADO, export the ADO project to CSV as a record of its state; ADO also keeps each work item’s history, which shows and can restore earlier field values.',
      'Ask the Kloister administrator for a fresh backup before a large first import into Kloister.',
      'Read the preview summary every time: it lists what will be created, linked, updated or left unchanged, and every field sent or taken.',
      'Bring back a recent ADO export (Review remote observations for later export) before preparing an update file, and import that update in ADO soon after: CSV cannot lock ADO, so edits made in ADO after that export can be overwritten by the fields you send.',
    ],
  },
  {
    heading: 'What is never overwritten or deleted',
    text: 'Missing rows never delete anything on either side, and deleting an item in one system never deletes it in the other; a deleted Kloister item is never recreated by a later import. Update files send only fields you changed in Kloister, never ADO values Kloister cannot represent: people outside the project, tags without a label, Area Path, a state shared by several statuses, and an ADO description with embedded images unless you explicitly choose to replace it. ADO comments, attachments, history, links other than parent and fields Kloister does not map are never touched. In Kloister, imports never change checklists, notes, files, dependencies or extra assignees, never create buckets, sprints or accounts, and create labels only when you choose to. A field changed on both sides is never decided for you.',
  },
  {
    heading: '1. Set up once per project (PM)',
    steps: [
      'In ADO, open Boards > Queries, create a flat query (Flat list of work items) that returns a few existing items, and add the columns ID, Work Item Type, Title, State, Assigned To, Tags, Iteration Path and any date fields you use. Run it and choose Export to CSV from the ⋯ menu.',
      'In Kloister, open the project’s ADO transfer tab, then Transfer settings.',
      'Enter the ADO organization (or collection) and project name. Under Start from a sample, choose the exported file. Kloister suggests the process, the work item types, each ADO state’s status and bucket, tags, iterations and the date order.',
      'Check every suggestion, then Save. Map ADO states to existing buckets; Kloister never creates buckets, sprints, accounts or memberships. People are matched by email; add an identity row only for someone with another address in ADO. Tick a date for a type only if that ADO type has the field.',
    ],
    image: {
      src: 'help/ado/01-settings.png',
      alt: 'Transfer settings filled from a sample ADO export',
    },
  },
  {
    heading: '2. Starting in Kloister: send work to ADO',
    steps: [
      'Open Export to ADO and choose what to send: the whole project, a sprint, a subtree or exact items (select rows in the Backlog and use Transfer selected to ADO). Parents are included by default so the hierarchy survives.',
      'Choose Preview export CSV and read the summary and warnings.',
      'Choose Prepare reviewed CSV files, then Download reserved CSV files (a ZIP with one or more CSV files).',
      'In ADO, open Boards > Queries > Import work items, choose the create file, check the preview and choose Save items. New items start in ADO’s default state and without an assignee; Kloister remembers the intended state and assignee.',
    ],
    image: { src: 'help/ado/02-export-preview.png', alt: 'Quick export preview with its summary' },
  },
  {
    heading: '3. Starting in Kloister: bring the new ADO IDs back',
    steps: [
      'In ADO, export the new items with a flat query that includes ID, Work Item Type, Title, State and Description. The description carries a small Kloister reference footer that links each row to its Kloister item; keep it.',
      'In Kloister, open Import from ADO, keep Link returned IDs only, choose the file and choose Preview incoming CSV.',
      'Check the summary and choose Apply. ADO’s default state and empty assignee do not overwrite your Kloister status or assignees.',
    ],
    image: { src: 'help/ado/04-link-preview.png', alt: 'Returned IDs linked with one summary' },
  },
  {
    heading: '4. Starting in Kloister: send state and assignee',
    steps: [
      'After linking, choose Prepare the follow-up update (state and assignee).',
      'Confirm the notice about ADO observation times, choose Preview export CSV, then prepare and download the update file.',
      'Import that update file in ADO the same way as the create file. It carries only ID, type, title and the fields being sent.',
    ],
    image: {
      src: 'help/ado/06-follow-up.png',
      alt: 'Follow-up update preview sending only State',
    },
  },
  {
    heading: '5. Starting in ADO: import existing ADO work',
    steps: [
      'In ADO, export the items with a flat query, as in setup.',
      'In Kloister, open Import from ADO, choose Import reviewed local changes / new rows, choose the file and choose Preview incoming CSV.',
      'Rows that match no Kloister item need your confirmation: choose Confirm all unmatched rows as new items (or match a row to an existing item by hand), preview again and choose Apply. Each new item gets its bucket from the state mapping.',
    ],
    text: 'Bringing the same file back again changes nothing: counts stay the same in both systems, and rows missing from a file never delete anything.',
  },
  {
    heading: '6. Detailed review',
    text: 'On the Export to ADO or Import from ADO tab, switch the review toggle to Detailed review when you want to approve every change: every difference, link, row, parent, new label and assignee needs an explicit choice, and the last-synced values are shown beside the Kloister and ADO values. Use it for a first import of a large backlog, a file several people edited, or a change you want to check field by field. A PM can make it mandatory for the project under Transfer settings.',
    image: {
      src: 'help/ado/07-detailed-review.png',
      alt: 'Detailed review asking which title wins when both sides changed it',
    },
  },
  {
    heading: '7. Keep both sides in step',
    steps: [
      'To update ADO from Kloister, first bring a recent ADO export of the items back with Review remote observations for later export (this records ADO’s values without changing Kloister), then export. Update files carry only the fields you changed in Kloister; ADO values Kloister cannot represent (people outside the project, unmapped tags, Area Path, embedded images) are never overwritten.',
      'To update Kloister from ADO, bring an ADO export back with Import reviewed local changes / new rows. Fields changed only in ADO are taken; for fields changed on both sides choose keep Kloister, take ADO or skip.',
      'A parent changed in Kloister is reported but not sent; change it in ADO.',
      'Transfer history lists prepared files and reviews. A pending create blocks another create for the same items until its IDs are linked or the batch is cancelled. Cancelling cannot undo an import already made in ADO.',
    ],
    image: { src: 'help/ado/08-history.png', alt: 'Transfer history' },
  },
  {
    heading: 'Agile and Scrum',
    text: 'Both map Epic, Feature, Story, Task and Bug directly; a Story is a User Story in Agile and a Product Backlog Item in Scrum. Agile states are New, Active, Resolved and Closed (check what Resolved maps to; usually In progress). In Agile a Bug’s main text is Repro Steps, but Kloister writes Description. Scrum Backlog Items use New, Approved, Committed and Done and Tasks use To Do, In Progress and Done; map Approved and Committed deliberately, for example to a backlog bucket and an active bucket.',
  },
  {
    heading: 'Basic',
    text: 'Basic has three levels, so Kloister Epics are left out of the files and their Features become ADO Epics; the preview warns about this and the Feature keeps its Kloister parent. Stories and Bugs both become Issues, so a returned Issue needs a reverse type (usually Story) in Transfer settings. States are To Do, Doing and Done.',
  },
  {
    heading: 'Customized (inherited) processes',
    text: 'Start from a sample export of the customized project, or choose Custom, so its extra states and types appear. Map every extra state (for example In Review) to a status and bucket; unmapped states are reported, never guessed. Give extra work item types (for example a Spike) a reverse type so they can be imported: Kloister creates items only with its own types, so a Spike started in ADO is imported as, say, a Story, stays a Spike in ADO, and updates send it a state of its own type. Required custom fields can be sent as constant columns on create files; ADO keeps a constant only on types that have the field.',
  },
  {
    heading: 'Good to know',
    text: 'Titles and row order never identify items: without the Kloister reference footer, match rows to waiting items by hand. A file imported twice in ADO is refused when brought back because two rows carry the same reference: delete the duplicates in ADO, export again and link. In Detailed review, each value of a row that becomes a new Kloister item needs Take ADO value or Leave out; its title, type, status and bucket must be taken. If Apply is refused after a preview, Kloister data or settings changed: preview again. Files, comments, dependencies and history are not transferred; checklists and extra assignees become description text. Due times stay in Kloister: files carry the due date only. Deleted items are never recreated. Limits are 10 MiB, 1,000 rows and 1 MiB per cell. Open transfer files only in ADO, not in a spreadsheet.',
  },
];

/** Bundled procedures describe implemented features, including the separate reviewed CSV transfer. */
export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    id: 'ado',
    title: 'ADO transfer: export, bring back, update and import',
    role: 'Ordinary project PM/Lead export; project PM only for settings, incoming CSV, linking and recovery. Team Leads and administrators get no extra rights.',
    text: 'Move work between a Kloister project and an Azure DevOps (ADO) project with CSV files you carry yourself: export from one, import into the other. Kloister never connects to ADO and uses no token. Quick review is the default: a field changed on only one side since the last sync takes that side, you choose only where both sides changed, and one summary is shown before anything is prepared or applied. Detailed review asks about every difference. Export… on project pages is a separate Excel/offline snapshot, not this transfer.',
    sections: ADO_GUIDE,
  },
  {
    id: 'roles',
    title: 'Roles, visibility and teams',
    role: 'Everyone; project managers manage membership.',
    text: 'Your role belongs to each project: PM, Lead, Member or Viewer. PMs and Leads see the project; Member/Viewer visibility may be All, chosen buckets, Own (assigned or created), or Teams. Team Leads additionally manage only their teams’ items. Title-only ancestors provide context and cannot be opened, duplicated or selected as a parent. A missing item may be outside your scope. Administrators have independent user/settings responsibilities; they do not gain project write permissions. Ask a project manager when your access needs changing.',
  },
  {
    id: 'personal',
    title: 'Personal privacy and My work',
    role: 'Every signed-in user, their own personal space only.',
    text: 'Open Personal from the sidebar when you first need it. Its tasks belong implicitly to you, with no members, teams or assignments. Other users and administrators cannot open it. Server/database/file operators and backups can still read stored data: this is application privacy, not encryption. My work combines assigned tasks in your unarchived membership projects with your personal items. Use Also items I created, Show done and the All/Projects/Personal source switch to adjust eligibility. Project, type, label and due filters narrow it further. All their work never includes another person’s personal tasks or projects outside the viewer’s memberships.',
  },
  {
    id: 'duplicate',
    title: 'Shared tasks or separate copies?',
    role: 'PM, Lead or Member with creation rights and full source visibility; writable spaces only.',
    text: 'Several assignees on one task share its status and checklist. For independent progress, choose the overlapping-squares icon on a card or drawer (Duplicate item on hover or keyboard focus). Choose one copy per selected person, or a count with optional assignments. Select a legal destination bucket, optional team and readable compatible parent. Dates, sprint and attachments are explicit keep options. Review every resulting title/assignee, then choose Create N copies. New numbers and creator are independent; status/completion/checklist ticks reset. Description images copy with content and quota checks. Notes, old history, dependencies and children do not copy. Cross-space copying and moving are unavailable.',
  },
  {
    id: 'assignment',
    title: 'Create, assign and edit work',
    role: 'PM/Lead; Members on permitted items. Viewers read only.',
    text: 'Use New item or quick-add to create in a bucket you can see. Members edit items they created or are assigned; team Leads manage their teams’ items. Assigning others needs a PM/Lead role, the project assignment setting, or Lead rights for the selected team. Without that permission choose yourself or leave unassigned. Multiple assignees are allowed on a shared task. Dates use the calendar picker or can be typed as 23 Oct 2026 or 2026-10-23. A due date can have an optional due time (Add time in the drawer, 24-hour, no time zone): the item is overdue once that time passes, and within a day timed items come first, earliest first, then untimed items by priority. Personal tasks have implicit ownership and no assignment controls. Archived projects permit reading and snapshots only.',
  },
  {
    id: 'boards',
    title: 'Boards, status and hierarchy',
    role: 'Everyone reads their scope; moving/editing follows item permissions.',
    text: 'Board columns group by bucket, status, assignee or sprint. Filters combine; Clear filters removes narrowing. PMs, project Leads and personal owners can use Add bucket in Bucket grouping, hold and drag its top bar or use Move left/right in the bucket actions menu. Double-click the bucket name, or choose Rename bucket in that menu, to rename it. Names and order are shared with Settings. New buckets have no entry rule; edit rules in Settings. Other groupings do not reorder buckets. Drop cards below the last card to append. Drag cards, or use the keyboard: Move to top or bottom of bucket in the drawer’s actions menu, or the board’s card controls. Bucket rows in Settings, Buckets tab, have an actions menu to move a bucket up or down or delete it. Bucket and status are independent: a bucket entry rule may update status, and a status-to-bucket setting may move the card. Checklists never set status. Backlog shows the optional Epic → Feature → Story → Task hierarchy, with Bugs under Story or Feature and Tasks also under Feature. Select readable rows for permitted bulk sprint, bucket or assignment changes. Undo follows the same permissions and may be refused if rules changed.',
  },
  {
    id: 'content',
    title: 'Checklists, notes, mentions and files',
    role: 'Everyone reads visible items; PM/Lead/Member may annotate. Only note authors edit their notes.',
    text: 'Open an item to add, reorder and tick checklist lines when editable. Up/down controls provide keyboard ordering. Description and note editors offer formatting, images, paste/drop and Ctrl/Cmd+Enter to save; Escape cancels. Use @ to mention active project members where supported. Mentions notify only people who may read the item. Personal tasks have no mentions. Images open in a focus-managed viewer with arrow navigation. Files use admin size limits and project or personal quotas. Uploads count toward quota even before an image is saved; unused inline images are cleaned later. Ask an administrator about quota changes.',
  },
  {
    id: 'sprints',
    title: 'Plan and close sprints',
    role: 'Project PM/Lead or personal owner manages sprints; others read.',
    text: 'Open Sprints to create a dated planned sprint, activate it or open its filtered board. Only one sprint is active per space. When closing, move unfinished work to an open sprint or the backlog. Closed sprints do not accept new items. Duplication can retain a source sprint only while it remains open. Buckets remain independent of sprints.',
  },
  {
    id: 'notifications',
    title: 'Notifications and due reminders',
    role: 'Every signed-in user; only currently readable items.',
    text: 'The sidebar bell opens All or Unread notifications and refreshes the count every minute. Opening a notification marks it read and opens its item. Notifications cover assignments, mentions, due tomorrow, overdue and status changes to work you created. Due reminders run at 09:00 server time; personal reminders go to the owner. Lost project/item access removes those notifications from your readable list. No email service is required.',
  },
  {
    id: 'themes',
    title: 'Theme, branding and account settings',
    role: 'Everyone changes their own theme; administrators manage defaults and branding.',
    text: 'Open Settings and theme from the account menu to change your name, password, light/dark/device mode and primary/accent colors, or choose the admin default. Colors are adjusted for readable contrast. Administrators set the default theme, app name/logo and one UI font for everyone under Branding. Supported uploads are checked by content. A password change ends your other sessions. Security timeout changes apply as described in the administrator screen.',
  },
  {
    id: 'keyboard',
    title: 'Keyboard, focus and reduced motion',
    role: 'Everyone; action shortcuts still require normal permissions.',
    text: 'Use Tab/Shift+Tab to move and Enter/Space to activate. Search or jump is available from the sidebar and /. J/K focuses the next/previous card; Enter opens it. C creates, M opens bucket, A assignments and L labels where allowed. Escape closes the drawer/menu/editor; image viewers close before their drawer. ? opens keyboard reference and the browser-local single-key shortcut switch. Single keys are suppressed while typing, composing or using overlays. Every drag action has a field/order alternative. Reduced motion follows the device setting; there is no timed tour.',
  },
  {
    id: 'snapshots',
    title: 'Excel and offline snapshots',
    role: 'Every role, including Viewers, for currently readable data.',
    text: 'Choose Export… in the page header of My work or a project’s board, backlog or sprints. Preview Current filtered view or All my work/All visible project items. Every matching page is included. All my work retains assigned/created, source, Done and unarchived membership rules; it removes only narrowing filters. The workbook contains Summary, Items, Checklists, Notes, Dependencies, Files and readable Activity. Hidden ancestors stay titles only and hidden dependencies are omitted. Long cells use continuation rows rather than truncation; formula-looking text stays literal. Include files for offline use creates a ZIP with the workbook, original rich text, permitted images/attachments and an index. Extract it before opening index.html. File names are made safe; originals remain recorded. A missing file stops generation rather than silently disappearing. Scope may change between preview and download, and is checked again.',
  },
  {
    id: 'backups',
    title: 'Snapshots versus backups',
    role: 'Everyone may make readable snapshots; administrators manage server backups.',
    text: 'A snapshot is a portable reading copy, not a database restore format. Administrators configure scheduled Postgres backups and retention or Run now under Backups. Database dumps do not contain attachment or branding files; preserve those separately along with required configuration. Server operators perform recovery. Personal information is included in server backups and readable by operators. Installation and recovery procedures are part of the server documentation.',
  },
  {
    id: 'tour',
    title: 'First introduction and replay',
    role: 'Everyone after their required password change.',
    text: 'New accounts receive a brief skippable introduction after their initial required password change. Finish or Skip dismisses it across browsers. Later resets, sign-ins and role changes do not force another tour. Existing accounts on upgrade get manual replay only. Choose Take the tour here at any time; select a project to learn its current capabilities. Back/Next and a step count are always available. Changed permissions are rechecked and inaccessible project steps fall back to common features. The tour does not create demo tasks or change settings.',
  },
];

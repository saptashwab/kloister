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
}

/** Bundled procedures describe implemented features, including the separate reviewed CSV transfer. */
export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    id: 'ado',
    title: 'ADO transfer: export, bring back, update and import',
    role: 'Ordinary project PM/Lead export; project PM only for settings, incoming CSV, linking and recovery. Team Leads and administrators get no extra rights.',
    text: 'Open the ADO transfer tab of a project; Export… remains the Excel/offline snapshot. Once per project a PM opens Transfer settings, chooses a sample ADO query export and checks the suggested types, states with their buckets, tags, iterations and date order, then saves. Quick review is the default: a field changed on only one side since the last sync takes that side, you choose only where both sides changed, and one summary is shown before files are prepared or changes applied. Detailed review asks about every difference; a PM can require it for the project. To start from Kloister, export to ADO, import the create file in ADO (Boards, Queries, Import work items) and save. New ADO items start in the default state, so bring their export back and link returned IDs only: your local state and assignees stay. Then prepare the follow-up update for state and assignee and import it in ADO. Without the Kloister reference footer, match rows to waiting items by hand; titles never establish identity. To start from ADO, import selected rows and confirm them as new. Update files carry only fields you changed here, so ADO values Kloister cannot represent (people outside the project, unmapped tags, Area Path, images) are never overwritten. Missing rows never delete. Files, comments, dependencies and history are not transferred; checklists and extra assignees become description text. Due times stay in Kloister: files carry the due date only. Pending creates block another create until linked or cancelled; replaying a create file in ADO can duplicate it. Deleted items are never recreated. Limits: 10 MiB, 1,000 rows and 1 MiB per cell. No token or external connection is used. Importing in ADO needs Project Administrators membership there. See the ADO-EXPORT guide shipped with Kloister.',
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

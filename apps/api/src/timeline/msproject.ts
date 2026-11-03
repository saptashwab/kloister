import {
  addDays,
  compareOutline,
  type HalfDay,
  type ItemRefDto,
  type ItemStatus,
  type ItemType,
  isWorkingDay,
  type PlanEdge,
  type ScheduleDates,
  workCalendar,
  type WorkCalendar,
  workingDuration,
} from '@kloister/shared';

// Microsoft Project XML (the Project 2007 XML Data Interchange schema,
// mspdi_pj12.xsd, which later versions of Project still open) built from the
// readable plan (v1.3.2). Elements follow the schema's sequence order, which
// Project requires. Half days map to 08:00–12:00 and 13:00–17:00.

/** One assignee of an item. */
export interface MsProjectAssignee {
  /** User id. */
  userId: string;
  /** Display name. */
  name: string;
  /** Email address. */
  email: string;
  /** Share of their time, 5–100 (M13). */
  share: number;
}

/** One readable plan item. */
export interface MsProjectItem extends ScheduleDates {
  /** Item id. */
  id: string;
  /** Per-project number, for sibling order. */
  number: number;
  /** Outline position, for sibling order, or null. */
  outlinePosition: number | null;
  /** Display key, e.g. `KLO-12`. */
  key: string;
  /** Title. */
  title: string;
  /** Type. */
  type: ItemType;
  /** Status. */
  status: ItemStatus;
  /** Ancestors from the root down to the parent; hidden ones carry titles only. */
  ancestors: ItemRefDto[];
  /** Description as plain text. */
  description: string;
  /** Checklist progress. */
  checklist: { done: number; total: number };
  /** "Start no earlier than" pin, or null. */
  pin: HalfDay | null;
  /** Assignees with their shares. */
  assignees: MsProjectAssignee[];
}

/** What the file is built from. */
export interface MsProjectInput {
  /** Project name. */
  projectName: string;
  /** Readable items on the timeline (no ad-hoc items). */
  items: MsProjectItem[];
  /** Readable dependency links. */
  edges: PlanEdge[];
  /** The project's holidays. */
  holidays: { name: string; startDate: string; endDate: string }[];
  /** Today, `YYYY-MM-DD`, for undated items when nothing is dated. */
  today: string;
  /** The export time. */
  now: Date;
}

/** Working hours in a day, as in Project's standard calendar. */
const HOURS_PER_DAY = 8;
/** Start of the 1st and 2nd half of a working day. */
const HALF_START = ['08:00:00', '13:00:00'] as const;
/** End of the 1st and 2nd half of a working day. */
const HALF_END = ['12:00:00', '17:00:00'] as const;
/** Readable type names. */
const TYPE_NAMES: Record<ItemType, string> = {
  EPIC: 'Epic',
  FEATURE: 'Feature',
  STORY: 'User Story',
  TASK: 'Task',
  BUG: 'Bug',
};
/** Readable status names. */
const STATUS_NAMES: Record<ItemStatus, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  DONE: 'Done',
};

/** A row of the outline: a readable item or a title-only hidden ancestor. */
interface Node {
  id: string;
  number: number;
  type: ItemType;
  key: string;
  title: string;
  outlinePosition: number | null;
  item: MsProjectItem | null;
  children: Node[];
}

/** A task's span, by date and half. */
interface Span {
  start: HalfDay;
  finish: HalfDay;
}

/**
 * Escapes text for XML, dropping characters XML 1.0 does not allow.
 *
 * @param value Text.
 * @returns Safe element content.
 */
export function xmlText(value: string): string {
  return value
    .replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One element with text content.
 *
 * @param name Element name.
 * @param value Content.
 * @returns The element.
 */
function el(name: string, value: string | number): string {
  return `<${name}>${xmlText(String(value))}</${name}>`;
}

/**
 * A work duration in the schema's form.
 *
 * @param hours Hours.
 * @returns E.g. `PT20H0M0S`.
 */
function hoursText(hours: number): string {
  const minutes = Math.round(hours * 60);
  return `PT${Math.floor(minutes / 60)}H${minutes % 60}M0S`;
}

/**
 * The start of a half day as a date-time.
 *
 * @param half Date and half.
 * @returns E.g. `2026-11-05T13:00:00`.
 */
function startAt(half: HalfDay): string {
  return `${half.date}T${HALF_START[half.second ? 1 : 0]}`;
}

/**
 * The end of a half day as a date-time.
 *
 * @param half Date and half (`second` false: the 1st half).
 * @returns E.g. `2026-11-11T17:00:00`.
 */
function finishAt(half: HalfDay): string {
  return `${half.date}T${HALF_END[half.second ? 1 : 0]}`;
}

/**
 * Orders two half days.
 *
 * @param a One.
 * @param b The other.
 * @returns Negative when `a` comes first.
 */
function compareHalf(a: HalfDay, b: HalfDay): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : Number(a.second) - Number(b.second);
}

/**
 * An item's own span: both dates, or the one it has for both ends.
 *
 * @param item The item.
 * @returns The span, or null without dates.
 */
function ownSpan(item: MsProjectItem): Span | null {
  const start = item.startDate ?? item.dueDate;
  const due = item.dueDate ?? item.startDate;
  if (start === null || due === null) return null;
  return {
    start: { date: start, second: item.startDate !== null && item.startSecondHalf },
    // `second` on a finish means it ends after the 2nd half.
    finish: { date: due, second: !(item.dueDate !== null && item.dueFirstHalf) },
  };
}

/**
 * Working days of a span.
 *
 * @param span The span.
 * @param cal Holidays.
 * @returns Days in halves.
 */
function spanDays(span: Span, cal: WorkCalendar): number {
  const dates: ScheduleDates = {
    startDate: span.start.date,
    startSecondHalf: span.start.second,
    dueDate: span.finish.date,
    dueFirstHalf: !span.finish.second,
  };
  return workingDuration(dates, cal);
}

/**
 * Merges overlapping holidays (a project's own and the instance's can share
 * days), since Project refuses overlapping calendar exceptions.
 *
 * @param holidays Holidays.
 * @returns Non-overlapping holidays in date order, names joined.
 */
export function mergeHolidays(
  holidays: readonly { name: string; startDate: string; endDate: string }[],
): { name: string; startDate: string; endDate: string }[] {
  const merged: { name: string; startDate: string; endDate: string }[] = [];
  for (const h of [...holidays].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
    const last = merged[merged.length - 1];
    if (last !== undefined && h.startDate <= last.endDate) {
      if (h.endDate > last.endDate) last.endDate = h.endDate;
      if (!last.name.split(' / ').includes(h.name)) last.name = `${last.name} / ${h.name}`;
    } else merged.push({ ...h });
  }
  return merged;
}

/**
 * Builds the outline: items under their parents, hidden ancestors as
 * title-only rows, siblings in outline order.
 *
 * @param items Readable items.
 * @returns Root rows.
 */
function outline(items: readonly MsProjectItem[]): Node[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const nodes = new Map<string, Node>();
  const placed = new Set<string>();
  const roots: Node[] = [];
  const nodeFor = (ref: ItemRefDto): Node => {
    let node = nodes.get(ref.id);
    if (node === undefined) {
      const item = byId.get(ref.id) ?? null;
      node = {
        id: ref.id,
        number: ref.number,
        type: item?.type ?? ref.type,
        key: ref.key,
        title: item?.title ?? ref.title,
        outlinePosition: item?.outlinePosition ?? null,
        item,
        children: [],
      };
      nodes.set(ref.id, node);
    }
    return node;
  };
  const place = (node: Node, parent: Node | null) => {
    if (placed.has(node.id)) return;
    placed.add(node.id);
    (parent === null ? roots : parent.children).push(node);
  };
  for (const item of items) {
    let parent: Node | null = null;
    for (const ancestor of item.ancestors) {
      const node = nodeFor(ancestor);
      place(node, parent);
      parent = node;
    }
    place(nodeFor(item), parent);
  }
  const order = (list: Node[]) => {
    list.sort(compareOutline);
    for (const node of list) order(node.children);
  };
  order(roots);
  return roots;
}

/**
 * Builds a Microsoft Project XML file of the readable plan (v1.3.2):
 * Epics, Features and Stories with rows under them become summary tasks,
 * the others tasks with their dates (held by a "Start No Earlier Than"
 * constraint, so Project keeps them while it schedules), durations, percent
 * complete and finish-to-start links. Assignees become resources with their
 * shares as units; holidays become exceptions in the project calendar. Items
 * without dates get an estimated one-day duration at the plan's start.
 *
 * @param input The plan.
 * @returns The XML document.
 */
export function msProjectXml(input: MsProjectInput): string {
  const cal = workCalendar(input.holidays);
  const roots = outline(input.items);

  // Spans: leaves from their dates, summaries from their dated descendants.
  const spans = new Map<Node, Span | null>();
  const spanOf = (node: Node): Span | null => {
    let span: Span | null = null;
    if (node.children.length === 0) span = node.item === null ? null : ownSpan(node.item);
    else
      for (const child of node.children) {
        const s = spanOf(child);
        if (s === null) continue;
        span =
          span === null
            ? s
            : {
                start: compareHalf(s.start, span.start) < 0 ? s.start : span.start,
                finish: compareHalf(s.finish, span.finish) > 0 ? s.finish : span.finish,
              };
      }
    spans.set(node, span);
    return span;
  };
  let plan: Span | null = null;
  for (const root of roots) {
    const s = spanOf(root);
    if (s === null) continue;
    plan =
      plan === null
        ? s
        : {
            start: compareHalf(s.start, plan.start) < 0 ? s.start : plan.start,
            finish: compareHalf(s.finish, plan.finish) > 0 ? s.finish : plan.finish,
          };
  }
  // Undated tasks: an estimated day at the plan's start, on a working day.
  const holidays = mergeHolidays(input.holidays);
  let firstDay = plan?.start.date ?? input.today;
  while (
    !isWorkingDay(firstDay) ||
    holidays.some((h) => h.startDate <= firstDay && firstDay <= h.endDate)
  )
    firstDay = addDays(firstDay, 1);
  const undated: Span = {
    start: { date: firstDay, second: false },
    finish: { date: firstDay, second: true },
  };
  const whole = plan ?? undated;

  // Percent complete: done items 100, others by checklist; summaries
  // weighted by their leaves' working days, as on the timeline.
  const own = (item: MsProjectItem) =>
    item.status === 'DONE'
      ? 100
      : item.checklist.total > 0
        ? (item.checklist.done / item.checklist.total) * 100
        : 0;
  const leaves = (node: Node): MsProjectItem[] =>
    node.children.length === 0
      ? node.item === null
        ? []
        : [node.item]
      : node.children.flatMap(leaves);
  const percent = (node: Node): number => {
    let weight = 0;
    let done = 0;
    for (const item of leaves(node)) {
      const w = Math.max(0.5, workingDuration(item, cal));
      weight += w;
      done += w * own(item);
    }
    return weight === 0 ? 0 : Math.round(done / weight);
  };

  // Rows in outline order, numbered as Project numbers them.
  const rows: { node: Node; uid: number; level: number; number: string }[] = [];
  const walk = (list: Node[], level: number, prefix: string) =>
    list.forEach((node, index) => {
      const number = prefix === '' ? String(index + 1) : `${prefix}.${index + 1}`;
      rows.push({ node, uid: rows.length + 1, level, number });
      walk(node.children, level + 1, number);
    });
  walk(roots, 1, '');
  const uidOf = new Map(rows.map((row) => [row.node.id, row.uid]));
  const keyOf = new Map(rows.map((row) => [row.node.id, row.node.key]));

  // Links by successor. Project cannot link a summary task with its own rows,
  // so links between an item and its ancestor are left to the notes.
  const lineage = new Map(input.items.map((i) => [i.id, new Set(i.ancestors.map((a) => a.id))]));
  const blockers = new Map<string, string[]>();
  const ownRowLinks = new Map<string, string[]>();
  for (const edge of input.edges) {
    if (!uidOf.has(edge.blockingItemId) || !uidOf.has(edge.blockedItemId)) continue;
    const related =
      lineage.get(edge.blockedItemId)?.has(edge.blockingItemId) === true ||
      lineage.get(edge.blockingItemId)?.has(edge.blockedItemId) === true;
    const into = related ? ownRowLinks : blockers;
    into.set(edge.blockedItemId, [...(into.get(edge.blockedItemId) ?? []), edge.blockingItemId]);
  }

  // Resources: everyone assigned to a task.
  const resources = new Map<string, { uid: number; assignee: MsProjectAssignee }>();
  for (const { node } of rows)
    if (node.children.length === 0)
      for (const assignee of node.item?.assignees ?? [])
        if (!resources.has(assignee.userId))
          resources.set(assignee.userId, { uid: resources.size + 1, assignee });

  const tasks: string[] = [];
  const assignments: string[] = [];
  // Task 0 is the project summary.
  tasks.push(
    [
      '<Task>',
      el('UID', 0),
      el('ID', 0),
      el('Name', input.projectName),
      el('Type', 1),
      el('IsNull', 0),
      el('OutlineNumber', 0),
      el('OutlineLevel', 0),
      el('Start', startAt(whole.start)),
      el('Finish', finishAt(whole.finish)),
      el('Duration', hoursText(spanDays(whole, cal) * HOURS_PER_DAY)),
      el('DurationFormat', 7),
      el('Summary', 1),
      '</Task>',
    ].join(''),
  );
  for (const { node, uid, level, number } of rows) {
    const item = node.item;
    const summary = node.children.length > 0;
    const span = spans.get(node) ?? null;
    const dated = span ?? undated;
    const days = spanDays(dated, cal);
    const notes: string[] = [];
    if (item === null) notes.push(`${node.key}: not visible to you in Kloister (title only).`);
    else {
      notes.push(`${item.key} · ${TYPE_NAMES[item.type]} · ${STATUS_NAMES[item.status]}`);
      if (summary && item.assignees.length > 0)
        notes.push(`Assigned in Kloister: ${item.assignees.map((a) => a.name).join(', ')}`);
      if (item.pin !== null)
        notes.push(
          `Pinned in Kloister: start no earlier than ${item.pin.date}${item.pin.second ? ', 2nd half' : ''}.`,
        );
      if (!summary && span === null) notes.push('No dates in Kloister yet.');
      else if (!summary && (item.startDate === null || item.dueDate === null))
        notes.push(`Only a ${item.startDate === null ? 'due' : 'start'} date in Kloister.`);
      const selfLinks = ownRowLinks.get(item.id) ?? [];
      if (selfLinks.length > 0)
        notes.push(
          `Waits for ${selfLinks.map((id) => keyOf.get(id)).join(', ')} in Kloister (its own parent or child row; Project cannot link those).`,
        );
      if (item.description.trim() !== '') notes.push('', item.description.trim());
    }
    const links = (blockers.get(node.id) ?? []).map((blocking) =>
      [
        '<PredecessorLink>',
        el('PredecessorUID', uidOf.get(blocking)!),
        el('Type', 1),
        el('CrossProject', 0),
        el('LinkLag', 0),
        el('LagFormat', 7),
        '</PredecessorLink>',
      ].join(''),
    );
    const leafDated = !summary && span !== null;
    tasks.push(
      [
        '<Task>',
        el('UID', uid),
        el('ID', uid),
        el('Name', node.title),
        el('Type', 1),
        el('IsNull', 0),
        el('WBS', node.key),
        el('OutlineNumber', number),
        el('OutlineLevel', level),
        el('Start', startAt(dated.start)),
        el('Finish', finishAt(dated.finish)),
        el('Duration', hoursText(Math.max(days, 0.5) * HOURS_PER_DAY)),
        el('DurationFormat', !summary && span === null ? 39 : 7),
        el('Estimated', !summary && span === null ? 1 : 0),
        el('Milestone', 0),
        el('Summary', summary ? 1 : 0),
        el('PercentComplete', percent(node)),
        // Start No Earlier Than holds a dated task where Kloister has it.
        el('ConstraintType', leafDated ? 4 : 0),
        ...(leafDated ? [el('ConstraintDate', startAt(dated.start))] : []),
        el('Notes', notes.join('\n')),
        ...links,
        '</Task>',
      ].join(''),
    );
    if (summary || item === null) continue;
    for (const assignee of item.assignees) {
      const units = assignee.share / 100;
      assignments.push(
        [
          '<Assignment>',
          el('UID', assignments.length + 1),
          el('TaskUID', uid),
          el('ResourceUID', resources.get(assignee.userId)!.uid),
          el('Finish', finishAt(dated.finish)),
          el('Start', startAt(dated.start)),
          el('Units', units.toFixed(2)),
          el('Work', hoursText(Math.max(days, 0.5) * HOURS_PER_DAY * units)),
          '</Assignment>',
        ].join(''),
      );
    }
  }

  const working = HALF_START.map((from, i) =>
    ['<WorkingTime>', el('FromTime', from), el('ToTime', HALF_END[i]), '</WorkingTime>'].join(''),
  ).join('');
  // Sunday is 1 and Saturday 7.
  const weekDays = [1, 2, 3, 4, 5, 6, 7]
    .map((day) =>
      day === 1 || day === 7
        ? ['<WeekDay>', el('DayType', day), el('DayWorking', 0), '</WeekDay>'].join('')
        : [
            '<WeekDay>',
            el('DayType', day),
            el('DayWorking', 1),
            `<WorkingTimes>${working}</WorkingTimes>`,
            '</WeekDay>',
          ].join(''),
    )
    .join('');
  const exceptions = holidays
    .map((h) =>
      [
        '<Exception>',
        el('EnteredByOccurrences', 0),
        '<TimePeriod>',
        el('FromDate', `${h.startDate}T00:00:00`),
        el('ToDate', `${h.endDate}T23:59:00`),
        '</TimePeriod>',
        el('Occurrences', 1),
        el('Name', h.name),
        el('Type', 1),
        el('DayWorking', 0),
        '</Exception>',
      ].join(''),
    )
    .join('');
  const created = input.now.toISOString().slice(0, 19);

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Project xmlns="http://schemas.microsoft.com/project">',
    el('SaveVersion', 12),
    el('Name', `${input.projectName}.xml`),
    el('Title', input.projectName),
    el('CreationDate', created),
    el('ScheduleFromStart', 1),
    el('StartDate', startAt(whole.start)),
    el('FinishDate', finishAt(whole.finish)),
    el('CurrencyCode', 'USD'),
    el('CalendarUID', 1),
    el('DefaultStartTime', HALF_START[0]),
    el('DefaultFinishTime', HALF_END[1]),
    el('MinutesPerDay', HOURS_PER_DAY * 60),
    el('MinutesPerWeek', HOURS_PER_DAY * 60 * 5),
    el('DaysPerMonth', 20),
    el('DefaultTaskType', 1),
    el('DurationFormat', 7),
    el('WorkFormat', 2),
    el('HonorConstraints', 1),
    el('NewTasksEffortDriven', 0),
    el('NewTasksEstimated', 0),
    el('WeekStartDay', 1),
    el('CurrentDate', created),
    '<Calendars><Calendar>',
    el('UID', 1),
    el('Name', 'Standard'),
    el('IsBaseCalendar', 1),
    el('BaseCalendarUID', -1),
    `<WeekDays>${weekDays}</WeekDays>`,
    exceptions === '' ? '' : `<Exceptions>${exceptions}</Exceptions>`,
    '</Calendar></Calendars>',
    `<Tasks>${tasks.join('')}</Tasks>`,
    `<Resources>${[...resources.values()]
      .map(({ uid, assignee }) =>
        [
          '<Resource>',
          el('UID', uid),
          el('ID', uid),
          el('Name', assignee.name),
          el('Type', 1),
          el('IsNull', 0),
          el('EmailAddress', assignee.email),
          el('MaxUnits', '1.00'),
          '</Resource>',
        ].join(''),
      )
      .join('')}</Resources>`,
    `<Assignments>${assignments.join('')}</Assignments>`,
    '</Project>',
    '',
  ].join('\n');
}

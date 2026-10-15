import sanitizeHtml from 'sanitize-html';
import { decodeHTML } from 'entities';
import { randomUUID } from 'node:crypto';

/** Table data containing only caller-readable values. */
export type SnapshotTables = Record<string, { headers: string[]; rows: string[][] }>;

/**
 * Makes rich text readable in spreadsheet cells, retaining block and line boundaries.
 * @param html Previously sanitized item or note HTML.
 * @returns Readable plain text with image alt text.
 */
export function readableText(html: string): string {
  return decodeHTML(
    sanitizeHtml(
      html
        .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, ' [Image: $1] ')
        .replace(/<\/(p|div|h[1-6]|li|blockquote|pre)>|<br\s*\/?\s*>/gi, '\n'),
      { allowedTags: [], allowedAttributes: {} },
    ),
  );
}

/**
 * Escapes HTML labels in an offline index without interpreting user text.
 * @param value Label or title.
 * @returns Literal safe HTML text.
 */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

/**
 * Produces a safe archive leaf; a generated id prefix prevents filename collisions.
 * @param id Generated attachment uuid.
 * @param name Original name, retained separately in the workbook.
 * @returns A relative leaf without traversal, separators or control characters.
 */
export function archiveLeaf(id: string, name: string): string {
  return `${id}-${
    Array.from(name.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '_'))
      .slice(0, 100)
      .join('') || 'file'
  }`;
}

/**
 * Writes data as literal strings; long cells use linked continuation rows without loss.
 * @param tables Caller-readable tables, including Summary.
 * @returns Workbook bytes with frozen/filterable headers and wrapped text.
 */
export async function snapshotWorkbook(tables: SnapshotTables): Promise<Buffer> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const itemRows = new Map<string, { sheet: string; row: number }>();
  // ZIP string chunking can split a surrogate pair. Keep writer inputs ASCII for
  // supplementary characters, then emit standard numeric XML references below.
  let marker = '';
  do {
    marker = `UNICODE${randomUUID().replaceAll('-', '')}X`;
  } while (
    Object.values(tables).some((table) =>
      table.rows.some((row) => row.some((value) => value.includes(marker))),
    )
  );
  const encode = (value: string) =>
    Array.from(value, (char) =>
      (char.codePointAt(0) ?? 0) > 0xffff
        ? `${marker}${char.codePointAt(0)?.toString(16)}END`
        : char,
    ).join('');
  const overflow = workbook.addWorksheet('Continued text');
  overflow.addRow(['Source sheet', 'Source row', 'Column', 'Part', 'Text']);
  for (const [name, table] of Object.entries(tables)) {
    let sheetNumber = 1;
    let sheet = workbook.addWorksheet(name);
    const setup = () => {
      sheet.addRow(table.headers);
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.columns.forEach((column) => {
        column.width = 28;
        column.alignment = { vertical: 'top', wrapText: true };
      });
      sheet.getRow(1).font = { bold: true };
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: table.headers.length },
      };
    };
    setup();
    for (const data of table.rows) {
      if (sheet.rowCount >= 1_048_576) {
        sheet = workbook.addWorksheet(`${name} ${++sheetNumber}`);
        setup();
      }
      const rowNumber = sheet.rowCount + 1;
      const values = data.map((value, column) => {
        // XML cannot represent these controls; a visible escape preserves their identity.
        const safe = Array.from(value, (char) =>
          (char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0))) ||
          char.charCodeAt(0) === 127 ||
          char === '\ufffe' ||
          char === '\uffff' ||
          (char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)
            ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
            : char,
        ).join('');
        if (safe.length <= 32_000) return encode(safe);
        const characters = Array.from(safe);
        for (let offset = 0; offset < characters.length; offset += 16_000) {
          if (overflow.rowCount >= 1_048_576)
            throw new Error(
              'Snapshot exceeds the continuation sheet capacity; narrow the export scope',
            );
          overflow.addRow([
            sheet.name,
            String(rowNumber),
            table.headers[column] ?? '',
            String(offset / 16_000 + 1),
            encode(characters.slice(offset, offset + 16_000).join('')),
          ]);
        }
        return `[Full text in Continued text: ${sheet.name}, row ${rowNumber}, ${table.headers[column] ?? ''}]`;
      });
      const row = sheet.addRow(values);
      // Formula-like strings are never assigned as formula or hyperlink objects.
      row.eachCell((cell) => {
        cell.numFmt = '@';
      });
      const key = data[0];
      if (key !== undefined && name === 'Items')
        itemRows.set(key, { sheet: sheet.name, row: rowNumber });
      else if (key !== undefined && !['Summary', 'Items'].includes(name)) {
        const target = itemRows.get(key);
        if (target !== undefined)
          row.getCell(1).value = { text: key, hyperlink: `#'${target.sheet}'!A${target.row}` };
      }
    }
  }
  overflow.views = [{ state: 'frozen', ySplit: 1 }];
  overflow.columns.forEach((column) => {
    column.width = 28;
    column.alignment = { wrapText: true, vertical: 'top' };
  });
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  for (const name of Object.keys(zip.files).filter((name) => name.endsWith('.xml'))) {
    const xml = await zip.file(name)?.async('string');
    if (xml?.includes(marker))
      zip.file(name, xml.replace(new RegExp(`${marker}([0-9a-f]+)END`, 'g'), '&#x$1;'));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

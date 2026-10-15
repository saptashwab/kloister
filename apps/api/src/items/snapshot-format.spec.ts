import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { archiveLeaf, escapeHtml, readableText, snapshotWorkbook } from './snapshot-format.js';

describe('readable snapshot formatting', () => {
  it('writes formula-like text as string cells without formula or macro parts', async () => {
    const values = ['=HYPERLINK("https://example.org")', '+SUM(1,2)', '-2+3', '@SUM(A1)', '\t=1'];
    const bytes = await snapshotWorkbook({
      Items: { headers: ['Title'], rows: values.map((value) => [value]) },
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
    const sheet = workbook.getWorksheet('Items');
    values.forEach((value, index) => {
      expect(sheet?.getCell(index + 2, 1).value).toBe(value);
      expect(sheet?.getCell(index + 2, 1).type).toBe(ExcelJS.ValueType.String);
    });
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).some((name) => /vbaProject|externalLinks/.test(name))).toBe(
      false,
    );
    for (const name of Object.keys(zip.files).filter((name) =>
      /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
    ))
      expect(await zip.file(name)?.async('string')).not.toMatch(/<f[ >]/);
  });

  it('preserves long multi-assignee and Unicode text using ordered continuation rows', async () => {
    const text = 'A😀\n'.repeat(25_000);
    const bytes = await snapshotWorkbook({
      Notes: { headers: ['Item', 'Body'], rows: [['KLO-1', text]] },
    });
    const zip = await JSZip.loadAsync(bytes);
    const serialized = await zip.file('xl/sharedStrings.xml')!.async('string');
    expect(serialized).not.toContain('\ufffd');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
    const parts: string[] = [];
    workbook.getWorksheet('Continued text')?.eachRow((row, index) => {
      if (index > 1) parts.push(row.getCell(5).text);
    });
    expect(parts.join('')).toBe(text);
    expect(workbook.getWorksheet('Notes')?.getCell('B2').text).toContain(
      'Full text in Continued text',
    );
    expect(workbook.getWorksheet('Notes')?.views[0]?.state).toBe('frozen');
    expect(workbook.getWorksheet('Notes')?.autoFilter).toBeDefined();
  });

  it.each([
    '../../secret',
    '..\\..\\file',
    '/etc/passwd',
    'C:\\boot',
    '\u0000evil\u202e.html',
    '...',
  ])('keeps %j inside a generated archive leaf', (name) => {
    const leaf = archiveLeaf('12345678-1234-4234-8234-123456789012', name);
    expect(leaf).not.toMatch(/[\\/\u202e]/);
    expect(Array.from(leaf).every((char) => char.charCodeAt(0) >= 32)).toBe(true);
    expect(leaf).not.toMatch(/^\./);
  });

  it('preserves readable block boundaries and escapes offline index titles', () => {
    expect(readableText('<p>One &amp; two</p><ul><li>Three</li></ul>')).toContain(
      'One & two\nThree\n',
    );
    expect(escapeHtml('<img onerror="bad">')).toBe('&lt;img onerror=&quot;bad&quot;&gt;');
  });

  it.each(['\ufffe', '\uffff', '\ud800', '\udfff', '\u0000', '\u007f'])(
    'retains XML-forbidden %j as a visible Unicode escape',
    async (character) => {
      const bytes = await snapshotWorkbook({
        Items: { headers: ['Text'], rows: [[`before${character}after`]] },
      });
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
      expect(workbook.getWorksheet('Items')?.getCell('A2').text).toBe(
        `before\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}after`,
      );
    },
  );
});

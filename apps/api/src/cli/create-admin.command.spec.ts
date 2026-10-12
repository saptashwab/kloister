import { jest } from '@jest/globals';
import { runCreateAdmin } from './create-admin.command.js';

// Argument handling only; the database path is covered by test/db/.
describe('runCreateAdmin argument checks', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    [[]],
    [['--email', 'not-an-email', '--name', 'A']],
    [['--email', 'a@example.org']],
    [['--email', 'a@example.org', '--name', '   ']],
    [['--unknown', 'x']],
  ])('exits 2 for %j', async (argv) => {
    await expect(runCreateAdmin(argv)).resolves.toBe(2);
  });
});

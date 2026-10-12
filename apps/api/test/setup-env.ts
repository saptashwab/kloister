// Environment for tests that boot the app without a database. The URL is
// never connected to: Prisma connects lazily and these tests stop at guards
// or validation before any query runs.
process.env['DATABASE_URL'] ??= 'postgresql://unused:unused@127.0.0.1:1/unused';
process.env['APP_NAME'] ??= 'kloister-test';

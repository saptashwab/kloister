import { runCreateAdmin } from './create-admin.command.js';

// Entry point for `node dist/cli/create-admin.js`; all logic lives in
// create-admin.command.ts so it can be tested without spawning a process.
process.exitCode = await runCreateAdmin(process.argv.slice(2));

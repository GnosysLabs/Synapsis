#!/usr/bin/env node

import { run } from './commands.js';

try {
  await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`synapsis: ${error.message}\n`);
  process.exitCode = 1;
}

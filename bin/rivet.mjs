#!/usr/bin/env node
import { main } from '../dist/cli/cli.js';
main().catch(error => {
  console.error(`Rivet: ${error.message}`);
  process.exitCode = 1;
});

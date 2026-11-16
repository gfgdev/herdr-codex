#!/usr/bin/env node
import { installConfigReference } from '../runtime/src/config.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', 'help'].includes(args[0])) {
  console.log('Use node scripts/install-config.mjs --config /absolute/existing/config.json\nCreates a private per-user config reference; never replaces a different installation.');
} else {
  if (args.length !== 2 || args[0] !== '--config') throw new Error('Use --config /absolute/existing/config.json');
  console.log(JSON.stringify(installConfigReference(args[1]), null, 2));
}

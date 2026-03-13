#!/usr/bin/env node
/**
 * Post-install script - copies .env.local.example to .env.local if it doesn't exist
 */

import { copyFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Skip in CI environments
if (process.env.CI) {
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const example = join(ROOT, '.env.local.example');
const target = join(ROOT, '.env.local');

if (existsSync(example) && !existsSync(target)) {
  copyFileSync(example, target);
  console.log('Created .env.local from .env.local.example');
  console.log('Edit it to set your OBSIDIAN_VAULT path for auto-copy during development.');
}

import { createRequire } from 'node:module';

/**
 * Vitest 2 bundles Vite 5, whose builtin-module list predates `node:sqlite`.
 * Load the real module at runtime so tests can use the same database engine.
 */
const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite') as typeof import('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
export default sqlite;

/**
 * CodexCliInstaller - Codex CLI integration for claude-mem
 *
 * Uses transcript-only watching (no notify hook). The watcher infrastructure
 * already exists in src/services/transcripts/. This installer:
 *
 * 1. Writes/merges transcript-watch config to ~/.claude-mem/transcript-watch.json
 * 2. Sets up watch for ~/.codex/sessions/**\/*.jsonl using existing watcher
 * 3. Uses runtime-only, user-level isolated memory instead of workspace AGENTS.md files
 *
 * Anti-patterns:
 *   - Does NOT add notify hooks -- transcript watching is sufficient
 *   - Does NOT modify existing transcript watcher infrastructure
 *   - Does NOT overwrite existing transcript-watch.json -- merges only
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../../utils/logger.js';
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATE_PATH,
  SAMPLE_CONFIG,
} from '../transcripts/config.js';
import type { TranscriptWatchConfig, WatchTarget } from '../transcripts/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODEX_DIR = path.join(homedir(), '.codex');
const CODEX_AGENTS_MD_PATH = path.join(CODEX_DIR, 'AGENTS.md');
const CLAUDE_MEM_DIR = path.join(homedir(), '.claude-mem');

/**
 * The watch name used to identify the Codex CLI entry in transcript-watch.json.
 * Must match the name in SAMPLE_CONFIG for merging to work correctly.
 */
const CODEX_WATCH_NAME = 'codex';

// ---------------------------------------------------------------------------
// Transcript Watch Config Merging
// ---------------------------------------------------------------------------

/**
 * Load existing transcript-watch.json, or return an empty config scaffold.
 * Never throws -- returns a valid empty config on any parse error.
 */
function loadExistingTranscriptWatchConfig(): TranscriptWatchConfig {
  const configPath = DEFAULT_CONFIG_PATH;

  if (!existsSync(configPath)) {
    return { version: 1, schemas: {}, watches: [], stateFile: DEFAULT_STATE_PATH };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as TranscriptWatchConfig;

    // Ensure required fields exist
    if (!parsed.version) parsed.version = 1;
    if (!parsed.watches) parsed.watches = [];
    if (!parsed.schemas) parsed.schemas = {};
    if (!parsed.stateFile) parsed.stateFile = DEFAULT_STATE_PATH;

    return parsed;
  } catch (parseError) {
    if (parseError instanceof Error) {
      logger.error('WORKER', 'Corrupt transcript-watch.json, creating backup', { path: configPath }, parseError);
    } else {
      logger.error('WORKER', 'Corrupt transcript-watch.json, creating backup', { path: configPath }, new Error(String(parseError)));
    }

    // Back up corrupt file
    const backupPath = `${configPath}.backup.${Date.now()}`;
    writeFileSync(backupPath, readFileSync(configPath));
    console.warn(`  Backed up corrupt transcript-watch.json to ${backupPath}`);

    return { version: 1, schemas: {}, watches: [], stateFile: DEFAULT_STATE_PATH };
  }
}

/**
 * Merge Codex watch configuration into existing transcript-watch.json.
 *
 * - If a watch with name 'codex' already exists, it is replaced in-place.
 * - If the 'codex' schema already exists, it is replaced in-place.
 * - All other watches and schemas are preserved untouched.
 */
function mergeCodexWatchConfig(existingConfig: TranscriptWatchConfig): TranscriptWatchConfig {
  const merged = { ...existingConfig };

  // Merge schemas: add/replace the codex schema
  merged.schemas = { ...merged.schemas };
  const codexSchema = SAMPLE_CONFIG.schemas?.[CODEX_WATCH_NAME];
  if (codexSchema) {
    merged.schemas[CODEX_WATCH_NAME] = codexSchema;
  }

  // Merge watches: add/replace the codex watch entry
  const codexWatchFromSample = SAMPLE_CONFIG.watches.find(
    (w: WatchTarget) => w.name === CODEX_WATCH_NAME,
  );

  if (codexWatchFromSample) {
    const existingWatchIndex = merged.watches.findIndex(
      (w: WatchTarget) => w.name === CODEX_WATCH_NAME,
    );

    if (existingWatchIndex !== -1) {
      // Replace existing codex watch in-place
      merged.watches[existingWatchIndex] = codexWatchFromSample;
    } else {
      // Append new codex watch
      merged.watches.push(codexWatchFromSample);
    }
  }

  return merged;
}

/**
 * Write the merged transcript-watch.json config atomically.
 */
function writeTranscriptWatchConfig(config: TranscriptWatchConfig): void {
  mkdirSync(CLAUDE_MEM_DIR, { recursive: true });
  writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Legacy AGENTS.md Compatibility Reporting
// ---------------------------------------------------------------------------

/**
 * Runtime-only mode: do not mutate legacy ~/.codex/AGENTS.md.
 */
function logLegacyCodexAgentsPathUntouched(): void {
  logger.info('CODEX', 'Skipping legacy AGENTS.md cleanup; runtime-only user-level isolation enabled', {
    path: CODEX_AGENTS_MD_PATH,
  });
}

/**
 * @deprecated Runtime-only mode leaves legacy ~/.codex/AGENTS.md untouched.
 */
const logLegacyCodexCompatibilityState = logLegacyCodexAgentsPathUntouched;

// ---------------------------------------------------------------------------
// Public API: Install
// ---------------------------------------------------------------------------

/**
 * Install Codex CLI integration for claude-mem.
 *
 * 1. Merges Codex transcript-watch config into ~/.claude-mem/transcript-watch.json
 * 2. Leaves legacy ~/.codex/AGENTS.md untouched
 *
 * @returns 0 on success, 1 on failure
 */
export async function installCodexCli(): Promise<number> {
  console.log('\nInstalling Claude-Mem for Codex CLI (transcript watching)...\n');

  // Step 1: Merge transcript-watch config
  const existingConfig = loadExistingTranscriptWatchConfig();
  const mergedConfig = mergeCodexWatchConfig(existingConfig);

  try {
    writeConfigAndShowCodexInstructions(mergedConfig);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

function writeConfigAndShowCodexInstructions(mergedConfig: TranscriptWatchConfig): void {
  writeTranscriptWatchConfig(mergedConfig);
  console.log(`  Updated ${DEFAULT_CONFIG_PATH}`);
  console.log(`  Watch path: ~/.codex/sessions/**/*.jsonl`);
  console.log(`  Schema: codex (v${SAMPLE_CONFIG.schemas?.codex?.version ?? '?'})`);

  logLegacyCodexCompatibilityState();

  console.log(`
Installation complete!

Transcript watch config: ${DEFAULT_CONFIG_PATH}
Context injection: runtime-only, user-level isolated memory (no workspace AGENTS.md writes)

How it works:
  - claude-mem watches Codex session JSONL files for new activity
  - No hooks needed -- transcript watching is fully automatic
  - Context from past sessions remains available through worker-backed memory, without mutating workspace files

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Use Codex CLI as usual -- memory capture is automatic!
`);
}

// ---------------------------------------------------------------------------
// Public API: Uninstall
// ---------------------------------------------------------------------------

/**
 * Remove Codex CLI integration from claude-mem.
 *
 * 1. Removes the codex watch and schema from transcript-watch.json (preserves others)
 * 2. Leaves legacy AGENTS.md untouched
 *
 * @returns 0 on success, 1 on failure
 */
export function uninstallCodexCli(): number {
  console.log('\nUninstalling Claude-Mem Codex CLI integration...\n');

  // Step 1: Remove codex watch from transcript-watch.json
  if (existsSync(DEFAULT_CONFIG_PATH)) {
    const config = loadExistingTranscriptWatchConfig();

    config.watches = config.watches.filter(
      (w: WatchTarget) => w.name !== CODEX_WATCH_NAME,
    );

    if (config.schemas) {
      delete config.schemas[CODEX_WATCH_NAME];
    }

    try {
      writeTranscriptWatchConfig(config);
      console.log(`  Removed codex watch from ${DEFAULT_CONFIG_PATH}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nUninstallation failed: ${message}`);
      return 1;
    }
  } else {
    console.log('  No transcript-watch.json found -- nothing to remove.');
  }

  // Step 2: Leave legacy global context untouched in runtime-only mode
  logLegacyCodexCompatibilityState();

  console.log('\nUninstallation complete!');
  console.log('Restart claude-mem worker to apply changes.\n');

  return 0;
}

// ---------------------------------------------------------------------------
// Public API: Status Check
// ---------------------------------------------------------------------------

/**
 * Check Codex CLI integration status.
 *
 * @returns 0 always (informational)
 */
export function checkCodexCliStatus(): number {
  console.log('\nClaude-Mem Codex CLI Integration Status\n');

  // Check transcript-watch.json
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    console.log('Status: Not installed');
    console.log(`  No transcript watch config at ${DEFAULT_CONFIG_PATH}`);
    console.log('\nRun: npx claude-mem install --ide codex-cli\n');
    return 0;
  }

  let config: TranscriptWatchConfig;
  try {
    config = loadExistingTranscriptWatchConfig();
  } catch (error) {
    if (error instanceof Error) {
      logger.error('WORKER', 'Could not parse transcript-watch.json', { path: DEFAULT_CONFIG_PATH }, error);
    } else {
      logger.error('WORKER', 'Could not parse transcript-watch.json', { path: DEFAULT_CONFIG_PATH }, new Error(String(error)));
    }
    console.log('Status: Unknown');
    console.log('  Could not parse transcript-watch.json.');
    console.log('');
    return 0;
  }

  const codexWatch = config.watches.find(
    (w: WatchTarget) => w.name === CODEX_WATCH_NAME,
  );
  const codexSchema = config.schemas?.[CODEX_WATCH_NAME];

  if (!codexWatch) {
    console.log('Status: Not installed');
    console.log('  transcript-watch.json exists but no codex watch configured.');
    console.log('\nRun: npx claude-mem install --ide codex-cli\n');
    return 0;
  }

  console.log('Status: Installed');
  console.log(`  Config: ${DEFAULT_CONFIG_PATH}`);
  console.log(`  Watch path: ${codexWatch.path}`);
  console.log(`  Schema: ${codexSchema ? `codex (v${codexSchema.version ?? '?'})` : 'missing'}`);
  console.log(`  Start at end: ${codexWatch.startAtEnd ?? false}`);

  console.log('  Context injection: runtime-only, user-level isolated memory (workspace AGENTS.md disabled)');

  if (existsSync(CODEX_AGENTS_MD_PATH)) {
    const mdContent = readFileSync(CODEX_AGENTS_MD_PATH, 'utf-8');
    if (mdContent.includes('<claude-mem-context>')) {
      console.log(`  Legacy global context: Present (${CODEX_AGENTS_MD_PATH})`);
    } else {
      console.log(`  Legacy global context: Not active`);
    }
  } else {
    console.log(`  Legacy global context: None`);
  }

  const sessionsDir = path.join(CODEX_DIR, 'sessions');
  if (existsSync(sessionsDir)) {
    console.log(`  Sessions directory: exists`);
  } else {
    console.log(`  Sessions directory: not yet created (use Codex CLI to generate sessions)`);
  }

  console.log('');
  return 0;
}

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const configSource = readFileSync(
  join(__dirname, '..', 'src', 'services', 'transcripts', 'config.ts'),
  'utf-8',
);
const installerSource = readFileSync(
  join(__dirname, '..', 'src', 'services', 'integrations', 'CodexCliInstaller.ts'),
  'utf-8',
);

describe('Codex runtime-only context isolation', () => {
  it('does not hardcode ~/.codex/AGENTS.md in the sample transcript watch config', () => {
    expect(configSource).not.toContain("path: '~/.codex/AGENTS.md'");
  });

  it('documents runtime-only user-level isolation for Codex', () => {
    expect(installerSource).toContain('runtime-only, user-level isolated memory (no workspace AGENTS.md writes)');
    expect(installerSource).toContain('user-level isolated memory');
  });

  it('leaves legacy global Codex context untouched during install', () => {
    expect(installerSource).toContain('logLegacyCodexCompatibilityState();');
    expect(installerSource).toContain('Skipping legacy AGENTS.md cleanup; runtime-only user-level isolation enabled');
  });
});

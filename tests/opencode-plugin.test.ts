import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

type FetchCall = {
  url: string;
  init?: RequestInit;
};

const modulePath = path.resolve(
  __dirname,
  '../src/integrations/opencode-plugin/index.ts',
);

describe('OpenCode claude-mem plugin', () => {
  let originalHome: string | undefined;
  let originalFetch: typeof fetch;
  let fetchCalls: FetchCall[];

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalFetch = globalThis.fetch;
    fetchCalls = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return {
        ok: true,
        json: async () => ({}),
        text: async () => '',
      } as Response;
    }) as typeof fetch;
  });

  async function loadPlugin() {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-opencode-'));
    const tokenDir = path.join(homeDir, '.claude-mem');
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(path.join(tokenDir, 'worker-auth-token'), 'test-token\n');
    process.env.HOME = homeDir;

    const imported = await import(`${modulePath}?cacheBust=${Date.now()}-${Math.random()}`);
    return imported.default({
      project: { name: 'opencode-test-project' },
      directory: '/tmp/opencode-project',
      worktree: '/tmp/opencode-project',
      client: {},
      serverUrl: new URL('http://127.0.0.1:4096'),
      $: {},
      experimental_workspace: { register() {} },
    });
  }

  it('initializes worker session with auth from command and chat hooks', async () => {
    const plugin = await loadPlugin();

    await plugin['command.execute.before']?.(
      { command: 'review', sessionID: 'ses_test', arguments: '--quick' },
      { parts: [] },
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe('http://127.0.0.1:37777/api/sessions/init');
    expect(fetchCalls[0]?.init?.headers).toMatchObject({
      'Content-Type': 'application/json',
    });
    expect((fetchCalls[0]?.init?.headers as Record<string, string>).Authorization).toMatch(
      /^Bearer\s+\S+$/,
    );

    await plugin['chat.message']?.(
      { sessionID: 'ses_test' },
      {
        message: {},
        parts: [
          { type: 'text', text: 'first line' },
          { type: 'reasoning', text: 'ignored' },
          { type: 'text', text: 'second line' },
        ],
      },
    );

    expect(fetchCalls).toHaveLength(1);
  });

  it('records authenticated observations after tool execution', async () => {
    const plugin = await loadPlugin();

    await plugin['tool.execute.after']?.(
      {
        tool: 'bash',
        sessionID: 'ses_tool',
        callID: 'call_1',
        args: { command: 'pwd' },
      },
      {
        title: 'pwd',
        output: '/tmp/opencode-project',
        metadata: {},
      },
    );

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]?.url).toBe('http://127.0.0.1:37777/api/sessions/init');
    expect(fetchCalls[1]?.url).toBe('http://127.0.0.1:37777/api/sessions/observations');
    expect(fetchCalls[1]?.init?.headers).toMatchObject({
      'Content-Type': 'application/json',
    });
    expect((fetchCalls[1]?.init?.headers as Record<string, string>).Authorization).toMatch(
      /^Bearer\s+\S+$/,
    );

    const observationBody = JSON.parse(String(fetchCalls[1]?.init?.body));
    expect(observationBody.tool_name).toBe('bash');
    expect(observationBody.tool_input).toEqual({ command: 'pwd' });
    expect(observationBody.cwd).toBe('/tmp/opencode-project');
  });

  it('does not expose the legacy custom tool surface', async () => {
    const plugin = await loadPlugin();
    expect(plugin.tool).toBeUndefined();
  });
});

/**
 * OpenCode Plugin for claude-mem
 *
 * Integrates claude-mem persistent memory with OpenCode.
 * Runs inside OpenCode's Bun-based plugin runtime.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface OpenCodeProject {
  name?: string;
  path?: string;
}

interface OpenCodePluginContext {
  client: unknown;
  project: OpenCodeProject;
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: unknown;
}

interface CommandExecuteBeforeInput {
  command: string;
  sessionID: string;
  arguments: string;
}

interface ChatMessageInput {
  sessionID: string;
}

interface ChatMessageOutputPart {
  type: string;
  text?: string;
}

interface ToolExecuteAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: Record<string, unknown>;
}

interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}

interface SessionInfo {
  id: string;
}

interface SessionCreatedEvent {
  type: 'session.created';
  properties: {
    info: SessionInfo;
  };
}

interface SessionDeletedEvent {
  type: 'session.deleted';
  properties: {
    info: SessionInfo;
  };
}

interface OpenCodeEventEnvelope {
  event: {
    type: string;
    properties?: Record<string, unknown>;
  };
}

const WORKER_BASE_URL = 'http://127.0.0.1:37777';
const WORKER_TOKEN_PATH = join(homedir(), '.claude-mem', 'worker-auth-token');
const MAX_TOOL_RESPONSE_LENGTH = 1000;
const MAX_SESSION_MAP_ENTRIES = 1000;

const contentSessionIdsByOpenCodeSessionId = new Map<string, string>();
const initializedSessionIds = new Set<string>();

async function getJsonHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  try {
    const token = (await readFile(WORKER_TOKEN_PATH, 'utf-8')).trim();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[claude-mem] Failed to read worker auth token: ${message}`);
  }

  return headers;
}

async function workerPost(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  let response: Response;

  try {
    response = await fetch(`${WORKER_BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('ECONNREFUSED')) {
      console.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
    }
    return null;
  }

  if (!response.ok) {
    console.warn(`[claude-mem] Worker POST ${path} returned ${response.status}`);
    return null;
  }

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getOrCreateContentSessionId(openCodeSessionId: string): string {
  if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
    while (contentSessionIdsByOpenCodeSessionId.size >= MAX_SESSION_MAP_ENTRIES) {
      const oldestKey = contentSessionIdsByOpenCodeSessionId.keys().next().value;
      if (oldestKey !== undefined) {
        contentSessionIdsByOpenCodeSessionId.delete(oldestKey);
      } else {
        break;
      }
    }

    contentSessionIdsByOpenCodeSessionId.set(
      openCodeSessionId,
      `opencode-${openCodeSessionId}-${Date.now()}`,
    );
  }

  return contentSessionIdsByOpenCodeSessionId.get(openCodeSessionId)!;
}

export const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  const projectName = ctx.project?.name || 'opencode';
  const jsonHeaders = await getJsonHeaders();

  async function ensureSessionInitialized(
    sessionID: string,
    prompt = '',
  ): Promise<string> {
    const contentSessionId = getOrCreateContentSessionId(sessionID);

    if (initializedSessionIds.has(sessionID)) {
      return contentSessionId;
    }

    const result = await workerPost(
      '/api/sessions/init',
      {
        contentSessionId,
        project: projectName,
        prompt,
        platform_source: 'opencode',
      },
      jsonHeaders,
    );

    if (result !== null) {
      initializedSessionIds.add(sessionID);
    }

    return contentSessionId;
  }

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  return {
    async event({ event }: OpenCodeEventEnvelope): Promise<void> {
      switch (event.type) {
        case 'session.created': {
          const createdEvent = event as SessionCreatedEvent;
          await ensureSessionInitialized(createdEvent.properties.info.id);
          break;
        }

        case 'session.deleted': {
          const deletedEvent = event as SessionDeletedEvent;
          const sessionID = deletedEvent.properties.info.id;
          const contentSessionId = contentSessionIdsByOpenCodeSessionId.get(sessionID);

          if (!contentSessionId) break;

          await workerPost(
            '/api/sessions/complete',
            { contentSessionId },
            jsonHeaders,
          );

          contentSessionIdsByOpenCodeSessionId.delete(sessionID);
          initializedSessionIds.delete(sessionID);
          break;
        }
      }
    },

    async 'command.execute.before'(
      input: CommandExecuteBeforeInput,
      _output: { parts: unknown[] },
    ): Promise<void> {
      const prompt = input.arguments
        ? `${input.command} ${input.arguments}`.trim()
        : input.command;

      await ensureSessionInitialized(input.sessionID, prompt);
    },

    async 'chat.message'(
      input: ChatMessageInput,
      output: { message: unknown; parts: ChatMessageOutputPart[] },
    ): Promise<void> {
      const prompt = (output.parts || [])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text?.trim() || '')
        .filter(Boolean)
        .join('\n')
        .trim();

      await ensureSessionInitialized(input.sessionID, prompt);
    },

    async 'tool.execute.after'(
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> {
      const contentSessionId = await ensureSessionInitialized(input.sessionID);

      let toolResponseText = output.output || '';
      if (toolResponseText.length > MAX_TOOL_RESPONSE_LENGTH) {
        toolResponseText = toolResponseText.slice(0, MAX_TOOL_RESPONSE_LENGTH);
      }

      await workerPost(
        '/api/sessions/observations',
        {
          contentSessionId,
          tool_name: input.tool,
          tool_input: input.args || {},
          tool_response: toolResponseText,
          cwd: ctx.directory,
        },
        jsonHeaders,
      );
    },
  };
};

export default ClaudeMemPlugin;

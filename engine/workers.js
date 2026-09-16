import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fingerprint } from './ids.js';
import { CodexCliWorker } from './codex.js';
import { ClaudeCliWorker } from './claude.js';
import { OllamaWorker } from './ollama.js';
import { ExternalHarnessWorker } from './external-harness.js';

export class IsolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IsolationError';
  }
}

export function claimWorkspace({ root, runId, taskId, agentId, now }) {
  const dir = resolve(root, runId, taskId);
  mkdirSync(dir, { recursive: true });
  const ownerPath = join(dir, 'OWNER');
  const claim = { agentId, taskId, runId, claimedAt: now };
  if (existsSync(ownerPath)) {
    const existing = JSON.parse(readFileSync(ownerPath, 'utf8'));
    if (existing.agentId !== agentId || existing.taskId !== taskId) {
      throw new IsolationError(
        `Workspace ${runId}/${taskId} is owned by ${existing.agentId}; ${agentId} cannot claim it`,
      );
    }
  } else {
    writeFileSync(ownerPath, `${JSON.stringify(claim, null, 2)}\n`, 'utf8');
  }
  return {
    dir,
    owner: claim,
    write(relative, content) {
      const target = resolve(dir, relative);
      const rootWithSep = dir.endsWith(sep) ? dir : `${dir}${sep}`;
      if (target !== dir && !target.startsWith(rootWithSep)) {
        throw new IsolationError(`Refusing write outside workspace: ${relative}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      const body = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
      writeFileSync(target, body, 'utf8');
      return target;
    },
    read(relative) {
      const target = resolve(dir, relative);
      const rootWithSep = dir.endsWith(sep) ? dir : `${dir}${sep}`;
      if (target !== dir && !target.startsWith(rootWithSep)) {
        throw new IsolationError(`Refusing read outside workspace: ${relative}`);
      }
      return readFileSync(target, 'utf8');
    },
  };
}

export class LocalDeterministicWorker {
  id = 'local';
  label = 'Deterministic local worker';

  async execute(task, ctx) {
    const seed = fingerprint(`${task.kind}|${task.title}|${ctx.goal?.prompt || ''}|${task.branch || ''}`);
    const confidence = 0.42 + (parseInt(seed.slice(0, 2), 16) / 255) * 0.4;
    const workspace = ctx.workspace;

    if (task.kind === 'intake') {
      const interpretation = {
        prompt: ctx.goal.prompt,
        ambiguities: ctx.goal.ambiguities,
        questions: ctx.goal.questions,
        planTitle: ctx.goal.plan?.title,
      };
      workspace.write('interpretation.json', interpretation);
      return {
        status: 'succeeded',
        summary: 'Stored the original prompt and the reviewable plan.',
        artifacts: ['interpretation.json'],
      };
    }

    if (task.kind === 'research') {
      const finding = {
        type: 'supported',
        claim: `${task.title}: a bounded reading of the objective is internally consistent under the stated assumptions.`,
        confidence: Number(confidence.toFixed(2)),
        sources: ctx.goal.contextPaths.length
          ? ctx.goal.contextPaths.map((path, index) => ({ id: `CTX-${index + 1}`, path }))
          : [{ id: 'PROMPT', path: 'goal.prompt' }],
      };
      workspace.write('finding.json', finding);
      ctx.recordEvidence({
        type: finding.type,
        claim: finding.claim,
        confidence: finding.confidence,
        sources: finding.sources,
        artifact: 'finding.json',
      });
      return { status: 'succeeded', summary: finding.claim, artifacts: ['finding.json'] };
    }

    if (task.kind === 'critique') {
      const finding = {
        type: 'conflict',
        claim: 'An unmatched boundary condition remains: the current evidence does not test the claim under a shifted timing or source constraint.',
        confidence: Number((Math.max(0.3, confidence - 0.12)).toFixed(2)),
        sources: [{ id: 'BRANCH-CROSS', path: 'workspace/findings' }],
      };
      workspace.write('critique.json', finding);
      ctx.recordEvidence({
        type: finding.type,
        claim: finding.claim,
        confidence: finding.confidence,
        sources: finding.sources,
        artifact: 'critique.json',
      });
      return { status: 'succeeded', summary: finding.claim, artifacts: ['critique.json'] };
    }

    if (task.kind === 'synthesis') {
      const decision = ctx.synthesize();
      workspace.write('decision.json', decision);
      return { status: 'succeeded', summary: decision.conclusion, artifacts: ['decision.json'] };
    }

    if (task.kind === 'retrospective') {
      const retro = ctx.writeRetrospective();
      workspace.write('retrospective.json', retro);
      return { status: 'succeeded', summary: retro.whatFailed, artifacts: ['retrospective.json'] };
    }

    if (task.kind === 'adopt') {
      const applied = ctx.applyApprovedProposal();
      workspace.write('adoption.json', applied);
      return { status: 'succeeded', summary: applied.summary, artifacts: ['adoption.json'] };
    }

    workspace.write('output.json', { task: task.title, seed });
    return { status: 'succeeded', summary: `Completed ${task.title}`, artifacts: ['output.json'] };
  }
}

// Not a research worker: it only applies a proposal an operator already approved.
export class EngineActionWorker {
  id = 'engine';
  label = 'Engine proposal applier';

  async execute(task, ctx) {
    if (task.kind !== 'adopt') {
      return { status: 'failed', retryable: false, error: 'The engine executor only applies approved proposals' };
    }
    const applied = ctx.applyApprovedProposal();
    ctx.workspace.write('adoption.json', applied);
    return { status: 'succeeded', summary: applied.summary, artifacts: ['adoption.json'] };
  }
}

export class DisabledLiveWorker {
  constructor({ id, label, reason }) {
    this.id = id;
    this.label = label;
    this.reason = reason;
  }

  async execute() {
    return {
      status: 'failed',
      summary: this.reason,
      skipped: true,
      error: this.reason,
    };
  }
}

export class ApiWorker {
  id = 'api';
  label = 'Generic HTTP worker';

  async execute() {
    return {
      status: 'failed',
      skipped: true,
      error: 'Generic HTTP API worker is a typed boundary. Live OAuth for arbitrary APIs is unsupported in this MVP. Configure local work or a fixed external-harness adapter instead.',
      summary: 'Unsupported live API execution',
    };
  }
}

export function createWorkerRegistry({
  codex: codexConfig = null,
  claude: claudeConfig = null,
  ollama: ollamaConfig = null,
  command: commandConfig = null,
  adapters = null,
} = {}) {
  const local = new LocalDeterministicWorker();
  const api = new ApiWorker();
  const engine = new EngineActionWorker();
  const configured = (id, legacy) => {
    const value = adapters && Object.prototype.hasOwnProperty.call(adapters, id) ? adapters[id] : legacy;
    if (!value || value === false || value.enabled === false) return null;
    return value.config && typeof value.config === 'object' ? value.config : value;
  };
  const codex = configured('codex', codexConfig)
    ? new CodexCliWorker(configured('codex', codexConfig))
    : new DisabledLiveWorker({
      id: 'codex',
      label: 'Codex',
      reason: 'Live Codex execution is not enabled. Start the engine with AOS_EXECUTION=codex to run workers through the Codex CLI ChatGPT login.',
    });
  const claude = configured('claude', claudeConfig)
    ? new ClaudeCliWorker(configured('claude', claudeConfig))
    : new DisabledLiveWorker({
      id: 'claude',
      label: 'Claude Code',
      reason: 'Live Claude Code execution is not enabled. Configure a Claude account-session adapter and pass preflight before dispatch.',
    });
  const ollamaEntry = adapters && Object.prototype.hasOwnProperty.call(adapters, 'ollama') ? adapters.ollama : ollamaConfig;
  const ollamaExplicit = Boolean(ollamaEntry && ollamaEntry !== false && ollamaEntry.enabled === true);
  const ollama = ollamaExplicit && configured('ollama', ollamaConfig)
    ? new OllamaWorker(configured('ollama', ollamaConfig))
    : new DisabledLiveWorker({
      id: 'ollama',
      label: 'Ollama',
      reason: 'Local Ollama execution is not enabled. Use AOS_EXECUTION=mixed with AOS_OLLAMA_ENABLED=1 and an explicit AOS_OLLAMA_MODEL; there is no fallback.',
    });
  const commandEntry = adapters && Object.prototype.hasOwnProperty.call(adapters, 'command') ? adapters.command : commandConfig;
  const commandExplicit = Boolean(commandEntry && commandEntry !== false && commandEntry.enabled === true);
  const command = commandExplicit && configured('command', commandConfig)
    ? new ExternalHarnessWorker(configured('command', commandConfig))
    : new DisabledLiveWorker({
      id: 'command',
      label: 'External harness (protocol)',
      reason: 'External harness execution is disabled. Configure the fixed external-harness JSON protocol; task-provided commands are unsupported.',
    });
  const grok = new DisabledLiveWorker({
    id: 'grok',
    label: 'Grok',
    reason: 'Live Grok API execution is not enabled. Presence of XAI_API_KEY is detected without reading the value; the worker still will not call the API unless explicitly implemented later.',
  });
  return new Map([
    [local.id, local],
    [command.id, command],
    [api.id, api],
    [engine.id, engine],
    [codex.id, codex],
    [claude.id, claude],
    [ollama.id, ollama],
    [grok.id, grok],
  ]);
}

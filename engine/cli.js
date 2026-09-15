import { AosEngine } from './engine.js';
import { preflightCodex, resolveCodexConfig } from './codex.js';
import { readFileSync } from 'node:fs';
import { apiActions } from './api.js';

export const HELP = `AOS — local agentic coordination

Usage:
  aos serve [--port 7740] [--data DIR]
  aos status
  aos providers
  aos live preflight
  aos project create <name>
  aos goal create "<prompt>" [--context PATH]
  aos goal show <id>
  aos goal answer <goalId> <questionId> "<answer>"
  aos goals
  aos run start <goalId> [--concurrency N] [--blueprint ID]
  aos runs
  aos run show <id>
  aos tree <runId>
  aos inspect <taskId>
  aos events <runId> [--limit N]
  aos advance <runId> [--until-idle]
  aos cancel <runId>
  aos pause <runId>
  aos resume <runId>
  aos findings [runId]
  aos decision [runId]
  aos improvements [runId]
  aos approve <proposalId>
  aos reject <proposalId>

System access (every command below is also an HTTP route under /api/v1; same validation):
  aos settings manifest | diagnostics | list [--scope S --scope-id ID] | get <key> --scope S [--scope-id ID]
  aos settings effective <key> [--project ID --blueprint ID --preset ID --agent ID --run ID]
  aos settings set <key> <value> --scope S [--scope-id ID] | unset <key> --scope S [--scope-id ID]
  aos settings validate <key> <value> | preview <key> <value> --scope S [--scope-id ID] | export [--scope S] | import --file F
  aos preset list [--role R] | show <id> [--version N] | history <id> | effective <id> | preview <id> [--var k=v ...]
  aos preset create --json J | --file F | edit <id> --json J | fork <id> <newId> | archive <id> [--version N] | restore <id>
  aos preset validate --json J | export [--builtin] | import --file F
  aos template list | show <id> | history <id> | create --json J | edit <id> --json J | fork <id> <newId> | archive <id> | restore <id>
  aos template validate --json J | from-task <taskId> <newId> [--name N] | export | import --file F
  aos blueprint list | show <id> | history <id> | effective <id> | estimate <id> [--depth N] | create --json J | edit <id> --json J
  aos blueprint fork <id> <newId> | archive <id> | restore <id> | validate --json J | export | import --file F
  aos memory stats | policy [--scope S --scope-id ID] | policy set --json J [--scope S --scope-id ID]
  aos memory search [--scope S --namespace NS --query Q --tags a,b --limit N] | show <id> | add <scope> <namespace> --json J
  aos memory correct <id> --json J | commit <id> | pin <id> | unpin <id> | forget <id> [--reason R] | promote <id> <toScope>
  aos memory clear <scope> <namespace> [--confirm] | retention | export <scope> <namespace> | import --file F [--scope S --namespace NS]
  aos run patch <runId> <key> <value> [--reason R] | run patches <runId>
  Values are parsed as JSON when they parse, otherwise as strings. Output is JSON.

Live execution (off by default):
  AOS_EXECUTION=codex runs worker tasks through \`codex exec\` on the ChatGPT
  account login. Only gpt-5.6-luna at effort max is accepted, at most 4 workers
  run at once, and nothing falls back to another worker or model.
  AOS_CODEX_TIMEOUT_MS  per-attempt timeout   AOS_REPO_ROOT  read-only repo for workers

Dashboard and CLI share the same .aos store. Secrets are never printed.
`;

export function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--until-idle') flags.untilIdle = true;
    else if (token.startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      const name = token.slice(2);
      // A repeated flag collects its values (for example several --var k=v pairs).
      flags[name] = flags[name] === undefined ? argv[i + 1] : [].concat(flags[name], argv[i + 1]);
      i += 1;
    } else if (token.startsWith('--')) {
      flags[token.slice(2)] = true;
    } else {
      args.push(token);
    }
  }
  return { args, flags };
}

export async function executeCommand(engine, input) {
  const tokens = tokenize(input);
  if (!tokens.length) return { ok: true, lines: [] };
  try {
    const lines = await dispatch(engine, tokens);
    return { ok: true, lines };
  } catch (error) {
    return { ok: false, lines: [`error: ${error.message}`] };
  }
}

export async function dispatch(engine, argv) {
  engine.sync();
  const { args, flags } = parseArgs(argv);
  const [cmd, sub, ...rest] = args;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return HELP.trim().split('\n');
  if (cmd === 'status') return statusLines(engine);
  if (cmd === 'providers') {
    return engine.listProviders().map((item) =>
      `${item.id.padEnd(10)} ${item.authType.padEnd(16)} enabled=${item.liveExecutionEnabled} secret=${item.secretPresent ? 'present' : 'absent'}  ${item.note}`,
    );
  }
  if (cmd === 'live' && sub === 'preflight') {
    const config = engine.execution.codex || resolveCodexConfig({});
    const result = await preflightCodex(config);
    return [
      `codex     ${result.codexBin}`,
      `version   ${result.cliVersion}`,
      `login     ${result.login}`,
      `auth      ${result.authPath}`,
      `model     ${result.model.slug}  efforts=${result.model.efforts.join(',')}  upgrade=${result.model.upgrade ?? 'none'}`,
      `requested ${result.requested.model} / ${result.requested.effort}`,
      `env       stripped ${result.strippedEnv.length ? result.strippedEnv.join(', ') : 'nothing (no API-key variables present)'}`,
      `execution ${engine.live ? 'live codex' : 'local (set AOS_EXECUTION=codex to enable live workers)'}`,
    ];
  }
  if (cmd === 'events') return eventLines(engine, sub || rest[0], Number(flags.limit) || 60);
  if (cmd === 'project' && sub === 'create') {
    const project = engine.createProject({ name: rest.join(' ') || flags.name });
    return [`created ${project.id}  ${project.name}`];
  }
  if (cmd === 'goal' && sub === 'create') {
    const prompt = rest.join(' ') || flags.prompt;
    if (!prompt) throw new Error('goal create requires a prompt');
    const contextPaths = flags.context ? [flags.context] : [];
    const goal = engine.createGoal({ prompt, contextPaths });
    return [
      `goal ${goal.id}`,
      `status  ${goal.status}`,
      `prompt  ${goal.prompt}`,
      `ambiguities  ${goal.ambiguities.length}`,
      ...goal.questions.map((question) => `question  ${question.id}  ${question.prompt}`),
      `plan tasks  ${goal.plan.tasks.length}`,
      ...goal.plan.tasks.map((task) => `  - ${task.kind.padEnd(14)} ${task.title}`),
    ];
  }
  if (cmd === 'goal' && sub === 'answer') {
    const [goalId, questionId, ...answerParts] = rest;
    if (!goalId || !questionId || !answerParts.length) {
      throw new Error('goal answer requires a goal id, question id, and answer');
    }
    const goal = engine.answerQuestions(goalId, [{ id: questionId, answer: answerParts.join(' ') }]);
    const remaining = goal.questions.filter((question) => question.required && !String(question.answer || '').trim()).length;
    return [`goal ${goal.id}`, `status  ${goal.status}`, `remaining required  ${remaining}`];
  }
  if (cmd === 'goal' && sub === 'show') return goalLines(engine.getGoal(subArg(sub, rest, 'goal id')));
  if (cmd === 'goals') {
    return engine.state.goals.map((goal) => `${goal.id}  ${goal.status}  ${truncate(goal.prompt, 72)}`);
  }
  if ((cmd === 'run' && sub === 'start') || cmd === 'start') {
    const goalId = cmd === 'start' ? sub : rest[0];
    if (!goalId) throw new Error('run start requires a goal id');
    const maxConcurrency = flags.concurrency != null ? Number(flags.concurrency) : undefined;
    const run = engine.startRun({ goalId, maxConcurrency, blueprintId: flags.blueprint || null });
    return [`run ${run.id}  ${run.status}  goal ${run.goalId}  concurrency ${run.maxConcurrency ?? 'unbounded'}  execution ${run.execution.mode}${run.blueprint ? `  blueprint ${run.blueprint.id}@${run.blueprint.version}` : ''}`];
  }
  if (cmd === 'runs') {
    return engine.listRuns().map((run) => `${run.id}  ${run.status}  ${truncate(run.objective, 64)}`);
  }
  if (cmd === 'run' && sub === 'show') return runLines(engine, subArg(sub, rest, 'run id'));
  if (cmd === 'tree') return treeLines(engine, sub || rest[0]);
  if (cmd === 'inspect') return inspectLines(engine, sub || rest[0]);
  if (cmd === 'advance') {
    const runId = sub || rest[0];
    const result = await engine.advanceRun(runId, { untilIdle: flags.untilIdle !== false });
    return [`run ${result.run.id}  ${result.run.status}  steps=${result.executed}  idle=${result.idle}`];
  }
  if (cmd === 'cancel') return [`cancelled ${engine.cancelRun(sub || rest[0]).id}`];
  if (cmd === 'pause') return [`paused ${engine.pauseRun(sub || rest[0]).id}`];
  if (cmd === 'resume') return [`resumed ${engine.resumeRun(sub || rest[0]).id}`];
  if (cmd === 'findings') return findingsLines(engine, sub || rest[0] || engine.listRuns()[0]?.id);
  if (cmd === 'decision') return decisionLines(engine, sub || rest[0] || engine.listRuns()[0]?.id);
  if (cmd === 'improvements') return proposalLines(engine, sub || rest[0]);
  if (cmd === 'approve') {
    const proposal = engine.approveProposal(sub || rest[0]);
    // Memory and other run-less proposals are applied by the approval itself; only run proposals advance a run.
    if (!proposal.runId) return [`approved ${proposal.id}`, `applied ${proposal.applied === true}`];
    const advanced = await engine.advanceRun(proposal.runId, { untilIdle: true });
    return [`approved ${proposal.id}`, `run ${advanced.run.id}  ${advanced.run.status}`];
  }
  if (cmd === 'reject') {
    const proposal = engine.rejectProposal(sub || rest[0]);
    return [`rejected ${proposal.id}`];
  }
  const resourceResult = await resourceCommand(engine, cmd, sub, rest, flags);
  if (resourceResult !== undefined) return resourceResult;
  throw new Error(`unknown command: ${argv.join(' ')}`);
}

const RESOURCE_BY_COMMAND = { settings: 'settings', preset: 'presets', template: 'templates', blueprint: 'blueprints', memory: 'memory' };

function jsonValue(text) {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function inputFrom(flags) {
  if (flags.file) return JSON.parse(readFileSync(String(flags.file), 'utf8'));
  if (flags.json) return typeof flags.json === 'string' ? JSON.parse(flags.json) : flags.json;
  return undefined;
}

function pretty(value) {
  return JSON.stringify(value, null, 2).split('\n');
}

// Maps CLI positionals and flags onto the same action params HTTP uses.
async function resourceCommand(engine, cmd, action, rest, flags) {
  const actions = apiActions(engine);
  const common = { scope: flags.scope, scopeId: flags['scope-id'], version: flags.version, actor: flags.actor, reason: flags.reason, name: flags.name };
  if (cmd === 'run' && (action === 'patch' || action === 'patches')) {
    const [runId, key, value] = rest;
    return pretty(action === 'patch' ? actions.runs.patch({ ...common, runId, key, value: jsonValue(value) }) : actions.runs.patches({ runId }));
  }
  const resource = RESOURCE_BY_COMMAND[cmd];
  if (!resource || !action) return undefined;
  const api = actions[resource];
  const [first, second, third] = rest;
  let params;
  if (resource === 'settings') {
    params = {
      manifest: () => ({}), diagnostics: () => ({}), list: () => ({ ...common }),
      get: () => ({ ...common, key: first }), effective: () => ({ key: first, projectId: flags.project, blueprintId: flags.blueprint, presetId: flags.preset, agentId: flags.agent, runId: flags.run }),
      set: () => ({ ...common, key: first, value: jsonValue(second) }), unset: () => ({ ...common, key: first }),
      validate: () => ({ key: first, value: jsonValue(second) }), preview: () => ({ ...common, key: first, value: jsonValue(second) }),
      export: () => ({ scope: flags.scope ?? null }), import: () => ({ payload: inputFrom(flags), actor: flags.actor }),
    }[action]?.();
  } else if (resource === 'memory') {
    if (action === 'policy' && first === 'set') params = { ...common, value: inputFrom(flags) };
    else params = {
      stats: () => ({}), policy: () => ({ ...common }), retention: () => ({}),
      search: () => ({ scope: flags.scope ?? null, namespace: flags.namespace ?? null, query: flags.query ?? '', tags: flags.tags ? String(flags.tags).split(',') : [], limit: flags.limit, includeProposed: Boolean(flags.proposed), includeInactive: Boolean(flags.inactive) }),
      show: () => ({ id: first }), add: () => ({ ...common, scope: first, namespace: second, input: inputFrom(flags) }), correct: () => ({ ...common, id: first, input: inputFrom(flags) }),
      commit: () => ({ ...common, id: first }), pin: () => ({ ...common, id: first }), unpin: () => ({ ...common, id: first }), forget: () => ({ ...common, id: first }),
      promote: () => ({ ...common, id: first, toScope: second }), clear: () => ({ ...common, scope: first, namespace: second, confirm: Boolean(flags.confirm) }),
      export: () => ({ scope: first, namespace: second, includeInactive: Boolean(flags.inactive) }), import: () => ({ payload: inputFrom(flags), scope: flags.scope ?? null, namespace: flags.namespace ?? null, actor: flags.actor }),
    }[action]?.();
    if (action === 'policy' && first === 'set') action = 'setPolicy';
  } else {
    const variables = {};
    for (const pair of [].concat(flags.var || [])) { const [key, ...valueParts] = String(pair).split('='); variables[key] = jsonValue(valueParts.join('=')); }
    params = {
      list: () => ({ includeArchived: Boolean(flags.archived), role: flags.role ?? null }), get: () => ({ id: first, version: flags.version }), show: () => ({ id: first, version: flags.version }),
      history: () => ({ id: first }), effective: () => ({ id: first, version: flags.version }), preview: () => ({ id: first, version: flags.version, variables }),
      estimate: () => ({ id: first, version: flags.version, depth: flags.depth }), create: () => ({ input: inputFrom(flags) }), edit: () => ({ id: first, input: inputFrom(flags) }),
      fork: () => ({ ...common, id: first, newId: second }), archive: () => ({ id: first, version: flags.version }), restore: () => ({ id: first }), validate: () => ({ input: inputFrom(flags) }),
      'from-task': () => ({ ...common, taskId: first, newId: second, description: flags.description }), export: () => ({ includeBuiltin: Boolean(flags.builtin), ids: flags.ids ? String(flags.ids).split(',') : null }),
      import: () => ({ payload: inputFrom(flags), actor: flags.actor }),
    }[action]?.();
    if (action === 'show') action = 'get';
    if (action === 'from-task') action = 'fromTask';
  }
  if (params === undefined || typeof api[action] !== 'function') throw new Error(`unknown ${cmd} action: ${action || '(none)'}`);
  const result = await api[action](params);
  if (action === 'preview' && resource === 'presets') return String(result.text).split('\n');
  return pretty(result === undefined ? { ok: true } : result);
}

export function loadEngineFromEnv({ dataDir, concurrency, execution } = {}) {
  const dir = dataDir || process.env.AOS_HOME || `${process.cwd()}/.aos`;
  const engine = new AosEngine({
    dataDir: dir,
    concurrency: concurrency ?? numberOr(process.env.AOS_CONCURRENCY, 2),
    execution: execution ?? executionFromEnv(),
  });
  engine.load();
  return engine;
}

export function executionFromEnv(env = process.env) {
  const mode = env.AOS_EXECUTION || 'local';
  if (mode === 'local') return { mode: 'local' };
  if (mode !== 'codex') throw new Error(`AOS_EXECUTION must be "local" or "codex"; got "${mode}"`);
  return {
    mode: 'codex',
    codex: {
      model: env.AOS_CODEX_MODEL || undefined,
      effort: env.AOS_CODEX_EFFORT || undefined,
      maxConcurrency: env.AOS_CODEX_MAX_CONCURRENCY ? Number(env.AOS_CODEX_MAX_CONCURRENCY) : undefined,
      timeoutMs: env.AOS_CODEX_TIMEOUT_MS ? Number(env.AOS_CODEX_TIMEOUT_MS) : undefined,
      repoRoot: env.AOS_REPO_ROOT || process.cwd(),
    },
  };
}

function statusLines(engine) {
  const snap = engine.snapshot();
  const run = snap.run;
  return [
    `project  ${snap.project?.id}  ${snap.project?.name}`,
    `goals    ${snap.goals.length}`,
    `runs     ${snap.runs.length}`,
    run ? `current  ${run.id}  ${run.status}` : 'current  none',
    `providers  ${snap.providers.filter((item) => item.liveExecutionEnabled).map((item) => item.id).join(', ') || 'none enabled'}`,
    'auth  secrets are never printed; see `aos providers`',
  ];
}

function goalLines(goal) {
  return [
    `goal ${goal.id}`,
    `status  ${goal.status}`,
    `prompt  ${goal.prompt}`,
    `ambiguities`,
    ...goal.ambiguities.map((item) => `  - ${item.code}  ${item.detail}`),
    `questions`,
    ...goal.questions.map((item) => `  - ${item.id}  ${item.required ? '[required]  ' : ''}${item.prompt}${item.answer ? `  → ${item.answer}` : ''}`),
    `plan`,
    ...goal.plan.tasks.map((task) => `  - ${task.id}  ${task.kind}  ${task.title}`),
  ];
}

function runLines(engine, runId) {
  const tree = engine.getRunTree(runId);
  return [
    `run ${tree.run.id}  ${tree.run.status}`,
    `objective  ${tree.run.objective}`,
    ...flattenTree(tree.roots, 0).map((line) => line),
  ];
}

function treeLines(engine, runId) {
  if (!runId) throw new Error('tree requires a run id');
  return flattenTree(engine.getRunTree(runId).roots, 0);
}

function flattenTree(nodes, depth) {
  const lines = [];
  for (const node of nodes) {
    const indent = '  '.repeat(depth);
    lines.push(`${indent}${node.id}  ${node.status.padEnd(18)} ${node.kind.padEnd(14)} ${node.title}`);
    lines.push(...flattenTree(node.children || [], depth + 1));
  }
  return lines;
}

function inspectLines(engine, taskId) {
  if (!taskId) throw new Error('inspect requires a task id');
  const task = engine.getTask(taskId);
  const agent = engine.state.agents.find((item) => item.id === task.agentId);
  const evidence = engine.state.evidence.filter((item) => item.taskId === task.id);
  return [
    `task ${task.id}`,
    `title     ${task.title}`,
    `status    ${task.status}`,
    `kind      ${task.kind}`,
    `worker    ${task.worker}`,
    `attempts  ${task.attempts}`,
    `workspace ${task.workspace || 'unclaimed'}`,
    `agent     ${agent ? `${agent.id}  ${agent.status}` : 'none'}`,
    `output    ${task.output?.summary || '—'}`,
    `error     ${task.error || '—'}`,
    `evidence  ${evidence.length}`,
    ...(task.runtime || []).map((item) => {
      if (item.injected) return `attempt ${item.attempt}  injected fault, no process spawned  ${item.error || ''}`;
      const effective = item.effective ? `${item.effective.model}/${item.effective.effort} plan=${item.effective.planType ?? '?'}` : 'unverified';
      return `attempt ${item.attempt}  ${item.provider} requested=${item.requested?.model}/${item.requested?.effort} effective=${effective} verified=${item.verified} thread=${item.threadId || '—'} exit=${item.exitCode} ${item.durationMs ?? '?'}ms`;
    }),
  ];
}

function eventLines(engine, runId, limit) {
  if (!runId) throw new Error('events requires a run id');
  const keys = new Map(engine.state.tasks.filter((task) => task.runId === runId).map((task) => [task.id, task.key || task.title]));
  return engine.store.readEventLog()
    .filter((item) => item.runId === runId)
    .slice(-limit)
    .map((item) => {
      const detail = item.payload?.error || item.payload?.threadId || item.payload?.reason || '';
      const attempt = item.payload?.attempt ? ` #${item.payload.attempt}` : '';
      return `${item.ts}  ${item.type.padEnd(28)} ${(keys.get(item.taskId) || '').padEnd(10)}${attempt}  ${truncate(detail, 80)}`;
    });
}

function findingsLines(engine, runId) {
  if (!runId) return ['no run'];
  const evidence = engine.state.evidence.filter((item) => item.runId === runId);
  if (!evidence.length) return ['no evidence'];
  return evidence.map((item) => `${item.id}  ${item.type.padEnd(10)}  ${truncate(item.claim, 80)}`);
}

function decisionLines(engine, runId) {
  if (!runId) return ['no run'];
  const decision = engine.getDecision(runId);
  if (!decision) return ['no decision recorded'];
  return [
    `decision ${decision.id}`,
    `conclusion  ${decision.conclusion}`,
    `objection   ${decision.objection}`,
    `confidence  ${Number(decision.confidence).toFixed(2)}`,
    ...decision.checks.map((check) => `check  ${check.name}  ${check.status}`),
  ];
}

function proposalLines(engine, runId) {
  const proposals = engine.listProposals(runId);
  if (!proposals.length) return ['no proposals'];
  return proposals.map((item) => `${item.id}  ${item.status.padEnd(10)}  ${item.title}  — ${item.change}`);
}

function subArg(sub, rest, label) {
  const value = rest[0];
  if (!value) throw new Error(`${label} required`);
  return value;
}

// Splits a command line into argv. Quoted segments stay together, and a JSON object or
// array argument ({...} or [...]) is one token even when it contains spaces.
function tokenize(input) {
  const text = String(input || '').trim();
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = text.indexOf(ch, index + 1);
      if (end === -1) {
        tokens.push(text.slice(index + 1));
        break;
      }
      tokens.push(text.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      let depth = 0;
      let inString = false;
      let end = index;
      for (; end < text.length; end += 1) {
        const current = text[end];
        if (inString) {
          if (current === '\\') end += 1;
          else if (current === '"') inString = false;
          continue;
        }
        if (current === '"') inString = true;
        else if (current === '{' || current === '[') depth += 1;
        else if (current === '}' || current === ']') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      tokens.push(text.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    let end = index;
    while (end < text.length && !/\s/.test(text[end])) end += 1;
    tokens.push(text.slice(index, end));
    index = end;
  }
  return tokens;
}

function truncate(text, length) {
  const value = String(text || '').replace(/\s+/g, ' ');
  return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

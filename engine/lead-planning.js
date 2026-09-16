import { fingerprint, newId } from './ids.js';
import { claimWorkspace } from './workers.js';
import { CODEX_AUTH_PATH, redactText, resolveCodexConfig } from './codex.js';
import { ROLE_RUNTIME_PROFILES } from './role-runtime.js';
import { AosError, notFound } from './schema.js';
import {
  LEAD_PLANNING_OUTPUT_SCHEMA,
  LEAD_PLANNING_LIMITS,
  LEAD_PLANNING_SCHEMA_VERSION,
  buildLeadPlanningPrompt,
  normalizeLeadPlan,
  normalizeLeadPlanOutput,
} from './lead-planning-schema.js';

const MODEL = ROLE_RUNTIME_PROFILES.manager.model;
const EFFORT = ROLE_RUNTIME_PROFILES.manager.effort;
const SANDBOX = 'read-only';

export const LEAD_PLAN_STATUS = Object.freeze({
  generating: 'generating',
  proposed: 'proposed',
  needs_clarification: 'needs_clarification',
  accepted: 'accepted',
  rejected: 'rejected',
  failed: 'failed',
  interrupted: 'interrupted',
});

const LEAD_PLAN_STATUSES = new Set(Object.values(LEAD_PLAN_STATUS));
const ACTIVE_STATUSES = new Set([
  LEAD_PLAN_STATUS.generating,
  LEAD_PLAN_STATUS.proposed,
  LEAD_PLAN_STATUS.needs_clarification,
]);
const RECEIPT_FORBIDDEN_KEYS = new Set(['command', 'cwd', 'transcript', 'stdout', 'stderr']);
const MAX_USAGE_KEYS = 32;
const MAX_USAGE_DEPTH = 4;
const MAX_USAGE_ARRAY_ITEMS = 32;
const MAX_USAGE_STRING_LENGTH = 500;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function leadPlanFingerprint(plan) {
  return fingerprint(stableStringify(plan));
}

function leadInputFingerprint(goal, derivedFromProposalId) {
  return fingerprint(stableStringify({
    goalId: goal.id,
    prompt: goal.prompt,
    contextPaths: goal.contextPaths || [],
    questions: (goal.questions || []).map((question) => ({
      id: question.id,
      prompt: question.prompt,
      reason: question.reason || null,
      required: question.required !== false,
      answer: question.answer || null,
    })),
    derivedFromProposalId: derivedFromProposalId || null,
  }));
}

function leadError(code, message, statusCode = 409, details = null) {
  return new AosError(code, message, { statusCode, details });
}

function normalizeOptions(goalOrOptions, options = {}) {
  if (typeof goalOrOptions === 'string') return { ...options, goalId: goalOrOptions };
  return goalOrOptions || {};
}

function requestId(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 128) {
    throw leadError('lead_plan_request_id_required', 'requestId must be a nonblank string of at most 128 characters', 400, { field: 'requestId' });
  }
  return value.trim();
}

function derivedId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 128) {
    throw leadError('lead_plan_derived_invalid', 'derivedFromProposalId must be a nonblank proposal id', 400, { field: 'derivedFromProposalId' });
  }
  return value.trim();
}

function plannerOutput(result) {
  if (result?.result && typeof result.result === 'object') return result.result;
  if (result?.output && typeof result.output === 'object') return result.output;
  if (!result || typeof result !== 'object') return result;
  // An injected planner may return runtime evidence alongside the wire output.
  // Remove only the execution envelope so unsupported planner fields still fail closed.
  const candidate = { ...result };
  for (const key of ['runtime', 'evidence', 'verified', 'requested', 'effective', 'provider', 'authPath', 'threadId', 'error', 'code', 'details', 'retryable', 'fatal', 'cancelled', 'artifacts']) delete candidate[key];
  return candidate;
}

function receiptValue(value, key = '') {
  if (RECEIPT_FORBIDDEN_KEYS.has(String(key).toLowerCase())) return undefined;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactText(value).slice(0, 2000);
  if (Array.isArray(value)) return value.map((item) => receiptValue(item)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([childKey]) => !RECEIPT_FORBIDDEN_KEYS.has(childKey.toLowerCase()))
      .map(([childKey, childValue]) => [childKey, receiptValue(childValue, childKey)])
      .filter(([, childValue]) => childValue !== undefined));
  }
  return null;
}

function boundedUsageValue(value, depth = 0, seen = new Set()) {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && value <= 1e12;
  if (typeof value === 'string') return value.length <= MAX_USAGE_STRING_LENGTH;
  if (!value || typeof value !== 'object' || depth > MAX_USAGE_DEPTH || seen.has(value)) return false;
  seen.add(value);
  let valid;
  if (Array.isArray(value)) {
    valid = value.length <= MAX_USAGE_ARRAY_ITEMS && value.every((item) => boundedUsageValue(item, depth + 1, seen));
  } else {
    const entries = Object.entries(value);
    valid = entries.length <= MAX_USAGE_KEYS
      && entries.every(([key, item]) => key.length <= 128 && boundedUsageValue(item, depth + 1, seen));
  }
  seen.delete(value);
  return valid;
}

function boundedUsage(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && boundedUsageValue(value));
}

function inputAudit(goal) {
  const contextPaths = Array.isArray(goal.contextPaths) ? goal.contextPaths : [];
  const questions = Array.isArray(goal.questions) ? goal.questions : [];
  const answeredQuestionIds = questions
    .filter((question) => typeof question.answer === 'string' && question.answer.trim())
    .map((question) => question.id);
  return {
    contextCount: contextPaths.length,
    contextIds: contextPaths.map((path) => `ctx_${fingerprint(path)}`),
    questionCount: questions.length,
    questionIds: questions.map((question) => question.id),
    answeredCount: answeredQuestionIds.length,
    answeredQuestionIds,
  };
}

export function validateLeadAnswerEntries(answers, { goalId = null, questions = [] } = {}) {
  if (!Array.isArray(answers) || !answers.length) {
    throw leadError('lead_plan_answers_invalid', 'answers must be a non-empty array', 400, { field: 'answers' });
  }
  const byId = new Map((Array.isArray(questions) ? questions : []).map((question) => [question.id, question]));
  const seen = new Set();
  const normalized = [];
  for (const item of answers) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw leadError('lead_plan_answers_invalid', 'Each lead answer must be an object', 400, { field: 'answers' });
    }
    const extraKeys = Object.keys(item).filter((key) => key !== 'id' && key !== 'answer');
    if (extraKeys.length || typeof item.id !== 'string' || !item.id.trim() || typeof item.answer !== 'string') {
      throw leadError('lead_plan_answers_invalid', 'Each lead answer must contain only a question id and nonblank answer text', 400, { field: 'answers', extraKeys });
    }
    const id = item.id.trim();
    const answer = item.answer.trim();
    if (seen.has(id)) throw leadError('lead_plan_answers_invalid', `Question ${id} is answered more than once`, 400, { questionId: id });
    if (!answer || answer.length > 2000) throw leadError('lead_plan_answers_invalid', `Answer for question ${id} must be 1 to 2000 nonblank characters`, 400, { questionId: id, maxLength: 2000 });
    const question = byId.get(id);
    if (!question) throw leadError('lead_plan_question_not_found', `Unknown lead question: ${id}`, 404, { goalId, questionId: id });
    const previous = typeof question.answer === 'string' ? question.answer.trim() : '';
    if (previous && previous !== answer) throw leadError('lead_plan_answer_conflict', `Question ${id} already has a different answer`, 409, { goalId, questionId: id });
    seen.add(id);
    normalized.push({ id, answer });
  }
  return normalized;
}

function verifiedRuntime(result) {
  return result?.runtime || result?.evidence || null;
}

export class LeadPlanningService {
  constructor({ engine, clock = () => Date.now(), planner = null, plannerExecutor = null } = {}) {
    if (!engine) throw new Error('LeadPlanningService requires an engine');
    this.engine = engine;
    this.clock = clock;
    // Tests and embedders may inject the existing Codex-shaped planner. Production
    // defaults to the engine's registered codex adapter; no alternate provider is selected.
    this.planner = planner || plannerExecutor || null;
  }

  get records() {
    if (!Array.isArray(this.engine.state.leadPlans)) this.engine.state.leadPlans = [];
    return this.engine.state.leadPlans;
  }

  get creationRequests() {
    if (!Array.isArray(this.engine.state.leadPlanCreationRequests)) this.engine.state.leadPlanCreationRequests = [];
    return this.engine.state.leadPlanCreationRequests;
  }

  list(goalId = null, { status = null } = {}) {
    return this.records
      .filter((item) => (!goalId || item.goalId === goalId) && (!status || item.status === status))
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .map(clone);
  }

  get(id) {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw notFound('lead plan', id);
    return clone(record);
  }

  recoverGenerating() {
    if (!this.records.some((item) => item.status === LEAD_PLAN_STATUS.generating)) return 0;
    return this.engine.transact(() => {
      let recovered = 0;
      for (const proposal of this.records) {
        if (proposal.status !== LEAD_PLAN_STATUS.generating) continue;
        const at = this.engine.now();
        proposal.status = LEAD_PLAN_STATUS.interrupted;
        proposal.updatedAt = at;
        proposal.interruptedAt = at;
        proposal.errorCode = 'lead_plan_interrupted';
        delete proposal.error;
        const goal = this.engine.getGoal(proposal.goalId);
        if (goal.leadPlan?.id === proposal.id) {
          goal.leadPlan = { id: proposal.id, status: proposal.status, requestId: proposal.requestId, inputFingerprint: proposal.inputFingerprint };
          goal.status = 'planning';
          goal.updatedAt = at;
        }
        this.engine.recordEvent('lead_plan.interrupted', {
          projectId: proposal.projectId,
          payload: { proposalId: proposal.id, goalId: proposal.goalId, requestId: proposal.requestId },
        });
        recovered += 1;
      }
      return recovered;
    });
  }

  // Every planner call has a separate immutable proposal record. A generating
  // marker is persisted before work so restart can mark that one call interrupted.
  async plan(goalOrOptions, maybeOptions = {}) {
    const options = normalizeOptions(goalOrOptions, maybeOptions);
    this.#assertMode(options.planningMode);
    const goalId = options.goalId;
    if (typeof goalId !== 'string' || !goalId.trim()) throw leadError('lead_plan_goal_required', 'goalId is required', 400, { field: 'goalId' });
    const request = requestId(options.requestId);
    const derived = derivedId(options.derivedFromProposalId);
    const goal = this.engine.getGoal(goalId);
    if (goal.planningMode !== 'lead') throw leadError('lead_plan_goal_not_lead', `Goal ${goal.id} is not a lead-planning goal`, 409, { goalId: goal.id });
    const inputFingerprint = leadInputFingerprint(goal, derived);
    const prepared = this.engine.transact(() => {
      const currentGoal = this.engine.getGoal(goal.id);
      const existing = this.records.find((item) => item.requestId === request);
      if (existing) {
        if (existing.inputFingerprint !== inputFingerprint) {
          throw leadError('lead_plan_request_mismatch', `requestId ${request} was already used for different planning input`, 409, { requestId: request, existingFingerprint: existing.inputFingerprint, inputFingerprint });
        }
        return { goal: clone(currentGoal), proposal: clone(existing), generate: false };
      }
      const accepted = this.records.find((item) => item.goalId === currentGoal.id && item.status === LEAD_PLAN_STATUS.accepted);
      if (accepted) {
        throw leadError('lead_plan_already_accepted', `Goal ${currentGoal.id} already has an accepted lead proposal`, 409, { goalId: currentGoal.id, proposalId: accepted.id });
      }
      const config = this.#assertConfigured();
      const proposal = this.#prepareProposal(currentGoal, { request, inputFingerprint, derived });
      return { proposal: clone(proposal), generate: true, config };
    });
    if (!prepared.generate) return { goal: prepared.goal, proposal: prepared.proposal, idempotent: true };
    return this.#generate(prepared.proposal.id, goal.id, prepared.config);
  }

  propose(goalOrOptions, maybeOptions = {}) {
    return this.plan(goalOrOptions, maybeOptions);
  }

  async createLeadGoal(input = {}) {
    this.#assertMode(input.planningMode ?? 'lead');
    const request = requestId(input.requestId);
    if (input.plan !== undefined && input.plan !== null) throw leadError('lead_plan_input_invalid', 'Lead goals start as empty shells; the planner must supply the plan', 400, { field: 'plan' });
    const creation = this.#normalizeCreationInput(input);
    const prepared = this.engine.transact(() => {
      const existing = this.creationRequests.find((item) => item.requestId === request);
      if (existing) {
        if (existing.inputFingerprint !== creation.inputFingerprint) {
          throw leadError('lead_plan_creation_mismatch', `requestId ${request} was already used for different goal creation input`, 409, {
            requestId: request,
            existingFingerprint: existing.inputFingerprint,
            inputFingerprint: creation.inputFingerprint,
          });
        }
        if (!existing.goalId || !existing.proposalId) {
          throw leadError('lead_plan_creation_invalid', `Lead creation request ${request} has no durable goal reservation`, 409, { requestId: request });
        }
        return { generate: false, goalId: existing.goalId, proposalId: existing.proposalId };
      }

      const config = this.#assertConfigured();
      const at = this.engine.now();
      const reservation = {
        id: newId('lead-plan'),
        immutable: true,
        status: 'created',
        requestId: request,
        inputFingerprint: creation.inputFingerprint,
        inputAudit: creation.inputAudit,
        goalId: null,
        proposalId: null,
        createdAt: at,
        updatedAt: at,
      };
      // Reserve before creating the shell. The surrounding transaction means a
      // failed shell/proposal creation rolls the reservation back with the state.
      this.creationRequests.push(reservation);
      const goal = this.engine.createLeadGoalShell({
        projectId: creation.projectId,
        prompt: creation.prompt,
        contextPaths: creation.contextPaths,
      });
      const proposal = this.#prepareProposal(goal, {
        request,
        inputFingerprint: leadInputFingerprint(goal, null),
        derived: null,
      });
      reservation.goalId = goal.id;
      reservation.proposalId = proposal.id;
      reservation.updatedAt = this.engine.now();
      return { generate: true, goalId: goal.id, proposal: clone(proposal), config };
    });
    if (!prepared.generate) {
      return {
        goal: clone(this.engine.getGoal(prepared.goalId)),
        proposal: this.get(prepared.proposalId),
        idempotent: true,
      };
    }
    return this.#generate(prepared.proposal.id, prepared.goalId, prepared.config);
  }

  #normalizeCreationInput(input) {
    const projectId = input.projectId || this.engine.defaultProject()?.id;
    const project = this.engine.state.projects.find((item) => item.id === projectId);
    if (!project) throw notFound('project', projectId);
    const contextPaths = input.contextPaths == null ? [] : input.contextPaths;
    if (!Array.isArray(contextPaths) || contextPaths.some((path) => typeof path !== 'string')) {
      throw leadError('lead_plan_input_invalid', 'contextPaths must be an array of strings', 400, { field: 'contextPaths' });
    }
    const prompt = String(input.prompt || '').trim();
    if (!prompt) throw leadError('lead_plan_input_invalid', 'prompt must be a non-empty string', 400, { field: 'prompt' });
    return {
      projectId: project.id,
      prompt,
      contextPaths: [...contextPaths],
      inputFingerprint: fingerprint(stableStringify({ projectId: project.id, prompt, contextPaths })),
      inputAudit: {
        contextCount: contextPaths.length,
        contextIds: contextPaths.map((path) => `ctx_${fingerprint(path)}`),
      },
    };
  }

  #prepareProposal(currentGoal, { request, inputFingerprint, derived = null }) {
    const source = derived ? this.records.find((item) => item.id === derived) : null;
    if (derived && !source) throw leadError('lead_plan_derived_not_found', `Unknown lead proposal: ${derived}`, 404, { derivedFromProposalId: derived });
    if (source && source.goalId !== currentGoal.id) throw leadError('lead_plan_derived_invalid', 'derivedFromProposalId belongs to another goal', 409, { derivedFromProposalId: derived, goalId: currentGoal.id });
    if (source && source.status !== LEAD_PLAN_STATUS.needs_clarification) {
      throw leadError('lead_plan_derived_invalid', 'Only a needs_clarification proposal can be revised', 409, { derivedFromProposalId: derived, status: source.status });
    }
    if (source && currentGoal.status !== 'lead_revision_ready') {
      throw leadError('lead_plan_revision_not_ready', `Goal ${currentGoal.id} has not received complete clarification answers`, 409, { goalId: currentGoal.id, status: currentGoal.status });
    }
    const accepted = this.records.find((item) => item.goalId === currentGoal.id && item.status === LEAD_PLAN_STATUS.accepted);
    if (accepted) {
      throw leadError('lead_plan_already_accepted', `Goal ${currentGoal.id} already has an accepted lead proposal`, 409, { goalId: currentGoal.id, proposalId: accepted.id });
    }
    const active = this.records.find((item) => item.goalId === currentGoal.id && ACTIVE_STATUSES.has(item.status));
    if (active) {
      if (!source || active.id !== source.id) throw leadError('lead_plan_request_active', `Lead planning request ${active.requestId} is already active for goal ${currentGoal.id}`, 409, { goalId: currentGoal.id, proposalId: active.id, requestId: active.requestId, status: active.status });
      if (active.status === LEAD_PLAN_STATUS.generating) throw leadError('lead_plan_request_active', `Lead planning request ${active.requestId} is still generating`, 409, { goalId: currentGoal.id, proposalId: active.id, requestId: active.requestId });
    }
    const at = this.engine.now();
    const callNumber = this.records.filter((item) => item.goalId === currentGoal.id).length + 1;
    const proposal = {
      id: newId('lead-plan'),
      schemaVersion: LEAD_PLANNING_SCHEMA_VERSION,
      goalId: currentGoal.id,
      projectId: currentGoal.projectId,
      status: LEAD_PLAN_STATUS.generating,
      immutable: true,
      createdAt: at,
      updatedAt: at,
      createdBy: 'lead',
      planningMode: 'lead',
      requestId: request,
      inputFingerprint,
      derivedFromProposalId: derived,
      callNumber,
      planner: { harness: 'codex', model: MODEL, effort: EFFORT, sandbox: SANDBOX, verified: false, auth: 'ChatGPT login' },
      taskNonce: `aos-${fingerprint(`${currentGoal.id}|${request}|${inputFingerprint}`)}`,
      // Keep the historical field name, but retain only non-sensitive audit
      // metadata. Prompt, context paths, question prompts, and answers stay on
      // the goal shell and are never duplicated in a proposal.
      input: inputAudit(currentGoal),
      questions: [],
      plan: null,
      planFingerprint: null,
      rationale: '',
      summary: '',
      runtime: null,
      acceptedAt: null,
      acceptedBy: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      interruptedAt: null,
      errorCode: null,
    };
    this.records.push(proposal);
    currentGoal.planningMode = 'lead';
    currentGoal.leadPlan = { id: proposal.id, status: proposal.status, requestId: proposal.requestId, inputFingerprint: proposal.inputFingerprint };
    currentGoal.status = 'planning';
    currentGoal.updatedAt = at;
    this.engine.recordEvent('lead_plan.generating', {
      projectId: currentGoal.projectId,
      payload: { proposalId: proposal.id, goalId: currentGoal.id, requestId: proposal.requestId, derivedFromProposalId: derived },
    });
    return proposal;
  }

  // Lead answers belong to the goal shell, not to an already immutable proposal.
  // A caller must explicitly submit a new plan request derived from that proposal.
  answerQuestions(proposalId, answers = []) {
    const proposal = this.get(proposalId);
    const goal = this.engine.getGoal(proposal.goalId);
    if (proposal.status !== LEAD_PLAN_STATUS.needs_clarification) {
      throw leadError('lead_plan_questions_unavailable', `Lead plan ${proposalId} is ${proposal.status}; only clarification proposals accept answers`, 409, { proposalId, status: proposal.status });
    }
    if (goal.leadPlan?.id !== proposal.id || goal.leadPlan?.status !== proposal.status || goal.status !== 'awaiting_user') {
      throw leadError('lead_plan_not_active', `Lead plan ${proposalId} is not the active clarification proposal`, 409, { proposalId, goalId: goal.id, activeProposalId: goal.leadPlan?.id || null, status: goal.status });
    }
    const normalized = validateLeadAnswerEntries(answers, { goalId: goal.id, questions: goal.questions });
    return this.engine.answerQuestions(goal.id, normalized);
  }

  accept(proposalId, { actor = 'operator' } = {}) {
    return this.engine.transact(() => {
      const proposal = this.#require(proposalId);
      if (proposal.status !== LEAD_PLAN_STATUS.proposed) throw leadError('lead_plan_decision_conflict', `Lead plan ${proposalId} is ${proposal.status}; only proposed plans can be accepted`, 409, { proposalId, status: proposal.status });
      const goal = this.engine.getGoal(proposal.goalId);
      if (goal.leadPlan?.id !== proposal.id) throw leadError('lead_plan_not_active', `Lead plan ${proposalId} is not the active proposal`, 409, { proposalId, activeProposalId: goal.leadPlan?.id || null });
      const config = this.#assertConfigured();
      this.#validateAssignments(goal, proposal.plan, config);
      const at = this.engine.now();
      proposal.status = LEAD_PLAN_STATUS.accepted;
      proposal.updatedAt = at;
      proposal.acceptedAt = at;
      proposal.acceptedBy = String(actor || 'operator').trim().slice(0, 128) || 'operator';
      goal.plan = clone(proposal.plan);
      goal.status = 'planned';
      goal.planVersion = 1;
      goal.planningMode = 'lead';
      goal.planProvenance = { source: 'lead', proposalId: proposal.id, inputFingerprint: proposal.inputFingerprint, planFingerprint: proposal.planFingerprint };
      goal.leadPlan = { id: proposal.id, status: proposal.status, requestId: proposal.requestId, inputFingerprint: proposal.inputFingerprint, planFingerprint: proposal.planFingerprint };
      goal.updatedAt = at;
      this.engine.recordEvent('lead_plan.accepted', { projectId: proposal.projectId, payload: { proposalId, goalId: proposal.goalId, requestId: proposal.requestId, actor: proposal.acceptedBy } });
      return { proposal: clone(proposal), goal: clone(goal) };
    });
  }

  approve(proposalId, options = {}) {
    return this.accept(proposalId, options);
  }

  approveProposal(proposalId, options = {}) {
    return this.accept(proposalId, options);
  }

  reject(proposalId, { reason = 'Rejected by operator', actor = 'operator' } = {}) {
    return this.engine.transact(() => {
      const proposal = this.#require(proposalId);
      if (proposal.status !== LEAD_PLAN_STATUS.proposed) throw leadError('lead_plan_decision_conflict', `Lead plan ${proposalId} is ${proposal.status}; only proposed plans can be rejected`, 409, { proposalId, status: proposal.status });
      const goal = this.engine.getGoal(proposal.goalId);
      if (goal.leadPlan?.id !== proposal.id) throw leadError('lead_plan_not_active', `Lead plan ${proposalId} is not the active proposal`, 409, { proposalId, activeProposalId: goal.leadPlan?.id || null });
      const at = this.engine.now();
      proposal.status = LEAD_PLAN_STATUS.rejected;
      proposal.updatedAt = at;
      proposal.rejectedAt = at;
      proposal.rejectedBy = String(actor || 'operator').trim().slice(0, 128) || 'operator';
      proposal.rejectionReason = String(reason || 'Rejected by operator').trim().slice(0, 500);
      goal.status = 'planning';
      goal.leadPlan = { id: proposal.id, status: proposal.status, requestId: proposal.requestId, inputFingerprint: proposal.inputFingerprint };
      delete goal.planProvenance;
      goal.updatedAt = at;
      this.engine.recordEvent('lead_plan.rejected', { projectId: proposal.projectId, payload: { proposalId, goalId: proposal.goalId, requestId: proposal.requestId, actor: proposal.rejectedBy } });
      return { proposal: clone(proposal), goal: clone(goal) };
    });
  }

  rejectProposal(proposalId, options = {}) {
    return this.reject(proposalId, options);
  }

  async #generate(proposalId, goalId, config) {
    const proposal = this.records.find((item) => item.id === proposalId);
    if (!proposal) throw notFound('lead plan', proposalId);
    const goal = this.engine.getGoal(goalId);
    const planner = this.#planner();
    let preflight;
    try {
      if (typeof planner?.preflight !== 'function') throw leadError('lead_planner_preflight_invalid', 'Lead planning requires a Codex preflight result', 409);
      preflight = await this.engine.preflightCodex({ worker: planner, config });
      this.#assertPreflight(preflight, config);
    } catch (error) {
      const code = {
        codex_preflight_auth_invalid: 'lead_planner_auth_invalid',
        codex_preflight_config_invalid: 'lead_planner_config_invalid',
        codex_preflight_invalid: 'lead_planner_preflight_invalid',
        codex_preflight_unavailable: 'lead_planner_preflight_invalid',
      }[error.code] || error.code || 'lead_planner_preflight_invalid';
      throw this.#failAndReturn(proposalId, code, error.message, error.details);
    }

    const task = {
      id: `lead-plan-${proposal.id}`,
      key: 'lead-plan',
      title: 'Lead planning',
      kind: 'plan',
      branch: 'root',
      worker: 'codex',
      harness: 'codex',
      model: MODEL,
      effort: EFFORT,
      sandbox: SANDBOX,
      sandboxTier: SANDBOX,
      attempts: 1,
      nonce: proposal.taskNonce,
      brief: 'Produce a bounded, reviewable task graph for this objective. The operator must accept it before any plan changes.',
    };
    let workspace;
    try {
      workspace = claimWorkspace({
        root: this.engine.store.workspacesDir,
        runId: `lead-planning-${goal.id}`,
        taskId: task.id,
        agentId: 'lead-planner',
        now: this.engine.now(),
      });
    } catch (error) {
      throw this.#failAndReturn(proposalId, 'lead_planner_unavailable', error.message, null);
    }
    const run = {
      id: `lead-planning-${goal.id}`,
      goalId: goal.id,
      projectId: goal.projectId,
      objective: goal.prompt,
      status: 'planning',
      execution: this.engine.executionSummary(),
    };
    const policy = {
      harness: 'codex',
      model: MODEL,
      effort: EFFORT,
      sandbox: SANDBOX,
      allowedHarnesses: this.engine.settings.effective('execution.allowedHarnesses', { projectId: goal.projectId }).value,
      allowedModels: this.engine.settings.effective('execution.allowedModels', { projectId: goal.projectId }).value,
    };
    const controller = new AbortController();
    const context = {
      task,
      goal: clone(goal),
      run,
      workspace,
      attempt: 1,
      revision: 1,
      signal: controller.signal,
      repoRoot: config.repoRoot || null,
      eventsPath: this.engine.store.eventsPath,
      dependencies: [],
      systemPrompt: null,
      policy,
      proposal: clone(proposal),
      outputKind: 'lead',
      outputSchema: LEAD_PLANNING_OUTPUT_SCHEMA,
      planningPrompt: buildLeadPlanningPrompt(task, { goal, run, policy, answers: goal.questions || [] }),
      answers: clone(goal.questions || []),
      emit: () => {},
      heartbeat: () => true,
      recordWorkerProcess: () => {},
    };
    let result;
    try {
      result = await this.#invokePlanner(planner, task, context);
    } catch (error) {
      throw this.#failAndReturn(proposalId, error.code || 'lead_planner_failed', error.message, error.details);
    }

    const runtime = verifiedRuntime(result);
    try {
      this.#assertRuntime(runtime, config);
    } catch (error) {
      throw this.#failAndReturn(proposalId, error.code || 'lead_planner_unverified', error.message, error.details);
    }
    if (result?.status === 'failed' || result?.status === 'cancelled') {
      throw this.#failAndReturn(proposalId, result.code || 'lead_planner_failed', 'Lead planner returned a failure', result.details || null);
    }

    let normalized;
    try {
      normalized = normalizeLeadPlanOutput(plannerOutput(result), { expectedNonce: task.nonce });
      if (normalized.plan) this.#validateAssignments(goal, normalized.plan, config);
    } catch (error) {
      throw this.#failAndReturn(proposalId, error.code || 'lead_plan_invalid', error.message, error.details || null);
    }

    return this.engine.transact(() => {
      const current = this.records.find((item) => item.id === proposalId);
      if (!current) throw notFound('lead plan', proposalId);
      if (current.status !== LEAD_PLAN_STATUS.generating) return { goal: clone(this.engine.getGoal(goalId)), proposal: clone(current) };
      const at = this.engine.now();
      const status = normalized.status === 'succeeded' ? LEAD_PLAN_STATUS.proposed : LEAD_PLAN_STATUS.needs_clarification;
      const questions = normalized.questions.map((question, index) => ({
        id: `${current.id}-q${index + 1}`,
        prompt: question.prompt,
        ...(question.reason ? { reason: question.reason } : {}),
        required: question.required !== false,
      }));
      const nextPlan = normalized.plan ? clone(normalized.plan) : null;
      const runtimeReceipt = this.#runtimeReceipt(runtime, preflight, current.callNumber);
      current.status = status;
      current.updatedAt = at;
      current.planner.verified = true;
      current.questions = clone(questions);
      current.plan = nextPlan;
      current.planFingerprint = nextPlan ? leadPlanFingerprint(nextPlan) : null;
      current.rationale = normalized.rationale;
      current.summary = normalized.summary;
      current.runtime = runtimeReceipt;
      current.errorCode = null;
      delete current.error;
      current.interruptedAt = null;
      const currentGoal = this.engine.getGoal(goalId);
      currentGoal.planningMode = 'lead';
      currentGoal.questions = questions.map((question) => ({ ...question, answer: null }));
      currentGoal.leadPlan = {
        id: current.id,
        status: current.status,
        requestId: current.requestId,
        inputFingerprint: current.inputFingerprint,
        ...(current.planFingerprint ? { planFingerprint: current.planFingerprint } : {}),
      };
      currentGoal.status = status === LEAD_PLAN_STATUS.needs_clarification ? 'awaiting_user' : 'awaiting_approval';
      currentGoal.updatedAt = at;
      this.engine.recordEvent(status === LEAD_PLAN_STATUS.needs_clarification ? 'lead_plan.needs_clarification' : 'lead_plan.proposed', {
        projectId: current.projectId,
        payload: { proposalId: current.id, goalId, requestId: current.requestId, questionCount: questions.length, taskCount: current.plan?.tasks?.length || 0 },
      });
      return { goal: clone(currentGoal), proposal: clone(current) };
    });
  }

  #runtimeReceipt(runtime, preflight, attempt) {
    return {
      schemaVersion: 1,
      attempt,
      provider: runtime.provider,
      authPath: runtime.authPath,
      verified: true,
      threadId: runtime.threadId,
      requested: { model: runtime.requested.model, effort: runtime.requested.effort, sandbox: runtime.requested.sandbox },
      effective: {
        model: runtime.effective.model,
        effort: runtime.effective.effort,
        sandbox: runtime.effective.sandbox,
        ...(runtime.effective.modelProvider ? { modelProvider: runtime.effective.modelProvider } : {}),
      },
      startedAt: runtime.startedAt,
      endedAt: runtime.endedAt,
      durationMs: runtime.durationMs,
      usage: runtime.usage == null ? null : receiptValue(runtime.usage),
      usageUnavailable: runtime.usageUnavailable === true,
      spawned: Boolean(runtime.spawned),
      injected: Boolean(runtime.injected),
      exitCode: runtime.exitCode ?? null,
      signal: runtime.signal ?? null,
      timedOut: Boolean(runtime.timedOut),
      cancelled: Boolean(runtime.cancelled),
      preflight: {
        checkedAt: preflight.checkedAt || null,
        login: preflight.login,
        authPath: CODEX_AUTH_PATH,
        cliVersion: preflight.cliVersion || null,
        model: preflight.model?.slug || null,
        requested: { model: preflight.requested.model, effort: preflight.requested.effort },
        ...(Array.isArray(preflight.strippedEnv) ? { strippedEnv: [...preflight.strippedEnv] } : {}),
        ...(Array.isArray(preflight.disabledFeatures) ? { disabledFeatures: [...preflight.disabledFeatures] } : {}),
      },
    };
  }

  #invokePlanner(planner, task, context) {
    if (typeof planner === 'function') return planner(context);
    if (typeof planner?.plan === 'function') return planner.plan(context);
    if (typeof planner?.execute === 'function') return planner.execute(task, context);
    throw leadError('lead_planner_unavailable', 'The existing Codex harness is not available', 409);
  }

  #require(id) {
    const proposal = this.records.find((item) => item.id === id);
    if (!proposal) throw notFound('lead plan', id);
    if (!LEAD_PLAN_STATUSES.has(proposal.status)) throw leadError('lead_plan_invalid_state', `Lead plan ${id} has unknown status`, 409, { proposalId: id, status: proposal.status });
    return proposal;
  }

  #assertMode(mode) {
    if (mode !== 'lead') throw leadError(mode === undefined ? 'lead_planning_mode_required' : 'lead_planning_mode_invalid', 'planningMode must be explicitly set to "lead"', 400, { field: 'planningMode', expected: 'lead' });
  }

  #assertConfigured() {
    if (this.engine.execution?.mode !== 'codex' || !this.engine.execution.codex) {
      throw leadError('lead_planner_requires_codex', 'Lead planning requires live Codex execution; local workers are not a fallback', 409, { mode: this.engine.execution?.mode || null });
    }
    const config = resolveCodexConfig({ ...this.engine.execution.codex, model: MODEL, effort: EFFORT });
    const planner = this.#planner();
    if (!planner || (typeof planner !== 'function' && typeof planner.plan !== 'function' && typeof planner.execute !== 'function')) {
      throw leadError('lead_planner_unavailable', 'The existing Codex harness is not available', 409);
    }
    return config;
  }

  #planner() {
    return this.planner || this.engine.workers.get('codex');
  }

  #assertPreflight(preflight, config) {
    if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight)) throw leadError('lead_planner_preflight_invalid', 'Lead planning requires a preflight object', 409);
    if (preflight.login !== 'Logged in using ChatGPT') throw leadError('lead_planner_auth_invalid', 'Lead planning requires the exact verified ChatGPT login', 409, { auth: 'ChatGPT login' });
    if (preflight.model?.slug !== config.model || preflight.requested?.model !== config.model || preflight.requested?.effort !== config.effort) {
      throw leadError('lead_planner_config_invalid', 'Codex preflight does not match the fixed lead planner assignment', 409, { expected: { model: config.model, effort: config.effort } });
    }
  }

  #assertRuntime(runtime, config) {
    const requested = runtime?.requested || {};
    const effective = runtime?.effective || {};
    const started = Date.parse(runtime?.startedAt || '');
    const ended = Date.parse(runtime?.endedAt || '');
    const validTiming = Number.isFinite(started) && Number.isFinite(ended) && ended >= started && Number.isFinite(runtime?.durationMs) && runtime.durationMs >= 0 && Math.abs((ended - started) - runtime.durationMs) <= 1;
    const hasUsage = boundedUsage(runtime?.usage);
    const usageUnavailable = runtime?.usageUnavailable === true && (runtime?.usage === null || runtime?.usage === undefined);
    const valid = runtime && typeof runtime === 'object'
      && runtime.provider === 'codex'
      && runtime.authPath === CODEX_AUTH_PATH
      && runtime.verified === true
      && requested.model === config.model
      && requested.effort === config.effort
      && requested.sandbox === SANDBOX
      && effective.model === config.model
      && effective.effort === config.effort
      && effective.sandbox === SANDBOX
      && typeof runtime.threadId === 'string'
      && runtime.threadId.trim()
      && (hasUsage || usageUnavailable)
      && validTiming;
    if (!valid) throw leadError('lead_planner_unverified', `Lead planner runtime receipt is incomplete or does not match verified Codex ChatGPT login at ${MODEL}/${EFFORT}/${SANDBOX}`, 409, { provider: runtime?.provider || null, authPath: runtime?.authPath || null, verified: runtime?.verified ?? null, hasHarnessReference: Boolean(runtime?.threadId) });
  }

  #validateAssignments(goal, plan, config) {
    if (!plan) throw leadError('lead_plan_invalid', 'Lead planner proposal is missing a plan', 409, { field: 'plan' });
    try {
      this.engine.validatePlanTasks(goal, plan.tasks);
    } catch (error) {
      throw leadError('lead_plan_policy', error.message, 409, { cause: error.code || null });
    }
    for (const task of plan.tasks) {
      const harness = task.worker || task.harness || 'codex';
      const isEngineAdopt = harness === 'engine' && task.kind === 'adopt';
      if (!isEngineAdopt && harness !== 'codex') throw leadError('lead_plan_policy', `Lead plan task ${task.id} must use the codex harness`, 409, { taskId: task.id, harness });
      const roleRuntime = isEngineAdopt ? null : this.engine.roleRuntimeForPlanTask(task);
      const model = task.model || roleRuntime?.model;
      const effort = task.effort || roleRuntime?.effort;
      const sandbox = task.sandbox || task.sandboxTier || SANDBOX;
      if (isEngineAdopt && task.requiresApproval !== true) {
        throw leadError('lead_plan_policy', `Lead plan task ${task.id} must require operator approval`, 409, { taskId: task.id, requiresApproval: task.requiresApproval });
      }
      if (!isEngineAdopt && (!roleRuntime || model !== roleRuntime.model || effort !== roleRuntime.effort || sandbox !== SANDBOX)) {
        throw leadError('lead_plan_policy', `Lead plan task ${task.id} must use its bound ${roleRuntime?.class || 'role'} runtime`, 409, { taskId: task.id, requested: { model, effort, sandbox }, expected: roleRuntime ? { model: roleRuntime.model, effort: roleRuntime.effort, sandbox: SANDBOX } : null });
      }
      task.worker = harness;
      task.harness = harness;
      task.model = model;
      task.effort = effort;
      task.sandbox = sandbox;
      task.sandboxTier = sandbox;
    }
  }

  #failAndReturn(proposalId, code, message, details = null) {
    const error = leadError(code, message, 409, details);
    this.engine.transact(() => {
      const proposal = this.records.find((item) => item.id === proposalId);
      if (!proposal || proposal.status !== LEAD_PLAN_STATUS.generating) return;
      const at = this.engine.now();
      proposal.status = LEAD_PLAN_STATUS.failed;
      proposal.updatedAt = at;
      proposal.errorCode = code;
      delete proposal.error;
      const goal = this.engine.getGoal(proposal.goalId);
      if (goal.leadPlan?.id === proposal.id) {
        goal.leadPlan = { id: proposal.id, status: proposal.status, requestId: proposal.requestId, inputFingerprint: proposal.inputFingerprint };
        goal.status = 'planning';
        goal.updatedAt = at;
      }
      this.engine.recordEvent('lead_plan.failed', { projectId: proposal.projectId, payload: { proposalId, goalId: proposal.goalId, requestId: proposal.requestId, code } });
    });
    return error;
  }
}

export {
  LEAD_PLANNING_OUTPUT_SCHEMA,
  LEAD_PLANNING_LIMITS,
  LEAD_PLANNING_SCHEMA_VERSION,
  normalizeLeadPlan,
  normalizeLeadPlanOutput,
};

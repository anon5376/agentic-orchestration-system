import { randomUUID } from 'node:crypto';

/**
 * Resource accounting is deliberately kept outside AosEngine.  The governor only
 * mutates the state object supplied by its caller; an engine transaction can therefore
 * checkpoint and roll back the same object as any other engine service.
 */

export const RESOURCE_SCHEMA_VERSION = 1;

export const RESOURCE_DIMENSIONS = Object.freeze(['tokens', 'usd', 'timeMs']);

export const RESERVATION_STATUS = Object.freeze({
  active: 'active',
  settled: 'settled',
  released: 'released',
  recovered: 'recovered',
});

const TERMINAL_STATUSES = new Set([
  RESERVATION_STATUS.settled,
  RESERVATION_STATUS.released,
  RESERVATION_STATUS.recovered,
]);

const SCOPE_ORDER = Object.freeze(['provider', 'project', 'run']);

const TOKEN_FIELDS = Object.freeze({
  input: ['inputTokens', 'promptTokens', 'input'],
  cached: ['cachedTokens', 'cacheReadTokens', 'cached'],
  output: ['outputTokens', 'completionTokens', 'output'],
  reasoning: ['reasoningTokens', 'thinkingTokens', 'reasoning'],
});

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberOrNull(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new ResourceGovernorError('resource_input_invalid', `${field} must be a finite non-negative number`, {
      statusCode: 400,
      details: { field, value },
    });
  }
  return number;
}

function currentMs(clock) {
  const value = clock();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error('ResourceGovernor clock must return milliseconds, a Date, or an ISO timestamp');
  return parsed;
}

function isoAt(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function parseAt(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function idOf(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (isObject(value) && value.id !== undefined) return String(value.id);
  return null;
}

function findValue(sources, names) {
  for (const source of sources) {
    if (!isObject(source)) continue;
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(source, name) && source[name] !== undefined) return source[name];
    }
  }
  return undefined;
}

function inputSources(input) {
  if (!isObject(input)) return [];
  const sources = [];
  for (const key of ['amount', 'resources', 'request', 'reservation', 'reserved', 'consumed', 'usage', 'result']) {
    if (isObject(input[key])) sources.push(input[key]);
  }
  sources.push(input);
  return sources;
}

function tokenParts(input) {
  const sources = inputSources(input);
  const nested = [];
  for (const source of sources) {
    if (isObject(source.tokens)) nested.push(source.tokens);
    if (isObject(source.tokenUsage)) nested.push(source.tokenUsage);
    if (isObject(source.usageTokens)) nested.push(source.usageTokens);
  }
  const allSources = [...nested, ...sources];
  const parts = {};
  let hasComponent = false;
  for (const [part, names] of Object.entries(TOKEN_FIELDS)) {
    const value = findValue(allSources, names);
    if (value !== undefined && value !== null && value !== '') hasComponent = true;
    parts[part] = numberOrNull(value, `${part}Tokens`);
  }
  if (hasComponent) {
    for (const part of Object.keys(parts)) parts[part] ??= 0;
    return { tokens: Object.values(parts).reduce((sum, value) => sum + value, 0), parts };
  }
  const direct = findValue(sources, ['totalTokens', 'tokens']);
  if (isObject(direct)) {
    const nestedParts = tokenParts({ tokens: direct });
    return nestedParts;
  }
  const total = numberOrNull(direct, 'tokens');
  return { tokens: total ?? 0, parts: null };
}

function dimensions(input, { reservation = false } = {}) {
  const sources = inputSources(input);
  const tokens = tokenParts(input);
  const costValue = findValue(sources, ['usd', 'costUsd', 'priceUsd', 'cost']);
  const usd = numberOrNull(isObject(costValue) ? costValue.usd : costValue, 'usd');
  const timeValue = findValue(sources, ['timeMs', 'wallClockMs', 'wall clock ms', 'durationMs', 'wall_ms']);
  const timeMs = numberOrNull(timeValue, 'timeMs');
  return {
    tokens: tokens.tokens,
    usd,
    timeMs: timeMs ?? (reservation ? 0 : null),
    tokenComponents: tokens.parts,
  };
}

function dimensionValues(value) {
  return {
    tokens: value?.tokens ?? 0,
    usd: value?.usd ?? null,
    timeMs: value?.timeMs ?? 0,
  };
}

function amountSignature(reservation) {
  return {
    attemptId: reservation.attemptId,
    providerId: reservation.providerId,
    projectId: reservation.projectId,
    runId: reservation.runId,
    reserved: dimensionValues(reservation.reserved),
  };
}

function limitDescriptor(value) {
  if (value === undefined) return undefined;
  if (value === null) return { limit: null, operatorGate: false };
  if (typeof value === 'number' || typeof value === 'string') {
    const limit = numberOrNull(value, 'limit');
    return { limit, operatorGate: false };
  }
  if (!isObject(value)) {
    throw new ResourceGovernorError('resource_input_invalid', 'A resource limit must be a number or descriptor object', {
      statusCode: 400,
      details: { value },
    });
  }
  const raw = value.limit ?? value.max ?? value.value ?? value.ceiling;
  const limit = raw === undefined ? null : numberOrNull(raw, 'limit');
  return {
    limit,
    operatorGate: Boolean(value.operatorGate ?? value.requireOperatorGate ?? value.gate),
    gate: value.gateName ?? value.gate ?? null,
  };
}

function scopedBucket(root, scope) {
  if (!isObject(root)) return undefined;
  return root[scope] ?? root[`${scope}Limits`] ?? root[`${scope}Budgets`];
}

function scopedLimit(root, scope, scopeId, dimension) {
  if (!isObject(root)) return undefined;
  const bucket = scopedBucket(root, scope);
  if (bucket === undefined) {
    // A flat { tokens, usd, timeMs } object is a convenient run default.
    if (scope === 'run' && Object.prototype.hasOwnProperty.call(root, dimension)) return root[dimension];
    return undefined;
  }
  if (typeof bucket === 'number' || typeof bucket === 'string') return bucket;
  if (!isObject(bucket)) return undefined;
  if (Object.prototype.hasOwnProperty.call(bucket, dimension)) return bucket[dimension];
  if (scopeId !== null && scopeId !== undefined && bucket[scopeId] !== undefined) {
    const entry = bucket[scopeId];
    if (typeof entry === 'number' || typeof entry === 'string') return entry;
    if (isObject(entry)) {
      if (Object.prototype.hasOwnProperty.call(entry, dimension)) return entry[dimension];
      if (entry.limit !== undefined || entry.max !== undefined || entry.value !== undefined) return entry;
    }
  }
  if (bucket.default !== undefined) {
    const entry = bucket.default;
    if (typeof entry === 'number' || typeof entry === 'string') return entry;
    if (isObject(entry)) return entry[dimension] ?? entry;
  }
  if (bucket.limit !== undefined || bucket.max !== undefined || bucket.value !== undefined) return bucket;
  return undefined;
}

function ensureStateArrays(state) {
  const target = isObject(state) ? state : {};
  const container = isObject(target.resources) ? target.resources : null;
  const reservations = Array.isArray(target.resourceReservations)
    ? target.resourceReservations
    : Array.isArray(target.reservations)
      ? target.reservations
      : Array.isArray(container?.reservations) ? container.reservations : [];
  const receipts = Array.isArray(target.resourceReceipts)
    ? target.resourceReceipts
    : Array.isArray(target.receipts)
      ? target.receipts
      : Array.isArray(container?.receipts) ? container.receipts : [];
  target.resourceReservations = reservations;
  target.resourceReceipts = receipts;
  if (container) {
    container.reservations = reservations;
    container.receipts = receipts;
  }
  return { state: target, reservations, receipts };
}

export class ResourceGovernorError extends Error {
  constructor(code, message, { statusCode = 409, details = {} } = {}) {
    super(message);
    this.name = 'ResourceGovernorError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ResourceBudgetError extends ResourceGovernorError {
  constructor(message, details) {
    super('budget_exceeded', message, { statusCode: 409, details });
    this.name = 'ResourceBudgetError';
  }
}

export class OperatorGateRequiredError extends ResourceGovernorError {
  constructor(message, details) {
    super('operator_gate_required', message, { statusCode: 409, details });
    this.name = 'OperatorGateRequiredError';
  }
}

export class UnknownCostError extends ResourceGovernorError {
  constructor(message, details) {
    super('budget_cost_unknown', message, { statusCode: 409, details });
    this.name = 'UnknownCostError';
  }
}

export class ResourceGovernor {
  constructor({
    state = {},
    limits = null,
    budgets = null,
    capacities = null,
    clock = () => Date.now(),
    now = null,
    idFactory = null,
    recoveryAfterMs = 15 * 60_000,
    defaultTtlMs = null,
  } = {}) {
    const ensured = ensureStateArrays(state);
    this.state = ensured.state;
    this.reservations = ensured.reservations;
    this.receipts = ensured.receipts;
    this.limits = clone(limits ?? budgets ?? capacities ?? {}) || {};
    this.clock = typeof now === 'function' ? now : clock;
    this.idFactory = typeof idFactory === 'function' ? idFactory : (prefix) => `${prefix}_${randomUUID()}`;
    this.recoveryAfterMs = numberOrNull(recoveryAfterMs, 'recoveryAfterMs') ?? 15 * 60_000;
    this.defaultTtlMs = defaultTtlMs == null ? null : numberOrNull(defaultTtlMs, 'defaultTtlMs');
    this.#receiptSequence = this.receipts.reduce((max, item) => Math.max(max, Number(item.sequence) || 0), 0);
  }

  #receiptSequence;

  get reservationReceipts() {
    return this.receipts;
  }

  get usageReceipts() {
    return this.receipts;
  }

  get ledger() {
    return this.receipts;
  }

  reserve(input = {}) {
    if (!isObject(input)) throw new ResourceGovernorError('resource_input_invalid', 'reserve input must be an object', { statusCode: 400 });
    const context = this.#context(input);
    const attemptId = String(input.attemptId ?? input.attemptIdentity ?? input.idempotencyKey ?? this.#newId('attempt'));
    const requested = dimensions(input, { reservation: true });
    const existing = this.#findByAttempt(attemptId);
    if (existing) {
      const requestedSignature = {
        attemptId,
        providerId: context.providerId,
        projectId: context.projectId,
        runId: context.runId,
        reserved: dimensionValues(requested),
      };
      if (stable(amountSignature(existing)) !== stable(requestedSignature)) {
        throw new ResourceGovernorError('attempt_identity_conflict', `Attempt ${attemptId} already has a different resource reservation`, {
          statusCode: 409,
          details: { attemptId, existing: amountSignature(existing), requested: requestedSignature, remediation: 'Use a new attemptId or retry the original request unchanged.' },
        });
      }
      return { ...clone(existing), idempotent: true };
    }

    const atMs = currentMs(this.clock);
    this.#assertKnownUsd(context, requested, input.limits ?? input.budgets ?? input.capacities, {
      phase: 'reserve',
      allowUnknown: false,
    });
    this.#checkCapacity(context, requested, input.limits ?? input.budgets ?? input.capacities, { phase: 'reserve' });

    const ttlValue = input.ttlMs ?? input.leaseMs ?? this.defaultTtlMs;
    const ttlMs = ttlValue == null ? null : numberOrNull(ttlValue, 'ttlMs');
    const expiresAt = input.expiresAt != null
      ? (parseAt(input.expiresAt) == null ? String(input.expiresAt) : isoAt(parseAt(input.expiresAt)))
      : ttlMs == null ? null : isoAt(atMs + ttlMs);
    const reservation = {
      schemaVersion: RESOURCE_SCHEMA_VERSION,
      id: this.#newId('reservation'),
      reservationId: null,
      attemptId,
      attemptIdentity: attemptId,
      providerId: context.providerId,
      projectId: context.projectId,
      runId: context.runId,
      status: RESERVATION_STATUS.active,
      reserved: dimensionValues(requested),
      amount: dimensionValues(requested),
      totalTokens: requested.tokens,
      tokenComponents: requested.tokenComponents ? clone(requested.tokenComponents) : null,
      consumed: null,
      usage: null,
      createdAt: isoAt(atMs),
      updatedAt: isoAt(atMs),
      expiresAt,
      leaseExpiresAt: expiresAt,
      terminalReceiptId: null,
      request: clone(input.metadata ?? input.requestMetadata ?? null),
    };
    reservation.reservationId = reservation.id;
    const receipt = this.#appendReceipt({
      kind: 'reservation',
      event: 'reserved',
      type: 'reserved',
      action: 'reserve',
      reservation,
      dimensions: reservation.reserved,
      tokenComponents: reservation.tokenComponents,
      actor: input.actor ?? 'system',
      metadata: input.metadata ?? null,
    }, atMs);
    reservation.receiptId = receipt.id;
    this.reservations.push(reservation);
    return clone({ ...reservation, receipt });
  }

  settle(reference, usage = {}, options = {}) {
    const reservation = this.#require(reference);
    if (TERMINAL_STATUSES.has(reservation.status)) {
      if (reservation.status === RESERVATION_STATUS.settled && this.#sameUsage(reservation, usage)) {
        return { ...clone(reservation), idempotent: true };
      }
      throw this.#terminalError(reservation, 'settle');
    }
    const input = isObject(usage) ? usage : {};
    const context = this.#context({ ...reservation, ...options });
    const actual = dimensions(input.usage ?? input.result ?? input, { reservation: false });
    const atMs = currentMs(this.clock);
    const explicitStartedAt = parseAt(input.startedAt ?? options.startedAt);
    const explicitEndedAt = parseAt(input.endedAt ?? input.finishedAt ?? options.endedAt);
    if (actual.timeMs == null) {
      const startedAt = explicitStartedAt ?? parseAt(reservation.startedAt ?? reservation.createdAt);
      const endedAt = explicitEndedAt ?? atMs;
      actual.timeMs = startedAt == null ? 0 : Math.max(0, endedAt - startedAt);
    }
    this.#assertKnownUsd(context, actual, options.limits ?? input.limits ?? input.budgets ?? input.capacities, {
      phase: 'settle',
      allowUnknown: false,
      reservation,
    });
    // A provider can report usage above the preflight estimate. Settlement records
    // that attested overage honestly and terminally; rejecting it here would leave
    // an active reservation and conceal already-spent budget.
    const usagePayload = {
      ...dimensionValues(actual),
      totalTokens: actual.tokens,
      costUsd: actual.usd,
      wallClockMs: actual.timeMs,
      tokenComponents: actual.tokenComponents ? clone(actual.tokenComponents) : null,
      startedAt: explicitStartedAt == null ? reservation.createdAt : isoAt(explicitStartedAt),
      endedAt: explicitEndedAt == null ? isoAt(atMs) : isoAt(explicitEndedAt),
      outcome: input.outcome ?? options.outcome ?? null,
    };
    const receipt = this.#appendReceipt({
      kind: 'usage',
      event: 'settled',
      type: 'usage',
      action: 'settle',
      reservation,
      dimensions: usagePayload,
      usage: usagePayload,
      tokenComponents: usagePayload.tokenComponents,
      actor: options.actor ?? input.actor ?? 'system',
      metadata: options.metadata ?? input.metadata ?? null,
    }, atMs);
    reservation.status = RESERVATION_STATUS.settled;
    reservation.updatedAt = isoAt(atMs);
    reservation.settledAt = isoAt(atMs);
    reservation.consumed = dimensionValues(actual);
    reservation.usage = usagePayload;
    reservation.released = {
      tokens: Math.max(0, reservation.reserved.tokens - usagePayload.tokens),
      usd: usagePayload.usd == null || reservation.reserved.usd == null ? null : Math.max(0, reservation.reserved.usd - usagePayload.usd),
      timeMs: Math.max(0, reservation.reserved.timeMs - usagePayload.timeMs),
    };
    reservation.terminalReceiptId = receipt.id;
    reservation.receiptId = receipt.id;
    return clone({ ...reservation, receipt });
  }

  release(reference, options = {}) {
    const reservation = this.#require(reference);
    if (TERMINAL_STATUSES.has(reservation.status)) {
      if (reservation.status === RESERVATION_STATUS.released) return { ...clone(reservation), idempotent: true };
      throw this.#terminalError(reservation, 'release');
    }
    const atMs = currentMs(this.clock);
    const reason = typeof options === 'string' ? options : options.reason ?? 'released';
    const opts = typeof options === 'string' ? {} : options;
    const receipt = this.#appendReceipt({
      kind: 'reservation',
      event: 'released',
      type: 'release',
      action: 'release',
      reservation,
      dimensions: reservation.reserved,
      actor: opts.actor ?? 'system',
      reason,
      metadata: opts.metadata ?? null,
    }, atMs);
    reservation.status = RESERVATION_STATUS.released;
    reservation.updatedAt = isoAt(atMs);
    reservation.releasedAt = isoAt(atMs);
    reservation.releaseReason = reason;
    reservation.terminalReceiptId = receipt.id;
    reservation.receiptId = receipt.id;
    return clone({ ...reservation, receipt });
  }

  recover(referenceOrOptions = {}, options = {}) {
    const specific = this.#referenceLike(referenceOrOptions);
    if (specific) {
      const reservation = this.#require(referenceOrOptions);
      if (TERMINAL_STATUSES.has(reservation.status)) {
        if (reservation.status === RESERVATION_STATUS.recovered) return { ...clone(reservation), idempotent: true };
        throw this.#terminalError(reservation, 'recover');
      }
      return this.#recoverOne(reservation, { ...options, ...(isObject(referenceOrOptions) ? referenceOrOptions : {}) });
    }
    const filter = isObject(referenceOrOptions) ? referenceOrOptions : {};
    const opts = { ...filter, ...(isObject(options) ? options : {}) };
    const nowMs = opts.now == null ? currentMs(this.clock) : (parseAt(opts.now) ?? currentMs(this.clock));
    const maxAgeMs = opts.maxAgeMs == null ? this.recoveryAfterMs : numberOrNull(opts.maxAgeMs, 'maxAgeMs');
    const recovered = [];
    for (const reservation of this.reservations) {
      if (reservation.status !== RESERVATION_STATUS.active) continue;
      if (opts.providerId != null && reservation.providerId !== idOf(opts.providerId)) continue;
      if (opts.projectId != null && reservation.projectId !== idOf(opts.projectId)) continue;
      if (opts.runId != null && reservation.runId !== idOf(opts.runId)) continue;
      const expiresAt = parseAt(reservation.expiresAt);
      const createdAt = parseAt(reservation.createdAt);
      const expired = expiresAt != null && expiresAt <= nowMs;
      const stale = createdAt != null && maxAgeMs != null && createdAt + maxAgeMs <= nowMs;
      if (!opts.force && !expired && !stale) continue;
      recovered.push(this.#recoverOne(reservation, { ...opts, nowMs, reason: opts.reason ?? 'recovered' }));
    }
    return recovered;
  }

  get(reference) {
    const reservation = this.#find(reference);
    return reservation ? clone(reservation) : null;
  }

  list({ providerId = null, projectId = null, runId = null, status = null } = {}) {
    return this.reservations
      .filter((item) => (providerId == null || item.providerId === idOf(providerId))
        && (projectId == null || item.projectId === idOf(projectId))
        && (runId == null || item.runId === idOf(runId))
        && (status == null || item.status === status))
      .map(clone);
  }

  receiptList({ attemptId = null, reservationId = null, kind = null } = {}) {
    return this.receipts
      .filter((item) => (attemptId == null || item.attemptId === String(attemptId))
        && (reservationId == null || item.reservationId === String(reservationId))
        && (kind == null || item.kind === kind))
      .map(clone);
  }

  usage({ providerId = null, projectId = null, runId = null } = {}) {
    const context = { providerId: idOf(providerId), projectId: idOf(projectId), runId: idOf(runId) };
    const result = {};
    for (const scope of SCOPE_ORDER) {
      const scopeId = context[`${scope}Id`];
      if (scopeId == null) continue;
      result[scope] = {
        id: scopeId,
        consumed: this.#usageFor(scope, scopeId, { includeActive: false }),
        reserved: this.#usageFor(scope, scopeId, { onlyActive: true }),
        committed: this.#usageFor(scope, scopeId),
        limits: Object.fromEntries(RESOURCE_DIMENSIONS.map((dimension) => [dimension, this.#limitFor(scope, scopeId, dimension)?.limit ?? null])),
      };
    }
    return result;
  }

  capacitySnapshot(context = {}) {
    return this.usage(context);
  }

  #context(input) {
    const provider = input.providerId ?? input.provider;
    return {
      providerId: idOf(provider),
      projectId: idOf(input.projectId ?? input.project),
      runId: idOf(input.runId ?? input.run),
    };
  }

  #referenceLike(value) {
    if (typeof value === 'string' || typeof value === 'number') return true;
    return isObject(value) && (value.id != null || value.reservationId != null || value.attemptId != null || value.attemptIdentity != null);
  }

  #find(reference) {
    if (typeof reference === 'string' || typeof reference === 'number') {
      const value = String(reference);
      return this.reservations.find((item) => item.id === value || item.reservationId === value || item.attemptId === value) || null;
    }
    if (!isObject(reference)) return null;
    const reservationId = reference.reservationId ?? reference.id;
    const attemptId = reference.attemptId ?? reference.attemptIdentity;
    if (reservationId != null) {
      const value = String(reservationId);
      const found = this.reservations.find((item) => item.id === value || item.reservationId === value);
      if (found) return found;
    }
    if (attemptId != null) return this.reservations.find((item) => item.attemptId === String(attemptId)) || null;
    return null;
  }

  #require(reference) {
    const reservation = this.#find(reference);
    if (!reservation) throw new ResourceGovernorError('reservation_not_found', 'Resource reservation was not found', {
      statusCode: 404,
      details: { reference },
    });
    return reservation;
  }

  #findByAttempt(attemptId) {
    return this.reservations.find((item) => item.attemptId === String(attemptId)) || null;
  }

  #newId(prefix) {
    let id;
    do id = String(this.idFactory(prefix)); while (this.reservations.some((item) => item.id === id || item.attemptId === id) || this.receipts.some((item) => item.id === id));
    return id;
  }

  #appendReceipt(fields, atMs) {
    const receipt = {
      schemaVersion: RESOURCE_SCHEMA_VERSION,
      id: this.#newId('receipt'),
      sequence: ++this.#receiptSequence,
      at: isoAt(atMs),
      reservationId: fields.reservation?.id ?? fields.reservationId ?? null,
      attemptId: fields.reservation?.attemptId ?? fields.attemptId ?? null,
      providerId: fields.reservation?.providerId ?? fields.providerId ?? null,
      projectId: fields.reservation?.projectId ?? fields.projectId ?? null,
      runId: fields.reservation?.runId ?? fields.runId ?? null,
      status: fields.event ?? null,
      ...clone(fields),
    };
    delete receipt.reservation;
    if (receipt.dimensions) {
      receipt.amount = clone(receipt.dimensions);
      receipt.tokens = receipt.dimensions.tokens ?? null;
      receipt.usd = receipt.dimensions.usd ?? null;
      receipt.timeMs = receipt.dimensions.timeMs ?? null;
      receipt.totalTokens = receipt.dimensions.totalTokens ?? receipt.tokens;
    }
    this.receipts.push(receipt);
    return receipt;
  }

  #sameUsage(reservation, usage) {
    const actual = dimensions(isObject(usage) ? usage.usage ?? usage.result ?? usage : {}, { reservation: false });
    const expected = reservation.usage || reservation.consumed;
    if (!expected) return false;
    return dimensionValues(actual).tokens === expected.tokens
      && dimensionValues(actual).usd === expected.usd
      && (actual.timeMs == null ? expected.timeMs === 0 : actual.timeMs === expected.timeMs);
  }

  #terminalError(reservation, action) {
    return new ResourceGovernorError('reservation_terminal', `Cannot ${action} terminal reservation ${reservation.id} (${reservation.status})`, {
      statusCode: 409,
      details: { reservationId: reservation.id, attemptId: reservation.attemptId, status: reservation.status, terminalReceiptId: reservation.terminalReceiptId, remediation: 'Use the existing terminal receipt; a terminal attempt cannot be changed.' },
    });
  }

  #recoverOne(reservation, options = {}) {
    const atMs = options.nowMs ?? currentMs(this.clock);
    const reason = options.reason ?? 'recovered';
    const receipt = this.#appendReceipt({
      kind: 'recovery',
      event: 'recovered',
      type: 'recovery',
      action: 'recover',
      reservation,
      dimensions: reservation.reserved,
      actor: options.actor ?? 'recovery',
      reason,
      metadata: options.metadata ?? null,
    }, atMs);
    reservation.status = RESERVATION_STATUS.recovered;
    reservation.updatedAt = isoAt(atMs);
    reservation.recoveredAt = isoAt(atMs);
    reservation.recoveryReason = reason;
    reservation.terminalReceiptId = receipt.id;
    reservation.receiptId = receipt.id;
    return clone({ ...reservation, receipt });
  }

  #limitRoots(extra) {
    const roots = [];
    for (const root of [extra, this.limits]) {
      if (!isObject(root)) continue;
      roots.push(root);
      if (isObject(root.limits)) roots.push(root.limits);
      if (isObject(root.budgets)) roots.push(root.budgets);
      if (isObject(root.capacities)) roots.push(root.capacities);
    }
    return roots;
  }

  #limitFor(scope, scopeId, dimension, extra = null) {
    for (const root of this.#limitRoots(extra)) {
      const value = scopedLimit(root, scope, scopeId, dimension);
      if (value !== undefined) return limitDescriptor(value);
    }
    return undefined;
  }

  #finiteLimits(context, dimension, extra) {
    const limits = [];
    for (const scope of SCOPE_ORDER) {
      const scopeId = context[`${scope}Id`];
      if (scopeId == null) continue;
      const descriptor = this.#limitFor(scope, scopeId, dimension, extra);
      if (descriptor && Number.isFinite(descriptor.limit)) limits.push({ scope, scopeId, descriptor });
    }
    return limits;
  }

  #assertKnownUsd(context, amount, extra, { phase, allowUnknown = false, reservation = null } = {}) {
    if (amount.usd != null || allowUnknown) return;
    const finite = this.#finiteLimits(context, 'usd', extra);
    if (!finite.length) return;
    const first = finite[0];
    const current = this.#usageFor(first.scope, first.scopeId);
    throw new UnknownCostError(`USD cost is unknown while the ${first.scope} budget is finite`, {
      dimension: 'usd',
      limit: first.descriptor.limit,
      consumed: current.consumed.usd,
      reserved: current.reserved.usd,
      requested: null,
      projected: null,
      scope: first.scope,
      scopeId: first.scopeId,
      phase,
      reservationId: reservation?.id ?? null,
      remediation: 'Return a finite USD usage estimate before reserving or settling this attempt, or remove the finite USD ceiling.',
    });
  }

  #checkCapacity(context, amount, extra, { phase, excludeReservationId = null } = {}) {
    for (const scope of SCOPE_ORDER) {
      const scopeId = context[`${scope}Id`];
      if (scopeId == null) continue;
      for (const dimension of RESOURCE_DIMENSIONS) {
        const descriptor = this.#limitFor(scope, scopeId, dimension, extra);
        if (!descriptor || !Number.isFinite(descriptor.limit)) continue;
        const current = this.#usageFor(scope, scopeId, { excludeReservationId });
        const requested = amount[dimension] == null ? 0 : amount[dimension];
        const projected = current.consumed[dimension] + current.reserved[dimension] + requested;
        if (projected <= descriptor.limit) continue;
        const details = {
          dimension,
          limit: descriptor.limit,
          consumed: current.consumed[dimension],
          reserved: current.reserved[dimension],
          requested,
          projected,
          scope,
          scopeId,
          phase,
          reservationId: excludeReservationId,
          remediation: `Reduce the ${dimension} request, release an active reservation, or raise the ${scope} ${dimension} ceiling.`,
        };
        const message = `${scope} ${scopeId} ${dimension} budget exceeded: projected ${projected} > limit ${descriptor.limit}`;
        if (descriptor.operatorGate) throw new OperatorGateRequiredError(message, { ...details, gate: descriptor.gate || 'resource_budget_exhausted' });
        throw new ResourceBudgetError(message, details);
      }
    }
  }

  #usageFor(scope, scopeId, { onlyActive = false, includeActive = true, excludeReservationId = null } = {}) {
    const total = { tokens: 0, usd: 0, timeMs: 0 };
    const reserved = { tokens: 0, usd: 0, timeMs: 0 };
    for (const reservation of this.reservations) {
      if (reservation.id === excludeReservationId) continue;
      if (reservation[`${scope}Id`] !== scopeId) continue;
      if (reservation.status === RESERVATION_STATUS.active) {
        if (!includeActive && !onlyActive) continue;
        const amount = dimensionValues(reservation.reserved);
        for (const dimension of RESOURCE_DIMENSIONS) {
          if (amount[dimension] != null) reserved[dimension] += amount[dimension];
        }
        if (onlyActive) continue;
      } else if (onlyActive) continue;
      const consumed = dimensionValues(reservation.consumed);
      for (const dimension of RESOURCE_DIMENSIONS) {
        if (consumed[dimension] != null) total[dimension] += consumed[dimension];
      }
    }
    if (onlyActive) return reserved;
    return { consumed: total, reserved, tokens: total.tokens + reserved.tokens, usd: total.usd + reserved.usd, timeMs: total.timeMs + reserved.timeMs };
  }
}

export function ensureResourceState(state = {}) {
  return ensureStateArrays(state).state;
}

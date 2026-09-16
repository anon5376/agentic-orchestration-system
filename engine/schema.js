// Hand-written validation and a stable error envelope. No dependency.
//
// A schema is a plain descriptor built with `t`. `check` returns a list of
// { path, code, message } problems; `validate` throws an AosError carrying them.

export class AosError extends Error {
  constructor(code, message, { statusCode = 400, details = null } = {}) {
    super(message);
    this.name = 'AosError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON() {
    return { error: this.message, code: this.code, details: this.details };
  }
}

export function notFound(label, id) {
  return new AosError('not_found', `Unknown ${label}: ${id}`, { statusCode: 404, details: { label, id } });
}

export function invalid(message, details = null) {
  return new AosError('invalid_input', message, { statusCode: 400, details });
}

export function conflict(code, message, details = null) {
  return new AosError(code, message, { statusCode: 409, details });
}

// Worker-to-operator questions are deliberately bounded. This validator only
// checks the wire payload; the engine adds IDs and answer metadata when it
// commits a wait state.
export function validateTaskQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3) {
    throw new AosError('task_question_payload_invalid', 'Worker questions must contain 1 to 3 items', {
      statusCode: 409,
      details: { field: 'questions', minItems: 1, maxItems: 3 },
    });
  }
  let totalPromptChars = 0;
  const normalized = questions.map((question, index) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      throw new AosError('task_question_payload_invalid', `Worker question ${index + 1} must be an object`, {
        statusCode: 409,
        details: { field: `questions[${index}]` },
      });
    }
    const extraKeys = Object.keys(question).filter((key) => key !== 'prompt' && key !== 'reason');
    if (extraKeys.length) {
      throw new AosError('task_question_payload_invalid', `Worker question ${index + 1} contains unsupported fields`, {
        statusCode: 409,
        details: { field: `questions[${index}]`, extraKeys },
      });
    }
    if (typeof question.prompt !== 'string' || !question.prompt.trim() || question.prompt.trim().length > 500) {
      throw new AosError('task_question_payload_invalid', `Worker question ${index + 1} prompt must be 1 to 500 nonblank characters`, {
        statusCode: 409,
        details: { field: `questions[${index}].prompt`, maxLength: 500 },
      });
    }
    const prompt = question.prompt.trim();
    totalPromptChars += prompt.length;
    if (typeof question.reason !== 'undefined' && (typeof question.reason !== 'string' || question.reason.length > 300)) {
      throw new AosError('task_question_payload_invalid', `Worker question ${index + 1} reason must be at most 300 characters`, {
        statusCode: 409,
        details: { field: `questions[${index}].reason`, maxLength: 300 },
      });
    }
    const reason = typeof question.reason === 'string' ? question.reason.trim() : undefined;
    return reason ? { prompt, reason } : { prompt };
  });
  if (totalPromptChars > 1500) {
    throw new AosError('task_question_payload_invalid', 'Worker question prompts must total at most 1500 characters', {
      statusCode: 409,
      details: { field: 'questions', maxPromptChars: 1500, totalPromptChars },
    });
  }
  return normalized;
}

export function errorEnvelope(error) {
  if (error instanceof AosError) return error.toJSON();
  return { error: error?.message || String(error), code: error?.code || 'internal_error', details: error?.details ?? null };
}

export const t = {
  string: (options = {}) => ({ kind: 'string', ...options }),
  integer: (options = {}) => ({ kind: 'integer', ...options }),
  number: (options = {}) => ({ kind: 'number', ...options }),
  boolean: () => ({ kind: 'boolean' }),
  enumOf: (values) => ({ kind: 'enum', values: [...values] }),
  literal: (value) => ({ kind: 'literal', value }),
  array: (items, options = {}) => ({ kind: 'array', items, ...options }),
  object: (shape, options = {}) => ({
    kind: 'object',
    shape,
    required: options.required ?? Object.keys(shape).filter((key) => !shape[key].optional),
    additional: options.additional ?? false,
  }),
  record: (values, options = {}) => ({ kind: 'record', values, ...options }),
  any: () => ({ kind: 'any' }),
  oneOf: (schemas) => ({ kind: 'oneOf', schemas }),
  optional: (schema) => ({ ...schema, optional: true }),
  nullable: (schema) => ({ ...schema, nullable: true }),
};

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
export const identifier = () => t.string({ pattern: IDENTIFIER, patternName: 'identifier (letter, then letters, digits, _ . -; max 128)' });

function problem(path, code, message) {
  return { path: path || '$', code, message };
}

export function check(schema, value, path = '$') {
  if (!schema || typeof schema !== 'object') return [problem(path, 'schema', 'missing schema')];
  if (value === undefined) return schema.optional ? [] : [problem(path, 'required', 'is required')];
  if (value === null) return schema.nullable ? [] : [problem(path, 'type', 'must not be null')];
  const errors = [];
  switch (schema.kind) {
    case 'any':
      return [];
    case 'literal':
      if (value !== schema.value) errors.push(problem(path, 'literal', `must equal ${JSON.stringify(schema.value)}`));
      return errors;
    case 'string': {
      if (typeof value !== 'string') return [problem(path, 'type', 'must be a string')];
      if (schema.minLength != null && value.length < schema.minLength) errors.push(problem(path, 'minLength', `must be at least ${schema.minLength} characters`));
      if (schema.maxLength != null && value.length > schema.maxLength) errors.push(problem(path, 'maxLength', `must be at most ${schema.maxLength} characters`));
      if (schema.pattern && !schema.pattern.test(value)) errors.push(problem(path, 'pattern', `must match ${schema.patternName || String(schema.pattern)}`));
      if (schema.nonEmpty && !value.trim()) errors.push(problem(path, 'nonEmpty', 'must not be blank'));
      return errors;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [problem(path, 'type', `must be a finite ${schema.kind}`)];
      if (schema.kind === 'integer' && !Number.isInteger(value)) return [problem(path, 'type', 'must be an integer')];
      if (schema.min != null && value < schema.min) errors.push(problem(path, 'min', `must be >= ${schema.min}`));
      if (schema.max != null && value > schema.max) errors.push(problem(path, 'max', `must be <= ${schema.max}`));
      return errors;
    }
    case 'boolean':
      if (typeof value !== 'boolean') return [problem(path, 'type', 'must be a boolean')];
      return errors;
    case 'enum':
      if (!schema.values.includes(value)) errors.push(problem(path, 'enum', `must be one of ${schema.values.map((item) => JSON.stringify(item)).join(', ')}`));
      return errors;
    case 'array': {
      if (!Array.isArray(value)) return [problem(path, 'type', 'must be an array')];
      if (schema.minItems != null && value.length < schema.minItems) errors.push(problem(path, 'minItems', `must have at least ${schema.minItems} items`));
      if (schema.maxItems != null && value.length > schema.maxItems) errors.push(problem(path, 'maxItems', `must have at most ${schema.maxItems} items`));
      value.forEach((item, index) => errors.push(...check(schema.items, item, `${path}[${index}]`)));
      if (schema.unique) {
        const seen = new Set();
        value.forEach((item, index) => {
          const key = typeof schema.unique === 'function' ? schema.unique(item) : JSON.stringify(item);
          if (seen.has(key)) errors.push(problem(`${path}[${index}]`, 'unique', 'duplicates an earlier item'));
          seen.add(key);
        });
      }
      return errors;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return [problem(path, 'type', 'must be an object')];
      for (const key of schema.required) {
        if (value[key] === undefined) errors.push(problem(`${path}.${key}`, 'required', 'is required'));
      }
      for (const [key, child] of Object.entries(schema.shape)) {
        if (value[key] === undefined) continue;
        errors.push(...check(child, value[key], `${path}.${key}`));
      }
      if (!schema.additional) {
        for (const key of Object.keys(value)) {
          if (!(key in schema.shape)) errors.push(problem(`${path}.${key}`, 'unknown', 'is not an allowed field'));
        }
      }
      return errors;
    }
    case 'record': {
      if (typeof value !== 'object' || Array.isArray(value)) return [problem(path, 'type', 'must be an object')];
      for (const [key, item] of Object.entries(value)) {
        if (schema.keyPattern && !schema.keyPattern.test(key)) errors.push(problem(`${path}.${key}`, 'key', 'is not an allowed key'));
        errors.push(...check(schema.values, item, `${path}.${key}`));
      }
      if (schema.maxKeys != null && Object.keys(value).length > schema.maxKeys) errors.push(problem(path, 'maxKeys', `must have at most ${schema.maxKeys} keys`));
      return errors;
    }
    case 'oneOf': {
      const attempts = schema.schemas.map((candidate) => check(candidate, value, path));
      if (attempts.some((list) => list.length === 0)) return [];
      return [problem(path, 'oneOf', `matches none of ${schema.schemas.length} alternatives: ${attempts.map((list) => list[0]?.message).join(' | ')}`)];
    }
    default:
      return [problem(path, 'schema', `unknown schema kind ${schema.kind}`)];
  }
}

export function validate(schema, value, label = 'input') {
  const errors = check(schema, value);
  if (errors.length) throw invalid(`${label} failed validation: ${errors[0].path} ${errors[0].message}`, { errors });
  return value;
}

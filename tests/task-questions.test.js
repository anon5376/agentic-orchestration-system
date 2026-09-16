import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TASK_ANSWER_MAX_LENGTH,
  TaskAnswerValidationError,
  buildTaskAnswers,
  describeTaskAnswerError,
  getOpenTaskQuestions,
} from '../src/lib/taskQuestions.js';

test('open task questions keep only required unanswered records', () => {
  const task = {
    questions: [
      { id: 'q_open', prompt: 'Choose a boundary.', required: true },
      { id: 'q_done', prompt: 'Already answered.', required: true, answer: 'published sources' },
      { id: 'q_optional', prompt: 'Optional context.', required: false },
    ],
  };
  assert.deepEqual(getOpenTaskQuestions(task).map(({ id, prompt }) => ({ id, prompt })), [{ id: 'q_open', prompt: 'Choose a boundary.' }]);
});

test('task answer builder trims and requires every open answer within the backend limit', () => {
  const task = { questions: [{ id: 'q1', prompt: 'Boundary?' }, { id: 'q2', prompt: 'Uncertainty?' }] };
  assert.deepEqual(buildTaskAnswers(task, { q1: '  published studies  ', q2: 'state uncertainty' }), [
    { id: 'q1', answer: 'published studies' },
    { id: 'q2', answer: 'state uncertainty' },
  ]);
  assert.throws(() => buildTaskAnswers(task, { q1: 'only one' }), (error) => (
    error instanceof TaskAnswerValidationError
      && error.code === 'task_answer_invalid'
      && error.details.errors.length === 1
      && error.details.errors[0].questionId === 'q2'
  ));
  assert.throws(() => buildTaskAnswers(task, { q1: '', q2: 'x'.repeat(TASK_ANSWER_MAX_LENGTH + 1) }), (error) => (
    error.details.errors.length === 2
      && error.details.errors.map((item) => item.questionId).sort().join(',') === 'q1,q2'
  ));
  assert.throws(() => buildTaskAnswers({ questions: [{ id: 'q1', prompt: 'Boundary?' }] }, { q1: 'x'.repeat(TASK_ANSWER_MAX_LENGTH + 1) }), (error) => (
    error.code === 'task_answer_invalid' && error.details.errors[0].code === 'task_answer_too_long'
  ));
});

test('typed backend answer errors stay safe and identify refresh cases', () => {
  assert.deepEqual(describeTaskAnswerError({ status: 409, data: { code: 'task_answer_conflict' } }), {
    code: 'task_answer_conflict',
    message: 'Another operator answer was recorded. Refresh the selected task before answering again.',
    shouldRefresh: true,
    fieldErrors: [],
  });
  assert.equal(describeTaskAnswerError({ status: 400, data: { code: 'task_answer_invalid' } }).shouldRefresh, false);
  assert.equal(describeTaskAnswerError(new Error('private backend detail')).message, 'The engine could not record these answers. Try again.');
});

export const TASK_ANSWER_MAX_LENGTH = 2000;

function text(value) {
  return typeof value === 'string' ? value : '';
}

function codeFrom(error) {
  return text(error?.data?.code || error?.code).trim();
}

export class TaskAnswerValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TaskAnswerValidationError';
    this.code = code;
    this.details = details;
  }
}

export function getOpenTaskQuestions(task) {
  return (Array.isArray(task?.questions) ? task.questions : [])
    .filter((question) => question && typeof question === 'object' && question.required !== false && !text(question.answer).trim())
    .map((question, index) => ({
      ...question,
      id: text(question.id).trim(),
      prompt: text(question.prompt).trim() || `Question ${index + 1} requires an answer.`,
    }));
}

export function buildTaskAnswers(task, drafts = {}) {
  const questions = getOpenTaskQuestions(task);
  if (!questions.length) {
    throw new TaskAnswerValidationError('task_answer_no_open_questions', 'There are no open required questions to answer.');
  }

  const answers = [];
  const errors = [];
  questions.forEach((question, questionIndex) => {
    if (!question.id) {
      errors.push({
        questionId: question.id,
        questionIndex,
        code: 'task_question_invalid',
        message: 'This question record is invalid. Refresh before answering.',
      });
      return;
    }
    const answer = text(drafts?.[question.id]).trim();
    if (!answer) {
      errors.push({
        questionId: question.id,
        questionIndex,
        code: 'task_answer_required',
        message: 'Answer required.',
      });
      return;
    }
    if (answer.length > TASK_ANSWER_MAX_LENGTH) {
      errors.push({
        questionId: question.id,
        questionIndex,
        code: 'task_answer_too_long',
        message: `Use ${TASK_ANSWER_MAX_LENGTH} characters or fewer.`,
      });
      return;
    }
    answers.push({ id: question.id, answer });
  });

  if (errors.length) {
    throw new TaskAnswerValidationError('task_answer_invalid', 'Fix the highlighted answers before submitting.', { errors });
  }
  return answers;
}

export function describeTaskAnswerError(error) {
  const code = codeFrom(error);
  const status = Number(error?.status || error?.statusCode || error?.data?.status) || null;
  const knownMessages = {
    task_answer_required: 'Answer every open required question before submitting.',
    task_answer_too_long: `Each answer must be ${TASK_ANSWER_MAX_LENGTH} characters or fewer.`,
    task_question_invalid: 'This task has an invalid question record. Refresh before answering.',
    task_answer_invalid: 'Each answer must contain 1–2000 nonblank characters.',
    task_question_not_found: 'The task questions changed. Refresh the selected task before answering again.',
    task_answer_conflict: 'Another operator answer was recorded. Refresh the selected task before answering again.',
    task_not_awaiting_user: 'This task is no longer waiting for operator input. Refresh the run.',
    task_answer_no_open_questions: 'There are no open required questions to answer.',
  };
  const refresh = ['task_question_not_found', 'task_answer_conflict', 'task_not_awaiting_user'].includes(code) || status === 409;
  const message = knownMessages[code]
    || (status === 409 ? 'The selected task changed. Refresh it before answering again.' : null)
    || (status === 400 ? 'Check each answer and try again.' : null)
    || 'The engine could not record these answers. Try again.';

  return {
    code: code || 'task_answer_failed',
    message,
    shouldRefresh: refresh,
    fieldErrors: Array.isArray(error?.details?.errors)
      ? error.details.errors
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          questionId: text(item.questionId).trim(),
          questionIndex: Number.isInteger(item.questionIndex) ? item.questionIndex : null,
          code: text(item.code).trim() || 'task_answer_invalid',
          message: text(item.message).trim() || 'Check this answer.',
        }))
      : [],
  };
}

export function shouldRefreshAfterTaskAnswerError(error) {
  return describeTaskAnswerError(error).shouldRefresh;
}

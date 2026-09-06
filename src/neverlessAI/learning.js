'use strict';

const {
  lastExchange,
  getLearningContext,
  applyCorrection,
} = require('./memory');
const { classifyCorrection } = require('./openaiClient');

function isCorrectionSignal(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return /(?:مو\s+قصدي|ما\s+كان\s+قصدي|قصدي(?:\s|:)|اقصد(?:\s|:)|أقصد(?:\s|:)|فهمتني\s+غلط|فهمت\s+غلط|مو\s+هذا\s+اللي\s+اقصده|مو\s+هذا\s+اللي\s+أقصده|وش\s+دخل|شنو\s+دخل|ماله\s+شغل|ما\s+له\s+شغل|مو\s+كذا|لا\s+مو\s+كذا|that's\s+not\s+what\s+i\s+meant|you\s+misunderstood|i\s+meant)/iu.test(value);
}

async function processCorrection(guild, userId, feedback) {
  if (!isCorrectionSignal(feedback)) return null;
  const previous = lastExchange(userId);
  if (!previous) return null;
  const active = getLearningContext(userId, previous.question).rules;
  let correction;
  try {
    correction = await classifyCorrection({
      previousQuestion: previous.question,
      previousAnswer: previous.answer,
      feedback,
      existingRules: active,
    });
  } catch (error) {
    console.warn('[neverless-ai] Correction classifier failed:', error.message);
    return null;
  }
  // One weak complaint must not rewrite future behavior. Exact-question memory is accepted
  // only when the classifier is strongly confident that a real misunderstanding happened.
  if (!correction?.valid || correction.confidence < 0.78 || !correction.meaning) return { valid: false };
  const result = applyCorrection(guild, userId, {
    ...correction,
    previousQuestion: previous.question,
  });
  return {
    valid: true,
    previousQuestion: previous.question,
    meaning: correction.meaning,
    scope: correction.scope,
    promoted: result.promoted,
    confidence: correction.confidence,
  };
}

function learningNote(context, correction = null) {
  const lines = [];
  if (context?.exact?.meaning) {
    lines.push(`Known interpretation for this exact wording from an earlier explicit correction: ${context.exact.meaning}`);
  }
  for (const rule of context?.rules || []) {
    lines.push(`Learned wording convention: when the user uses "${rule.trigger}", interpret it as: ${rule.meaning}`);
  }
  if (correction?.valid && correction.meaning) {
    lines.push(`The user's current message corrects a high-confidence previous misunderstanding. Their intended meaning is: ${correction.meaning}. Acknowledge the correction naturally and answer using that meaning.`);
  }
  return lines.join('\n');
}

module.exports = {
  isCorrectionSignal,
  processCorrection,
  learningNote,
};

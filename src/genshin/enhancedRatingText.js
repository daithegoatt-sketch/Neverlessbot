'use strict';

const { accountEvaluationText } = require('./responses');
const { akashaImprovementAdvice } = require('./ratingCopyV2');

function enhancedAccountEvaluationText(snapshot, evaluation, comparison, guide, lang, akashaRanking = null) {
  const base = accountEvaluationText(snapshot, evaluation, comparison, guide, lang, akashaRanking);
  const advice = akashaImprovementAdvice(snapshot, guide, evaluation, akashaRanking, lang);
  return advice ? `${base}\n\n${advice}` : base;
}

module.exports = { enhancedAccountEvaluationText };

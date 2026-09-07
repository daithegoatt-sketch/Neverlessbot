'use strict';

const base = require('./genshinRatingContext');

const DIRECT_BUILD = /(?:بيلد|build|تقييم|قيم|احصائ|إحصائ|ستات|stats|كريت|crit|سلاح|weapon|ارتي|artifact|شخصيتي|شخصية|سكيرك|skirk|furina|arlecchino|اتاك|atk|هجوم|hp|def|دفاع|er|em)/iu;
const FOLLOW_UP = /(?:وش\s*اغير|وش\s*أغير|شرايك|رايك|رأيك|اطورها|أطورها|ضعيف|قوي|لو\s+رفعت|لو\s+غيرت|كم\s+يرتفع|كم\s+يصير|يرتفع\s+تقييمي|تقييمي|الأولوية|الاولويه|الهدف|target|improve|upgrade|raise)/iu;

function looksLikeBuildQuestion(text, turns = []) {
  const current = String(text || '');
  if (DIRECT_BUILD.test(current)) return true;
  const recent = (turns || []).slice(-6).map((turn) => String(turn?.content || '')).join(' ');
  return FOLLOW_UP.test(current) && DIRECT_BUILD.test(recent);
}

async function getRelevantRatingContext(guild, requester, userText, turns = []) {
  if (!looksLikeBuildQuestion(userText, turns)) return null;
  // Prefix only for the internal detector in the original read-only lookup. It does not
  // change the user's message or any Genshin system; it simply keeps natural follow-ups
  // attached to the last verified rating exchange.
  return base.getRelevantRatingContext(guild, requester, `بيلد ${String(userText || '')}`, turns);
}

function formatRatingContext(context) {
  if (!context) return '';
  return [
    base.formatRatingContext(context),
    'Rating-grounding rules:',
    '- Treat the saved Neverless rating reply as authoritative for the recorded build, stats, score, priorities and targets.',
    '- When explaining how to improve, quote the current recorded stats and prioritize the deficiencies/targets stated by Neverless.',
    '- Do not invent an exact future rating percentage for a hypothetical one-stat change. The exact percentage requires rerunning the real Neverless rating system on the changed full build.',
    '- You may explain expected direction and likely benefit, but clearly separate that from an actual Neverless score.',
  ].join('\n');
}

module.exports = {
  ...base,
  looksLikeBuildQuestion,
  getRelevantRatingContext,
  formatRatingContext,
};
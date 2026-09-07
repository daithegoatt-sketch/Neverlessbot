'use strict';

const openai = require('./openaiClientV2');
const gemini = require('./geminiClient');

const MAX_CONCURRENT = Math.max(1, Math.min(4, Number(process.env.NEVERLESS_AI_CONCURRENCY) || 2));
const MAX_WAITERS = Math.max(2, Math.min(20, Number(process.env.NEVERLESS_AI_MAX_WAITERS) || 8));
let active = 0;
const waiters = [];

function provider() {
  if (gemini.configured()) return 'gemini';
  if (openai.configured()) return 'openai';
  return null;
}

function configured() {
  return Boolean(provider());
}

function providerLabel(admin = false) {
  if (provider() === 'gemini') return `Gemini/${gemini.modelLabel(admin)}`;
  if (provider() === 'openai') return `OpenAI/${openai.modelLabel(admin)}`;
  return 'not-configured';
}

function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  if (waiters.length >= MAX_WAITERS) {
    const error = new Error('AI_BUSY');
    error.code = 'AI_BUSY';
    return Promise.reject(error);
  }
  return new Promise((resolve) => waiters.push(resolve)).then(() => { active += 1; });
}

function release() {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}

async function bounded(task) {
  await acquire();
  try { return await task(); }
  finally { release(); }
}

async function runWithTools(options) {
  return bounded(async () => {
    if (provider() === 'gemini') return gemini.runWithTools(options);
    if (provider() === 'openai') return openai.runWithTools(options);
    throw new Error('AI_API_KEY_MISSING');
  });
}

async function classifyCorrection(input) {
  return bounded(async () => {
    if (provider() === 'gemini') return gemini.classifyCorrection(input);
    if (provider() === 'openai') return openai.classifyCorrection(input);
    return null;
  });
}

module.exports = {
  configured,
  provider,
  providerLabel,
  runWithTools,
  classifyCorrection,
  MAX_CONCURRENT,
  MAX_WAITERS,
};

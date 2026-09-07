'use strict';

const API_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = process.env.NEVERLESS_AI_MODEL || 'gpt-5.6-luna';
const ADMIN_MODEL = process.env.NEVERLESS_AI_ADMIN_MODEL || DEFAULT_MODEL;
const LEARNING_MODEL = process.env.NEVERLESS_AI_LEARNING_MODEL || DEFAULT_MODEL;
const REQUEST_TIMEOUT_MS = 12_000;
const TOTAL_BUDGET_MS = 25_000;
const MAX_TOOL_ROUNDS = 2;
const MAX_OUTPUT_TOKENS = 800;

class OpenAIHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'OpenAIHttpError';
    this.status = status;
  }
}

function configured() {
  return Boolean(String(process.env.OPENAI_API_KEY || '').trim());
}

function modelLabel(admin = false) {
  return admin ? ADMIN_MODEL : DEFAULT_MODEL;
}

function timeoutError() {
  const error = new Error('AI_TIMEOUT');
  error.code = 'AI_TIMEOUT';
  return error;
}

function extractText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
  const chunks = [];
  for (const item of response?.output || []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part?.type === 'output_text' && part.text) chunks.push(part.text);
      else if (typeof part?.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('\n').trim();
}

function functionCalls(response) {
  return (response?.output || []).filter((item) => item?.type === 'function_call' && item.name && item.call_id);
}

async function postResponse(body, deadline, attempt = 0) {
  if (!configured()) throw new Error('OPENAI_API_KEY_MISSING');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Math.min(REQUEST_TIMEOUT_MS, remaining)));
  timer.unref?.();
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${String(process.env.OPENAI_API_KEY || '').trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch {}
    if (!response.ok) {
      const message = parsed?.error?.message || parsed?.error?.code || `OpenAI request failed with HTTP ${response.status}`;
      if (attempt < 1 && Date.now() + 1200 < deadline && (response.status === 429 || response.status >= 500)) {
        await new Promise((resolve) => setTimeout(resolve, response.status === 429 ? 900 : 500));
        return postResponse(body, deadline, attempt + 1);
      }
      const error = new OpenAIHttpError(response.status, String(message));
      error.apiCode = parsed?.error?.code || null;
      error.apiType = parsed?.error?.type || null;
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error?.name === 'AbortError') throw timeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function inputMessages(turns, userText) {
  const rows = [];
  for (const turn of (turns || []).slice(-8)) {
    if (!turn?.content || !['user', 'assistant'].includes(turn.role)) continue;
    rows.push({ role: turn.role, content: String(turn.content).slice(0, 2600) });
  }
  rows.push({ role: 'user', content: String(userText || '').slice(0, 5000) });
  return rows;
}

async function runWithTools(options) {
  const {
    turns = [], userText, instructions, toolDefinitions = [], executeTool,
    admin = false, allowWeb = false,
  } = options;
  const model = admin ? ADMIN_MODEL : DEFAULT_MODEL;
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const customTools = [...toolDefinitions];
  let tools = allowWeb ? [{ type: 'web_search' }, ...customTools] : customTools;
  const conversationInput = inputMessages(turns, userText);
  const makeBody = () => ({
    model,
    instructions,
    input: conversationInput,
    tools,
    tool_choice: 'auto',
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
  });

  let response;
  try {
    response = await postResponse(makeBody(), deadline);
  } catch (error) {
    if (allowWeb && error instanceof OpenAIHttpError && error.status === 400) {
      tools = customTools;
      response = await postResponse(makeBody(), deadline);
    } else throw error;
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const calls = functionCalls(response);
    if (!calls.length) break;
    const outputs = [];
    for (const call of calls) {
      let args = {};
      try { args = call.arguments ? JSON.parse(call.arguments) : {}; }
      catch { args = {}; }
      let result;
      try { result = executeTool ? await executeTool(call.name, args) : { error: 'NO_TOOL_EXECUTOR' }; }
      catch (error) { result = { error: 'TOOL_EXECUTION_FAILED', message: String(error?.message || error).slice(0, 300) }; }
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result ?? null) });
    }
    conversationInput.push(...(response.output || []), ...outputs);
    response = await postResponse(makeBody(), deadline);
  }

  const text = extractText(response);
  if (!text) throw new Error('OPENAI_EMPTY_RESPONSE');
  return { text, responseId: response.id || null, model, provider: 'openai' };
}

function stripJsonFence(value) {
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function classifyCorrection(input) {
  if (!configured()) return null;
  const deadline = Date.now() + 12_000;
  const instructions = [
    'You classify explicit user corrections to a Discord assistant.',
    'Only classify a real misunderstanding of wording, referent, or intended question as valid.',
    'Return JSON only with keys valid, meaning, scope, trigger, explicit, confidence.',
    'scope must be exact_question or general_pattern. Prefer exact_question unless the user clearly teaches a reusable convention.',
  ].join(' ');
  const payload = {
    previous_question: String(input.previousQuestion || '').slice(0, 1200),
    previous_answer: String(input.previousAnswer || '').slice(0, 1600),
    correction_feedback: String(input.feedback || '').slice(0, 1200),
    existing_active_rules: input.existingRules || [],
  };
  const response = await postResponse({
    model: LEARNING_MODEL,
    instructions,
    input: [{ role: 'user', content: JSON.stringify(payload) }],
    max_output_tokens: 280,
    store: false,
  }, deadline);
  try {
    const parsed = JSON.parse(stripJsonFence(extractText(response)));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      valid: Boolean(parsed.valid),
      meaning: String(parsed.meaning || '').trim().slice(0, 260),
      scope: parsed.scope === 'general_pattern' ? 'general_pattern' : 'exact_question',
      trigger: String(parsed.trigger || '').trim().slice(0, 180),
      explicit: Boolean(parsed.explicit),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    };
  } catch {
    return null;
  }
}

module.exports = {
  configured,
  modelLabel,
  runWithTools,
  classifyCorrection,
  extractText,
  functionCalls,
  inputMessages,
  OpenAIHttpError,
};

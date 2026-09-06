'use strict';

const API_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = process.env.NEVERLESS_AI_MODEL || 'gpt-5.4-mini';
const ADMIN_MODEL = process.env.NEVERLESS_AI_ADMIN_MODEL || DEFAULT_MODEL;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_TOOL_ROUNDS = 6;

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

async function postResponse(body, attempt = 0) {
  if (!configured()) throw new Error('OPENAI_API_KEY_MISSING');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
    if (!response.ok) {
      const message = parsed?.error?.message || `OpenAI request failed with HTTP ${response.status}`;
      if (attempt < 1 && (response.status === 429 || response.status >= 500)) {
        await new Promise((resolve) => setTimeout(resolve, response.status === 429 ? 1400 : 800));
        return postResponse(body, attempt + 1);
      }
      throw new OpenAIHttpError(response.status, message);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function inputMessages(turns, userText) {
  const rows = [];
  for (const turn of turns || []) {
    if (!turn?.content || !['user', 'assistant'].includes(turn.role)) continue;
    rows.push({ role: turn.role, content: String(turn.content).slice(0, 5000) });
  }
  rows.push({ role: 'user', content: String(userText || '').slice(0, 7000) });
  return rows.slice(-14);
}

async function runWithTools(options) {
  const {
    turns = [],
    userText,
    instructions,
    toolDefinitions = [],
    executeTool,
    admin = false,
    allowWeb = true,
  } = options;
  const model = admin ? ADMIN_MODEL : DEFAULT_MODEL;
  const customTools = [...toolDefinitions];
  let tools = allowWeb ? [{ type: 'web_search' }, ...customTools] : customTools;

  const firstBody = {
    model,
    instructions,
    input: inputMessages(turns, userText),
    tools,
    tool_choice: 'auto',
    max_output_tokens: 1400,
    store: false,
  };

  let response;
  try {
    response = await postResponse(firstBody);
  } catch (error) {
    // Keep the assistant usable if a selected model/account does not support hosted web search.
    if (allowWeb && error instanceof OpenAIHttpError && error.status === 400) {
      tools = customTools;
      response = await postResponse({ ...firstBody, tools });
    } else {
      throw error;
    }
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const calls = functionCalls(response);
    if (!calls.length) break;
    const outputs = [];
    for (const call of calls) {
      let args = {};
      try { args = call.arguments ? JSON.parse(call.arguments) : {}; }
      catch { args = { _invalid_json: true, raw: String(call.arguments || '').slice(0, 1000) }; }
      let result;
      try {
        result = executeTool ? await executeTool(call.name, args) : { error: 'NO_TOOL_EXECUTOR' };
      } catch (error) {
        result = { error: 'TOOL_EXECUTION_FAILED', message: String(error?.message || error).slice(0, 400) };
      }
      outputs.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result ?? null),
      });
    }
    response = await postResponse({
      model,
      instructions,
      previous_response_id: response.id,
      input: outputs,
      tools,
      tool_choice: 'auto',
      max_output_tokens: 1400,
      store: false,
    });
  }

  const text = extractText(response);
  if (!text) throw new Error('OPENAI_EMPTY_RESPONSE');
  return { text, responseId: response.id || null, model };
}

function stripJsonFence(value) {
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function classifyCorrection(input) {
  if (!configured()) return null;
  const model = process.env.NEVERLESS_AI_LEARNING_MODEL || DEFAULT_MODEL;
  const instructions = [
    'You classify explicit user corrections to a Discord assistant.',
    'Do not infer a correction just because the user disagrees with a conclusion. The feedback must indicate that the assistant misunderstood the question, wording, referent, or desired interpretation.',
    'Return JSON only with keys: valid(boolean), meaning(string), scope("exact_question"|"general_pattern"), trigger(string), explicit(boolean), confidence(number 0..1).',
    'meaning is the corrected interpretation, not an answer to the question.',
    'Use general_pattern only when the user clearly teaches a reusable wording convention. Otherwise exact_question.',
    'explicit=true only when the user clearly states what they meant or a reusable convention.',
  ].join(' ');
  const payload = {
    previous_question: String(input.previousQuestion || '').slice(0, 1500),
    previous_answer: String(input.previousAnswer || '').slice(0, 2200),
    correction_feedback: String(input.feedback || '').slice(0, 1500),
    existing_active_rules: input.existingRules || [],
  };
  const response = await postResponse({
    model,
    instructions,
    input: [{ role: 'user', content: JSON.stringify(payload) }],
    max_output_tokens: 350,
    store: false,
  });
  const text = stripJsonFence(extractText(response));
  try {
    const parsed = JSON.parse(text);
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
  runWithTools,
  classifyCorrection,
  extractText,
  functionCalls,
  inputMessages,
  OpenAIHttpError,
};

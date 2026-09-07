'use strict';

const OPENAI_API_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/responses';
const GEMINI_API_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/interactions';
const OPENAI_DEFAULT_MODEL = process.env.NEVERLESS_AI_MODEL || 'gpt-5.4-mini';
const GEMINI_DEFAULT_MODEL = process.env.NEVERLESS_GEMINI_MODEL || 'gemini-3.7-flash';
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_TOOL_ROUNDS = 6;

class OpenAIHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'OpenAIHttpError';
    this.status = status;
  }
}

class GeminiHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GeminiHttpError';
    this.status = status;
  }
}

function provider() {
  if (String(process.env.GEMINI_API_KEY || '').trim()) return 'gemini';
  if (String(process.env.OPENAI_API_KEY || '').trim()) return 'openai';
  return null;
}

function configured() {
  return Boolean(provider());
}

function providerLabel(admin = false) {
  if (provider() === 'gemini') {
    const model = admin
      ? (process.env.NEVERLESS_GEMINI_ADMIN_MODEL || GEMINI_DEFAULT_MODEL)
      : GEMINI_DEFAULT_MODEL;
    return `Gemini/${model}`;
  }
  if (provider() === 'openai') {
    const model = admin
      ? (process.env.NEVERLESS_AI_ADMIN_MODEL || OPENAI_DEFAULT_MODEL)
      : OPENAI_DEFAULT_MODEL;
    return `OpenAI/${model}`;
  }
  return 'not-configured';
}

async function postJson(url, headers, body, ErrorType, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
    if (!response.ok) {
      const message = parsed?.error?.message || `${ErrorType.name} request failed with HTTP ${response.status}`;
      if (attempt < 1 && (response.status === 429 || response.status >= 500)) {
        await new Promise((resolve) => setTimeout(resolve, response.status === 429 ? 1400 : 800));
        return postJson(url, headers, body, ErrorType, attempt + 1);
      }
      throw new ErrorType(response.status, message);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function extractOpenAIText(response) {
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

function openAIFunctionCalls(response) {
  return (response?.output || []).filter((item) => item?.type === 'function_call' && item.name && item.call_id);
}

async function postOpenAI(body, attempt = 0) {
  const key = String(process.env.OPENAI_API_KEY || '').trim();
  if (!key) throw new Error('OPENAI_API_KEY_MISSING');
  return postJson(
    OPENAI_API_URL,
    { Authorization: `Bearer ${key}` },
    body,
    OpenAIHttpError,
    attempt,
  );
}

function openAIInputMessages(turns, userText) {
  const rows = [];
  for (const turn of turns || []) {
    if (!turn?.content || !['user', 'assistant'].includes(turn.role)) continue;
    rows.push({ role: turn.role, content: String(turn.content).slice(0, 5000) });
  }
  rows.push({ role: 'user', content: String(userText || '').slice(0, 7000) });
  return rows.slice(-14);
}

async function runOpenAIWithTools(options) {
  const {
    turns = [], userText, instructions, toolDefinitions = [], executeTool,
    admin = false, allowWeb = true,
  } = options;
  const model = admin ? (process.env.NEVERLESS_AI_ADMIN_MODEL || OPENAI_DEFAULT_MODEL) : OPENAI_DEFAULT_MODEL;
  const customTools = [...toolDefinitions];
  let tools = allowWeb ? [{ type: 'web_search' }, ...customTools] : customTools;
  const conversationInput = openAIInputMessages(turns, userText);
  const firstBody = {
    model,
    instructions,
    input: conversationInput,
    tools,
    tool_choice: 'auto',
    max_output_tokens: 1400,
    store: false,
  };

  let response;
  try {
    response = await postOpenAI(firstBody);
  } catch (error) {
    if (allowWeb && error instanceof OpenAIHttpError && error.status === 400) {
      tools = customTools;
      response = await postOpenAI({ ...firstBody, tools });
    } else throw error;
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const calls = openAIFunctionCalls(response);
    if (!calls.length) break;
    const outputs = [];
    for (const call of calls) {
      let args = {};
      try { args = call.arguments ? JSON.parse(call.arguments) : {}; }
      catch { args = { _invalid_json: true, raw: String(call.arguments || '').slice(0, 1000) }; }
      let result;
      try { result = executeTool ? await executeTool(call.name, args) : { error: 'NO_TOOL_EXECUTOR' }; }
      catch (error) { result = { error: 'TOOL_EXECUTION_FAILED', message: String(error?.message || error).slice(0, 400) }; }
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result ?? null) });
    }
    conversationInput.push(...(response.output || []), ...outputs);
    response = await postOpenAI({
      model,
      instructions,
      input: conversationInput,
      tools,
      tool_choice: 'auto',
      max_output_tokens: 1400,
      store: false,
    });
  }

  const text = extractOpenAIText(response);
  if (!text) throw new Error('OPENAI_EMPTY_RESPONSE');
  return { text, responseId: response.id || null, model, provider: 'openai' };
}

function geminiInputSteps(turns, userText) {
  const rows = [];
  for (const turn of (turns || []).slice(-12)) {
    if (!turn?.content || !['user', 'assistant'].includes(turn.role)) continue;
    rows.push({
      type: turn.role === 'user' ? 'user_input' : 'model_output',
      content: [{ type: 'text', text: String(turn.content).slice(0, 5000) }],
    });
  }
  rows.push({ type: 'user_input', content: [{ type: 'text', text: String(userText || '').slice(0, 7000) }] });
  return rows;
}

function extractGeminiText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
  const chunks = [];
  for (const step of response?.steps || []) {
    if (step?.type !== 'model_output') continue;
    for (const part of step.content || []) if (part?.type === 'text' && part.text) chunks.push(part.text);
  }
  return chunks.join('\n').trim();
}

function geminiFunctionCalls(response) {
  return (response?.steps || []).filter((step) => step?.type === 'function_call' && step.name && step.id);
}

async function postGemini(body, attempt = 0) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY_MISSING');
  return postJson(
    GEMINI_API_URL,
    {
      'x-goog-api-key': key,
      'x-goog-api-client': 'neverless-discord-bot/1.0',
    },
    body,
    GeminiHttpError,
    attempt,
  );
}

function geminiTools(toolDefinitions, allowWeb) {
  const tools = [...toolDefinitions];
  // Google Search grounding is intentionally opt-in because it may not be available on the free tier.
  if (allowWeb && process.env.NEVERLESS_GEMINI_GOOGLE_SEARCH === '1') tools.unshift({ type: 'google_search' });
  return tools;
}

async function runGeminiWithTools(options) {
  const {
    turns = [], userText, instructions, toolDefinitions = [], executeTool,
    admin = false, allowWeb = true,
  } = options;
  const model = admin
    ? (process.env.NEVERLESS_GEMINI_ADMIN_MODEL || GEMINI_DEFAULT_MODEL)
    : GEMINI_DEFAULT_MODEL;
  const tools = geminiTools(toolDefinitions, allowWeb);
  const history = geminiInputSteps(turns, userText);

  let response = await postGemini({
    model,
    store: false,
    system_instruction: instructions,
    input: history,
    tools,
    generation_config: { max_output_tokens: 1400 },
  });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const calls = geminiFunctionCalls(response);
    if (!calls.length) break;
    history.push(...(response.steps || []));
    for (const call of calls) {
      const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
      let result;
      try { result = executeTool ? await executeTool(call.name, args) : { error: 'NO_TOOL_EXECUTOR' }; }
      catch (error) { result = { error: 'TOOL_EXECUTION_FAILED', message: String(error?.message || error).slice(0, 400) }; }
      history.push({
        type: 'function_result',
        name: call.name,
        call_id: call.id,
        result: [{ type: 'text', text: JSON.stringify(result ?? null) }],
      });
    }
    response = await postGemini({
      model,
      store: false,
      system_instruction: instructions,
      input: history,
      tools,
      generation_config: { max_output_tokens: 1400 },
    });
  }

  const text = extractGeminiText(response);
  if (!text) throw new Error('GEMINI_EMPTY_RESPONSE');
  return { text, responseId: response.id || null, model, provider: 'gemini' };
}

async function runWithTools(options) {
  if (provider() === 'gemini') return runGeminiWithTools(options);
  if (provider() === 'openai') return runOpenAIWithTools(options);
  throw new Error('AI_API_KEY_MISSING');
}

function stripJsonFence(value) {
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function correctionInstructions() {
  return [
    'You classify explicit user corrections to a Discord assistant.',
    'Do not infer a correction just because the user disagrees with a conclusion. The feedback must indicate that the assistant misunderstood the question, wording, referent, or desired interpretation.',
    'Return JSON only with keys: valid(boolean), meaning(string), scope("exact_question"|"general_pattern"), trigger(string), explicit(boolean), confidence(number 0..1).',
    'meaning is the corrected interpretation, not an answer to the question.',
    'Use general_pattern only when the user clearly teaches a reusable wording convention. Otherwise exact_question.',
    'explicit=true only when the user clearly states what they meant or a reusable convention.',
  ].join(' ');
}

function normalizeCorrection(text) {
  try {
    const parsed = JSON.parse(stripJsonFence(text));
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

async function classifyCorrection(input) {
  if (!configured()) return null;
  const payload = {
    previous_question: String(input.previousQuestion || '').slice(0, 1500),
    previous_answer: String(input.previousAnswer || '').slice(0, 2200),
    correction_feedback: String(input.feedback || '').slice(0, 1500),
    existing_active_rules: input.existingRules || [],
  };

  if (provider() === 'gemini') {
    const model = process.env.NEVERLESS_GEMINI_LEARNING_MODEL || GEMINI_DEFAULT_MODEL;
    const response = await postGemini({
      model,
      store: false,
      system_instruction: correctionInstructions(),
      input: [{ type: 'user_input', content: [{ type: 'text', text: JSON.stringify(payload) }] }],
      generation_config: { max_output_tokens: 350 },
    });
    return normalizeCorrection(extractGeminiText(response));
  }

  const model = process.env.NEVERLESS_AI_LEARNING_MODEL || OPENAI_DEFAULT_MODEL;
  const response = await postOpenAI({
    model,
    instructions: correctionInstructions(),
    input: [{ role: 'user', content: JSON.stringify(payload) }],
    max_output_tokens: 350,
    store: false,
  });
  return normalizeCorrection(extractOpenAIText(response));
}

module.exports = {
  configured,
  provider,
  providerLabel,
  runWithTools,
  classifyCorrection,
  extractText: extractOpenAIText,
  functionCalls: openAIFunctionCalls,
  inputMessages: openAIInputMessages,
  OpenAIHttpError,
  GeminiHttpError,
};

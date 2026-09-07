'use strict';

const BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = process.env.NEVERLESS_GEMINI_MODEL || 'gemini-3.7-flash';
const ADMIN_MODEL = process.env.NEVERLESS_GEMINI_ADMIN_MODEL || DEFAULT_MODEL;
const LEARNING_MODEL = process.env.NEVERLESS_GEMINI_LEARNING_MODEL || DEFAULT_MODEL;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_TOOL_ROUNDS = 4;

class GeminiHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GeminiHttpError';
    this.status = status;
  }
}

function configured() {
  return Boolean(String(process.env.GEMINI_API_KEY || '').trim());
}

function modelLabel(admin = false) {
  return admin ? ADMIN_MODEL : DEFAULT_MODEL;
}

function endpoint(model) {
  return `${BASE_URL.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent`;
}

async function postGemini(model, body, attempt = 0) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY_MISSING');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(endpoint(model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch {}
    if (!response.ok) {
      const message = parsed?.error?.message || `Gemini request failed with HTTP ${response.status}`;
      if (attempt < 1 && (response.status === 429 || response.status >= 500)) {
        await new Promise((resolve) => setTimeout(resolve, response.status === 429 ? 1800 : 900));
        return postGemini(model, body, attempt + 1);
      }
      throw new GeminiHttpError(response.status, message);
    }
    return parsed;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeout = new Error('GEMINI_TIMEOUT');
      timeout.code = 'AI_TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function contentsFromTurns(turns, userText) {
  const contents = [];
  for (const turn of (turns || []).slice(-10)) {
    if (!turn?.content || !['user', 'assistant'].includes(turn.role)) continue;
    contents.push({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(turn.content).slice(0, 4500) }],
    });
  }
  contents.push({ role: 'user', parts: [{ text: String(userText || '').slice(0, 6500) }] });
  return contents;
}

function geminiTools(toolDefinitions = []) {
  const functionDeclarations = toolDefinitions
    .filter((tool) => tool?.type === 'function' && tool.name)
    .map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
    }));
  return functionDeclarations.length ? [{ functionDeclarations }] : undefined;
}

function candidateContent(response) {
  return response?.candidates?.[0]?.content || null;
}

function extractText(response) {
  const content = candidateContent(response);
  if (!content) return '';
  return (content.parts || [])
    .filter((part) => typeof part?.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function functionCalls(response) {
  const content = candidateContent(response);
  if (!content) return [];
  return (content.parts || [])
    .filter((part) => part?.functionCall?.name)
    .map((part) => ({
      id: part.functionCall.id || null,
      name: part.functionCall.name,
      args: part.functionCall.args && typeof part.functionCall.args === 'object' ? part.functionCall.args : {},
    }));
}

function requestBody(instructions, contents, tools) {
  const body = {
    systemInstruction: { parts: [{ text: String(instructions || '').slice(0, 12000) }] },
    contents,
    generationConfig: { maxOutputTokens: 1400 },
  };
  if (tools?.length) body.tools = tools;
  return body;
}

async function runWithTools(options) {
  const {
    turns = [], userText, instructions, toolDefinitions = [], executeTool, admin = false,
  } = options;
  const model = admin ? ADMIN_MODEL : DEFAULT_MODEL;
  const contents = contentsFromTurns(turns, userText);
  const tools = geminiTools(toolDefinitions);
  let response = await postGemini(model, requestBody(instructions, contents, tools));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const calls = functionCalls(response);
    if (!calls.length) break;
    const modelContent = candidateContent(response);
    if (modelContent) contents.push(modelContent);
    const parts = [];
    for (const call of calls) {
      let result;
      try {
        result = executeTool ? await executeTool(call.name, call.args) : { error: 'NO_TOOL_EXECUTOR' };
      } catch (error) {
        result = { error: 'TOOL_EXECUTION_FAILED', message: String(error?.message || error).slice(0, 400) };
      }
      parts.push({
        functionResponse: {
          name: call.name,
          response: { result: result ?? null },
          ...(call.id ? { id: call.id } : {}),
        },
      });
    }
    contents.push({ role: 'user', parts });
    response = await postGemini(model, requestBody(instructions, contents, tools));
  }

  const text = extractText(response);
  if (!text) throw new Error('GEMINI_EMPTY_RESPONSE');
  return { text, responseId: response?.responseId || null, model, provider: 'gemini' };
}

function stripJsonFence(value) {
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

async function classifyCorrection(input) {
  const instructions = [
    'You classify explicit user corrections to a Discord assistant.',
    'Do not infer a correction just because the user disagrees with a conclusion.',
    'The feedback must indicate that the assistant misunderstood the question, wording, referent, or intended interpretation.',
    'Return JSON only with keys: valid(boolean), meaning(string), scope("exact_question"|"general_pattern"), trigger(string), explicit(boolean), confidence(number 0..1).',
    'Use general_pattern only when the user clearly teaches a reusable wording convention. Otherwise exact_question.',
  ].join(' ');
  const payload = {
    previous_question: String(input.previousQuestion || '').slice(0, 1500),
    previous_answer: String(input.previousAnswer || '').slice(0, 2200),
    correction_feedback: String(input.feedback || '').slice(0, 1500),
    existing_active_rules: input.existingRules || [],
  };
  const response = await postGemini(LEARNING_MODEL, {
    systemInstruction: { parts: [{ text: instructions }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload) }] }],
    generationConfig: { maxOutputTokens: 350, responseMimeType: 'application/json' },
  });
  try {
    const parsed = JSON.parse(stripJsonFence(extractText(response)));
    return {
      valid: Boolean(parsed?.valid),
      meaning: String(parsed?.meaning || '').trim().slice(0, 260),
      scope: parsed?.scope === 'general_pattern' ? 'general_pattern' : 'exact_question',
      trigger: String(parsed?.trigger || '').trim().slice(0, 180),
      explicit: Boolean(parsed?.explicit),
      confidence: Math.max(0, Math.min(1, Number(parsed?.confidence) || 0)),
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
  GeminiHttpError,
};

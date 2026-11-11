// The HTTP door, for callers that can't hold a service binding (a GitHub Action, say). A bearer token names
// the app, the way a binding's props.app does: the Worker secret TOKENS maps sha-256(token) to an app, so the
// token itself is never stored here. Chat only, no streaming, small requests. Nothing is logged or kept.
import { CHAT_CHAIN } from './policy.mjs';

export const LIMITS = { messages: 8, chars: 12000, maxTokens: 400 };
const ROLES = new Set(['system', 'user', 'assistant']);

export async function sha256(text) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The app a bearer token speaks for, or null. tokens: the TOKENS secret, JSON { sha256: app }. */
export async function appForToken(tokens, header) {
  const m = /^Bearer (\S{16,200})$/.exec(header || '');
  if (!m) return null;
  let map; try { map = JSON.parse(tokens || '{}'); } catch { return null; }
  const h = await sha256(m[1]);
  return Object.hasOwn(map, h) ? map[h] : null;
}

/** A request body fit to run, or { error }. Only chat models in the fallback chain; never a stream. */
export function chatRequest(body) {
  if (!body || typeof body !== 'object') return { error: 'the body must be a JSON object' };
  const model = body.model ?? CHAT_CHAIN[0];
  if (!CHAT_CHAIN.includes(model)) return { error: `model must be one of ${CHAT_CHAIN.join(', ')}` };
  const msgs = body.messages;
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > LIMITS.messages) return { error: `messages: 1 to ${LIMITS.messages}` };
  let chars = 0;
  for (const m of msgs) {
    if (!m || !ROLES.has(m.role) || typeof m.content !== 'string') return { error: 'each message is { role: system|user|assistant, content: string }' };
    chars += m.content.length;
  }
  if (chars > LIMITS.chars) return { error: `messages are over ${LIMITS.chars} characters` };
  const max = Number.isInteger(body.max_tokens) ? Math.min(Math.max(body.max_tokens, 16), LIMITS.maxTokens) : 256;
  return { model, input: { messages: msgs.map(({ role, content }) => ({ role, content })), max_tokens: max, stream: false, chat_template_kwargs: { enable_thinking: false } } };
}

/** The text of a non-streamed answer, whichever shape the model returned. */
export function textOf(out) {
  if (typeof out?.response === 'string') return out.response;
  const c = out?.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : '';
}

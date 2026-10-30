'use strict';
/**
 * The conversation the chat view shows (BACKLOG #157, documentation/DESIGN_CHAT_VIEW.md).
 *
 *   createChatFeed({ now }) -> { handle(event) -> changed, snapshot() -> { messages, working },
 *                                pendingHistory() -> path | null, seedHistory(messages) -> changed }
 *
 * Built from the CLI's own hooks and from nothing else, the way host/prompt-keeper.js is:
 *   UserPromptSubmit.prompt         -> a "you" message
 *   Stop.last_assistant_message     -> a Claude message (the CLI's recommended source, over parsing the transcript)
 * A tool call, its result, a dialog and everything a subagent says never reach it: the chat is Ricardo <-> Claude.
 * A prompt that is another session's message (`<cross-session-message ...>`) is a one-line note and its content is
 * dropped. `working` is true from a prompt until the turn's Stop (or StopFailure / SessionEnd).
 *
 * Earlier messages come from the transcript, which is internal to the CLI and "can break on any release": a resume
 * asks for it ONCE (pendingHistory), host/chat-transcript.js parses it tolerantly, and seedHistory puts what it found
 * BEFORE what the hooks already gave, never repeating a line.
 *
 * The text is untrusted model/user text: it is cut to TEXT_MAX here and is never parsed as HTML anywhere
 * (app/chat-blocks.js builds DOM nodes; no innerHTML).
 */

const TEXT_MAX = 20000;
const MESSAGE_CAP = 200;
const CROSS_SESSION = /^\s*<cross-session-message\b/;
const NOTE_TEXT = 'A message from another session arrived';

const isMain = (p) => !(typeof p.agent_id === 'string' && p.agent_id !== '');
const cut = (text) => (text.length <= TEXT_MAX ? { text, truncated: false }
  : { text: text.slice(0, TEXT_MAX).replace(/[\uD800-\uDBFF]$/, ''), truncated: true });

function createChatFeed({ now = Date.now } = {}) {
  let messages = [];
  let working = false;
  let seq = 0;
  let transcriptPath = null;
  let wantHistory = false;

  function push(role, raw) {
    const { text, truncated } = cut(raw);
    messages.push({ id: ++seq, role, text, truncated, at: now() });
    if (messages.length > MESSAGE_CAP) messages = messages.slice(messages.length - MESSAGE_CAP);
  }

  function reset() {
    const changed = messages.length > 0 || working;
    messages = [];
    working = false;
    return changed;
  }

  function apply(event, p) {
    if (event === 'SessionStart') {
      if (typeof p.transcript_path === 'string' && p.transcript_path !== '') transcriptPath = p.transcript_path;
      if (p.source === 'compact') return false;
      wantHistory = p.source === 'resume' && transcriptPath !== null;
      return reset();
    }
    if (!isMain(p)) return false;
    switch (event) {
      case 'UserPromptSubmit': {
        working = true;
        if (typeof p.prompt !== 'string' || p.prompt.trim() === '') return true;
        if (CROSS_SESSION.test(p.prompt)) push('note', NOTE_TEXT);
        else push('user', p.prompt);
        return true;
      }
      case 'Stop': {
        const was = working;
        working = false;
        const said = typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '';
        if (said.trim() === '') return was;
        const last = messages[messages.length - 1];
        // Stop can fire more than once around one turn ending: a second identical reply with no prompt between is the same reply.
        if (last && last.role === 'assistant' && last.text === cut(said).text) return was;
        push('assistant', said);
        return true;
      }
      // Esc interrupts a turn and fires no Stop; Claude Code's idle_prompt is the only word that it is back at the prompt (host/turn-state.js)
      case 'Notification': {
        if (p.notification_type !== 'idle_prompt') return false;
        const was = working;
        working = false;
        return was;
      }
      case 'StopFailure':
      case 'SessionEnd': {
        const was = working;
        working = false;
        return was;
      }
      default:
        return false;
    }
  }

  function handle(ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.event !== 'string') return false;
    return apply(ev.event, ev.payload && typeof ev.payload === 'object' ? ev.payload : {});
  }

  const key = (m) => `${m.role}\u0000${m.text}`;

  function seedHistory(history) {
    if (!wantHistory) return false;
    wantHistory = false;
    if (!Array.isArray(history)) return false;
    const old = history.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim() !== '');
    // The hooks' first line may already be in the transcript (it was written while we read): stop before it.
    let upTo = old.length;
    if (messages.length) {
      const at = old.findIndex(m => key(m) === key(messages[0]));
      if (at >= 0) upTo = at;
    }
    const prefix = old.slice(0, upTo);
    if (prefix.length === 0) return false;
    const keep = messages;
    messages = [];
    for (const m of prefix) push(m.role, m.text);
    // Re-id what the hooks gave so ids still only grow.
    for (const m of keep) messages.push({ ...m, id: ++seq });
    if (messages.length > MESSAGE_CAP) messages = messages.slice(messages.length - MESSAGE_CAP);
    return true;
  }

  return {
    handle,
    snapshot: () => ({ messages: messages.map(m => ({ ...m })), working }),
    pendingHistory: () => (wantHistory ? transcriptPath : null),
    seedHistory,
  };
}

module.exports = { createChatFeed, TEXT_MAX, MESSAGE_CAP };

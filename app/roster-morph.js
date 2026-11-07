'use strict';
/**
 * Patching a roster card in place (BACKLOG #184, #17 F4's rest).
 *
 * A press is a mousedown and a mouseup on the same element. When a repaint swapped a card's node between the two, the mouseup
 * landed on the replacement and no `click` fired: a press on a busy card (repainted about once a second) could be dropped.
 * PR #239 A5 narrowed the swap to the cards whose markup changed (app/agent-state-display.js rosterPatch); this module patches
 * such a card IN PLACE instead: attributes and text are synced onto the live nodes, so the card and every control in it that is
 * still the same control keep their identity, and the press lands. A hovered card's `title` changes on the same node too.
 *
 * A control that turned into ANOTHER one (another tag, class, or data-* attribute: a Pause turned Resume, a hide turned unhide,
 * another face video) is replaced, never morphed into the other: a held press must not fire an action that wasn't pressed. Its
 * old node goes through `hooks.removed` (the renderer unloads its videos) and the new one through `hooks.added` (watched, paused).
 *
 * Loaded two ways: require() from tests, and a plain <script> in the renderer, which shares one global scope (hence the IIFE).
 */
(function (root) {

/** What a node IS for the morph: an element's tag, class and every data-* attribute; title, text, src and the rest are content. */
function identity(n) {
  if (!n || n.nodeType !== 1) return 'n' + (n ? n.nodeType : '');
  const data = [];
  for (const a of n.attributes) if (a.name.startsWith('data-')) data.push(a.name + '=' + a.value);
  data.sort();
  return 'e' + n.tagName + '\u0000' + (n.getAttribute('class') || '') + '\u0000' + data.join('\u0000');
}

// Only what differs is written: setting a video's `src` to the value it already has would reload it.
function syncAttributes(el, fresh) {
  for (const a of [...el.attributes]) if (!fresh.hasAttribute(a.name)) el.removeAttribute(a.name);
  for (const a of fresh.attributes) if (el.getAttribute(a.name) !== a.value) el.setAttribute(a.name, a.value);
}

function drop(n, hooks) {
  hooks.removed(n);
  n.remove();
}

// Fresh children in order; each takes the first old child at or after the cursor that is the same kind of node, the old ones
// skipped on the way are removed, and a fresh child with no match is inserted (moved out of the staged markup).
function morphChildren(el, fresh, hooks) {
  const olds = [...el.childNodes];
  const ids = olds.map(identity);
  let cursor = 0;
  for (const f of [...fresh.childNodes]) {
    const want = identity(f);
    let j = cursor;
    while (j < olds.length && ids[j] !== want) j++;
    if (j < olds.length) {
      for (let k = cursor; k < j; k++) drop(olds[k], hooks);
      patch(olds[j], f, hooks);
      cursor = j + 1;
    } else {
      el.insertBefore(f, cursor < olds.length ? olds[cursor] : null);
      hooks.added(f);
    }
  }
  for (let k = cursor; k < olds.length; k++) drop(olds[k], hooks);
}

function patch(old, fresh, hooks) {
  if (old.nodeType !== 1) {
    if (old.nodeValue !== fresh.nodeValue) old.nodeValue = fresh.nodeValue;
    return;
  }
  syncAttributes(old, fresh);
  morphChildren(old, fresh, hooks);
}

const NO_HOOK = () => {};

/**
 * Make `old` (live, in the document) equal to `fresh` (staged markup of the same card), keeping every node that is still the
 * same kind of node. The card's root is matched by its caller (rosterPatch's key), so only its tag must agree; a root of another
 * tag is replaced. Returns the node now in the document. `hooks` = { removed(node), added(node) }, each optional.
 */
function morphElement(old, fresh, hooks) {
  const h = { removed: (hooks && hooks.removed) || NO_HOOK, added: (hooks && hooks.added) || NO_HOOK };
  if (old.nodeType !== 1 || fresh.nodeType !== 1 || old.tagName !== fresh.tagName) {
    h.removed(old);
    old.replaceWith(fresh);
    h.added(fresh);
    return fresh;
  }
  patch(old, fresh, h);
  return old;
}

const api = { morphElement, identity };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  root.rosterMorph = api;
}

})(typeof window !== 'undefined' ? window : globalThis);

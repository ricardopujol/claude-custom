'use strict';
/**
 * A small fake document for the renderer-side modules that take a `doc` (app/git-rings-display.js builds its panel
 * with doc.createElement / createElementNS and finds things by delegation). Not a browser: just enough of the DOM for the
 * calls those modules make, so their DOM half can be driven from `node --test` without jsdom.
 *
 * Supported: element creation (both namespaces), attributes, `hidden`/`dataset`/`style`/`classList`, textContent,
 * appendChild, contains, closest, querySelector(All) over compound selectors (tag, .class, #id, [attr], [attr="v"])
 * joined by commas, addEventListener + a bubbling dispatch, focus/activeElement, and settable layout numbers.
 * This file requires nothing from app/ or host/, so it is a test helper, not a subject.
 */

const parseCompound = (s) => {
  const m = /^([A-Za-z][\w-]*)?/.exec(s);
  const sel = { tag: m && m[1] ? m[1].toLowerCase() : null, classes: [], id: null, attrs: [] };
  for (const t of s.slice(m ? m[0].length : 0).matchAll(/([.#])([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    if (t[1] === '.') sel.classes.push(t[2]);
    else if (t[1] === '#') sel.id = t[2];
    else sel.attrs.push([t[3], t[4]]);
  }
  return sel;
};
// Only what parseCompound honours. Anything else (a descendant or child combinator, a pseudo-class, a quote other than
// the double quotes of [attr="v"]) THROWS, so a module that starts to use it fails loudly instead of matching nothing.
const SUPPORTED = /^[A-Za-z0-9_\-.#[\]="]+$/;
const parse = (selector) => String(selector).split(',').map((s) => {
  const c = s.trim();
  if (!SUPPORTED.test(c)) throw new Error(`fake-dom: unsupported selector ${JSON.stringify(String(selector))}`);
  return parseCompound(c);
});

class FakeElement {
  constructor(doc, tag, ns) {
    this.ownerDocument = doc;
    this.tagName = String(tag);
    this.namespaceURI = ns || null;
    this.attrs = new Map();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this._text = '';
    this.layout = { width: 0, height: 0 };
    this.clientWidth = 0;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.visible = true;
    const self = this;
    this.classList = {
      _set: () => new Set(String(self.attrs.get('class') || '').split(/\s+/).filter(Boolean)),
      _put: (set) => { self.attrs.set('class', [...set].join(' ')); },
      contains(c) { return this._set().has(c); },
      add(c) { const s = this._set(); s.add(c); this._put(s); },
      remove(c) { const s = this._set(); s.delete(c); this._put(s); },
      toggle(c, force) {
        const s = this._set();
        const on = force === undefined ? !s.has(c) : !!force;
        if (on) s.add(c); else s.delete(c);
        this._put(s);
        return on;
      },
    };
  }

  get hidden() { return this.attrs.has('hidden'); }
  set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
  get id() { return this.attrs.get('id') || ''; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.root; }
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._text; }
  set textContent(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = String(v);
  }

  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(c) { if (c.parentNode) c.parentNode.children = c.parentNode.children.filter(x => x !== c); c.parentNode = this; this.children.push(c); this._text = ''; return c; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }

  _matches(sel) {
    return (!sel.tag || this.tagName.toLowerCase() === sel.tag)
      && sel.classes.every(c => this.classList.contains(c))
      && (!sel.id || this.attrs.get('id') === sel.id)
      && sel.attrs.every(([k, v]) => this.attrs.has(k) && (v === undefined || this.attrs.get(k) === v));
  }
  matches(selector) { return parse(selector).some(s => this._matches(s)); }
  closest(selector) { for (let n = this; n && n.matches; n = n.parentNode) if (n.matches(selector)) return n; return null; }
  querySelectorAll(selector) {
    const sels = parse(selector);
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (sels.some(s => c._matches(s))) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  getBoundingClientRect() {
    const { width, height } = this.layout;
    return { left: 0, top: 0, right: width, bottom: height, width, height };
  }
  getClientRects() { return this.visible ? [this.getBoundingClientRect()] : []; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }

  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  /** Dispatch an event at this element; it bubbles up to the root. Returns the event. */
  dispatch(type, props = {}) {
    const e = { type, target: this, relatedTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
    for (let n = this; n; n = n.parentNode) {
      e.currentTarget = n;
      for (const fn of n.listeners.get(type) || []) fn(e);
    }
    return e;
  }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.visibilityState = 'visible';
    this.root = new FakeElement(this, 'html');
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createElementNS(ns, tag) { return new FakeElement(this, tag, ns); }
}

/** A panel as renderer.html has it: a root holding #git-status and #git-dial, attached to the document. */
function makePanel() {
  const doc = new FakeDocument();
  const rootEl = doc.createElement('section');
  doc.root.appendChild(rootEl);
  const status = doc.createElement('div'); status.setAttribute('id', 'git-status'); rootEl.appendChild(status);
  const dial = doc.createElement('div'); dial.setAttribute('id', 'git-dial'); rootEl.appendChild(dial);
  return { doc, rootEl, status, dial };
}

module.exports = { FakeDocument, FakeElement, makePanel };

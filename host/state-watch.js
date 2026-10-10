'use strict';
/**
 * Tells the windows of THIS host when an install-wide state file was changed by ANOTHER host (BACKLOG #80: the medals and the
 * bubbles' switch live in `.harness/state`, but every tab is its own host process, and a broadcast only reaches its own windows).
 *
 *   createChangeWatch({ read, onChange })
 *     .tick()   read now; when the value differs from the last one seen, remember it and call onChange(value)
 *     .note(value)  this host just changed it itself and told its windows `value`: remember THAT value, never a second read (a change
 *                   another host makes between the broadcast and a re-read would be swallowed, and the windows left stale)
 *
 * Polled (the host's own 1 s clock calls tick() every few seconds) rather than fs.watch: the file is a few KB, a missed event
 * would mean a stale window until restart, and a replace-by-rename is exactly what fs.watch on Windows loses track of.
 * A read that throws is a missed look, not a change. Values are compared by their JSON.
 */

function createChangeWatch({ read, onChange } = {}) {
  if (typeof read !== 'function' || typeof onChange !== 'function') throw new Error('createChangeWatch: read and onChange are required');
  const look = () => { try { return { value: read() }; } catch { return null; } };
  const first = look();
  let last = first ? JSON.stringify(first.value) : undefined;

  return {
    tick() {
      const now = look();
      if (!now) return false;
      const key = JSON.stringify(now.value);
      if (key === last) return false;
      last = key;
      onChange(now.value);
      return true;
    },
    note(value) {
      last = JSON.stringify(value);
    },
  };
}

module.exports = { createChangeWatch };

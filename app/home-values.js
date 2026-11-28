'use strict';
/**
 * The strict value checks Jiandu Home's model and record share (PR #262 Miguel G7: one copy, not two). Pure.
 *
 *   timeOf(v)  a strict positive finite number, else null. Never coerce: `Number(null)` is 0, and an absence shown as a zero is
 *              the bug this project keeps catching.
 *   countOf(v) a strict non-negative integer, else null.
 *   isPath(p)  a non-empty string.
 */

const timeOf = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const countOf = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const isPath = (p) => typeof p === 'string' && p !== '';

module.exports = { timeOf, countOf, isPath };

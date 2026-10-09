'use strict';
/**
 * Properties of the commit graph's lane assignment (BACKLOG #2 follow-up): whatever the shape of the
 * history, every commit is in exactly one lane, every parent is drawn below its child (newest on top,
 * as `git log --graph` does), and every edge ends in the lane its parent really sits in.
 *
 * The generator builds a DAG already in log order (children before parents), with merges of up to
 * four parents, tips with no child, and parents that fall outside the window.
 */
const test = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');

const { assignLanes } = require('../host/git-graph');

const dagArb = fc.integer({ min: 0, max: 40 }).chain(n =>
  fc.tuple(...Array.from({ length: n }, (_, i) =>
    fc.uniqueArray(fc.integer({ min: i + 1, max: n + 3 }), { maxLength: 4 }))))
  .map(parentIdx => parentIdx.map((ps, i) => ({
    hash: `h${i}`,
    // indexes past the last commit are outside the window
    parents: ps.map(p => `h${p}`),
    time: 0, author: 'a', subject: '', refs: [],
  })));

test('every commit is in exactly one row and one lane inside [0, laneCount)', () => {
  fc.assert(fc.property(dagArb, commits => {
    const g = assignLanes(commits);
    assert.strictEqual(g.rows.length, commits.length);
    g.rows.forEach((r, i) => {
      assert.strictEqual(r.hash, commits[i].hash);
      assert.ok(Number.isInteger(r.lane) && r.lane >= 0 && r.lane < g.laneCount);
    });
    assert.strictEqual(new Set(g.rows.map(r => r.hash)).size, commits.length);
  }));
});

test('parents are drawn below their child, and a merge connects real lanes', () => {
  fc.assert(fc.property(dagArb, commits => {
    const g = assignLanes(commits);
    const rowOf = new Map(g.rows.map((r, i) => [r.hash, i]));
    g.rows.forEach((r, i) => {
      assert.deepStrictEqual(r.edges.map(e => e.hash), commits[i].parents, 'one edge per parent, in order');
      r.edges.forEach((e, k) => {
        assert.strictEqual(e.merge, k > 0);
        assert.ok(e.lane >= 0 && e.lane < g.laneCount);
        if (rowOf.has(e.hash)) {
          assert.ok(e.row > i, 'the parent is below its child');
          assert.strictEqual(e.row, rowOf.get(e.hash));
          assert.strictEqual(e.lane, g.rows[e.row].lane, 'the edge ends in the lane its parent sits in');
        } else {
          assert.strictEqual(e.row, null);
        }
      });
    });
  }));
});

test('no commit sits on a lane another commit\'s edge is running down', () => {
  fc.assert(fc.property(dagArb, commits => {
    const g = assignLanes(commits);
    g.rows.forEach((r, i) => {
      for (const e of r.edges) {
        const end = e.row === null ? g.rows.length : e.row;
        for (let k = i + 1; k < end; k++) {
          assert.notStrictEqual(g.rows[k].lane, e.lane,
            `row ${k} sits on lane ${e.lane} under the edge ${i} -> ${e.hash}`);
        }
      }
    });
  }));
});

test('edges running down one lane at the same row lead to the same parent', () => {
  fc.assert(fc.property(dagArb, commits => {
    const g = assignLanes(commits);
    for (let k = 0; k < g.rows.length; k++) {
      const byLane = new Map();
      g.rows.forEach((r, i) => {
        if (i >= k) return;
        for (const e of r.edges) {
          const end = e.row === null ? Infinity : e.row;
          if (end <= k) continue;
          if (!byLane.has(e.lane)) byLane.set(e.lane, new Set());
          byLane.get(e.lane).add(e.hash);
        }
      });
      for (const hashes of byLane.values()) assert.ok(hashes.size <= 1, 'two different parents share a lane at row ' + k);
    }
  }));
});

test('no hash is ever waited for in two lanes: every edge to one parent runs down one lane', () => {
  fc.assert(fc.property(dagArb, commits => {
    const g = assignLanes(commits);
    const laneOf = new Map();
    for (const r of g.rows) {
      for (const e of r.edges) {
        if (laneOf.has(e.hash)) assert.strictEqual(laneOf.get(e.hash), e.lane, 'two lanes wait for ' + e.hash);
        laneOf.set(e.hash, e.lane);
      }
    }
  }));
});

test('the lane count is at most the number of commits plus their parents (it never grows from nothing)', () => {
  fc.assert(fc.property(dagArb, commits => {
    const g = assignLanes(commits);
    const parents = new Set(commits.flatMap(x => x.parents));
    assert.ok(g.laneCount <= commits.length + parents.size);
    if (commits.length) assert.ok(g.laneCount >= 1);
  }));
});

test('assignLanes does not change its input', () => {
  fc.assert(fc.property(dagArb, commits => {
    const before = JSON.stringify(commits);
    assignLanes(commits);
    assert.strictEqual(JSON.stringify(commits), before);
  }));
});

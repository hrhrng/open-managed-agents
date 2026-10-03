import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewDiff, assessReview } from './agent-code-review.mjs';

const codeFile = (patch, filename = 'src/runtime.ts') => ({ filename, status: 'modified', patch });

test('review gate refuses truncated source patches rather than silently approving them', () => {
  assert.throws(() => buildReviewDiff([codeFile(undefined)]), /missing patch/);
  assert.throws(() => buildReviewDiff([codeFile('x'.repeat(100))], 20), /exceeds/);
});

test('review gate sends bounded complete patches and ignores binary assets', () => {
  assert.equal(buildReviewDiff([codeFile('@@ -1 +1 @@\n-a\n+b'), {
    filename: 'logo.png', status: 'modified', patch: undefined,
  }]), 'FILE src/runtime.ts (modified)\n@@ -1 +1 @@\n-a\n+b');
});

test('review gate blocks high-severity findings with a location', () => {
  const report = { summary: 'Persistence is process-local', findings: [{ severity: 'high', path: 'src/runtime.ts', line: 42, description: 'Replica B cannot read outputs' }] };
  assert.equal(assessReview(report).passed, false);
});

test('review gate rejects malformed, unlocated and incomplete model reports', () => {
  assert.throws(() => assessReview({ summary: '', findings: [] }), /summary/);
  assert.throws(() => assessReview({ summary: 'ok' }), /findings/);
  assert.throws(() => assessReview({ summary: 'ok', findings: [{ severity: 'high', description: 'lost state' }] }), /location/);
});

test('review gate permits only well-formed reports with no high or critical findings', () => {
  assert.deepEqual(assessReview({ summary: 'Checked durability', findings: [{ severity: 'medium', path: 'src/runtime.ts', line: 3, description: 'Document retry' }] }), { passed: true, blocking: [] });
});

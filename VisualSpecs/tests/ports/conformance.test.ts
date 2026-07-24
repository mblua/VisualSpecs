// The shared conformance suite (§8.3), run against FakeRenderer, headless.
//
// The SAME suite runs against Canvas2DRenderer in a real browser — see
// `tests/smoke/adapter.spec.ts`. The cases that need real input are reported as
// SKIPPED here rather than faked, because a fake cannot prove hit-testing or event
// ordering, and pretending otherwise is how a seam rots.

import { describe, expect, it } from 'vitest';
import { FakeRenderer } from '../../src/adapters/fake/FakeRenderer.ts';
import { runConformance } from '../../src/ports/renderer.conformance.ts';

describe('GraphRenderer conformance — FakeRenderer', () => {
  it('passes every case that does not need real input', async () => {
    const report = await runConformance({
      name: 'FakeRenderer',
      makeRenderer: () => new FakeRenderer(),
      makeHost: () => ({}) as HTMLElement,
    });

    const failures = report.results.filter((r) => r.status === 'fail');
    expect(failures.map((f) => `${f.name}: ${f.message ?? ''}`)).toEqual([]);
    expect(report.passed).toBeGreaterThanOrEqual(9);
  });

  it('honestly reports the input cases as SKIPPED, rather than passing them', async () => {
    const report = await runConformance({
      name: 'FakeRenderer',
      makeRenderer: () => new FakeRenderer(),
      makeHost: () => ({}) as HTMLElement,
    });
    expect(report.skipped).toBe(12);
    for (const r of report.results.filter((x) => x.status === 'skip')) {
      expect(r.message).toContain('FakeRenderer');
    }
  });
});

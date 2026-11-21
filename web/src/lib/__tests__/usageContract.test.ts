// Usage (Settings > Usage) UI contract.
//
// No headless browser here, so the invariants — the Usage section existing in
// Settings, aggregating all sessions (not just the open project), showing the
// balance, and the usage styles — are pinned against the source files.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const settings = read('../../ui/settings.ts');
const css = read('../../styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
const agent = read('../agent.ts');

describe('Settings exposes a Usage section', () => {
  it('registers Usage as a nav section right after Account', () => {
    const m = /const SECTIONS = \[([^\]]+)\]/.exec(settings);
    expect(m).toBeTruthy();
    const sections = m![1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    const acct = sections.indexOf('Account');
    const usage = sections.indexOf('Usage');
    expect(acct).toBeGreaterThanOrEqual(0);
    expect(usage).toBe(acct + 1);
  });

  it('builds a section("Usage") page', () => {
    expect(settings).toMatch(/section\('Usage'\)/);
  });

  it('aggregates usage across ALL sessions (unscoped /session)', () => {
    expect(settings).toContain('aggregateUsage');
    // Fetches the session list directly (not the project-scoped agentStore).
    expect(settings).toMatch(/oc\.get<[^>]*>\('\/session'/);
  });

  it('shows the account balance from auth:status', () => {
    expect(settings).toContain('barang().auth.status');
  });

  it('offers a refresh action and a dashboard link', () => {
    expect(settings).toContain('usageLoad');
    expect(settings).toContain('app.kilo.ai');
  });

  it('aggregateUsage is exported from agent.ts', () => {
    expect(agent).toContain('export function aggregateUsage');
  });
});

describe('usage styles exist', () => {
  for (const cls of ['.usage-box', '.usage-balance', '.usage-chips', '.usage-grid', '.usage-model-row', '.usage-skeleton']) {
    it(`defines ${cls}`, () => {
      expect(css).toContain(cls);
    });
  }
});
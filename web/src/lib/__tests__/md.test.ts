import { describe, expect, it } from 'vitest';
import { md } from '../util';

describe('md — line breaks survive rendering', () => {
  it('keeps single newlines inside one paragraph', () => {
    expect(md('a\nb')).toBe('<p>a<br>b</p>');
  });

  it('turns blank lines into separate paragraphs', () => {
    expect(md('a\n\nb')).toBe('<p>a</p><p>b</p>');
    expect(md('a\n\n\nb')).toBe('<p>a</p><p>b</p>');
  });

  it('renders a typed prompt exactly as authored', () => {
    const src = 'For the chat session tabs, make it similar to our file tabs\nso we stay consistent.\n\nMake sure to not break anything.\nMake sure to run tests and pass.';
    expect(md(src)).toBe(
      '<p>For the chat session tabs, make it similar to our file tabs<br>so we stay consistent.</p>'
      + '<p>Make sure to not break anything.<br>Make sure to run tests and pass.</p>',
    );
  });
});

describe('md — blocks around paragraphs', () => {
  it('closes the paragraph before headings and lists', () => {
    expect(md('intro\n# Title\nbody')).toBe('<p>intro</p><h1>Title</h1><p>body</p>');
    expect(md('intro\n- one\n- two\noutro'))
      .toBe('<p>intro</p><ul><li>one</li><li>two</li></ul><p>outro</p>');
  });

  it('keeps fenced code intact between paragraphs', () => {
    expect(md('a\n```ts\nconst x = 1\n```\nb'))
      .toBe('<p>a</p><pre class="md-code"><code data-lang="ts">const x = 1</code></pre><p>b</p>');
  });

  it('escapes HTML and still applies inline styles', () => {
    expect(md('a < b **c**')).toBe('<p>a &lt; b <strong>c</strong></p>');
  });

  it('returns nothing for empty input', () => {
    expect(md('')).toBe('');
    expect(md('\n\n')).toBe('');
  });
});

describe('md — tables', () => {
  it('renders a pipe table as <table>', () => {
    expect(md('| a | b |\n| --- | --- |\n| 1 | 2 |'))
      .toBe('<div class="md-table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead>'
        + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>');
  });

  it('honors column alignment from the separator row', () => {
    expect(md('| L | C | R |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |'))
      .toBe('<div class="md-table-wrap"><table><thead><tr>'
        + '<th style="text-align:left">L</th><th style="text-align:center">C</th><th style="text-align:right">R</th>'
        + '</tr></thead><tbody><tr>'
        + '<td style="text-align:left">1</td><td style="text-align:center">2</td><td style="text-align:right">3</td>'
        + '</tr></tbody></table></div>');
  });

  it('applies inline formatting and escapes HTML inside cells', () => {
    expect(md('| **x** | y |\n| --- | --- |\n| `z` | a < b |'))
      .toBe('<div class="md-table-wrap"><table><thead><tr><th><strong>x</strong></th><th>y</th></tr></thead>'
        + '<tbody><tr><td><code class="md-inline">z</code></td><td>a &lt; b</td></tr></tbody></table></div>');
  });

  it('pads short rows and truncates long rows to the header width', () => {
    expect(md('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n| 4 | 5 | 6 | 7 |'))
      .toBe('<div class="md-table-wrap"><table><thead><tr><th>a</th><th>b</th><th>c</th></tr></thead>'
        + '<tbody>'
        + '<tr><td>1</td><td>2</td><td></td></tr>'
        + '<tr><td>4</td><td>5</td><td>6</td></tr>'
        + '</tbody></table></div>');
  });

  it('omits <tbody> when there are no data rows', () => {
    expect(md('| a | b |\n| --- | --- |'))
      .toBe('<div class="md-table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead></table></div>');
  });

  it('sits between surrounding paragraphs', () => {
    expect(md('intro\n| a | b |\n| --- | --- |\n| 1 | 2 |\noutro'))
      .toBe('<p>intro</p>'
        + '<div class="md-table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead>'
        + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>'
        + '<p>outro</p>');
  });
});

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

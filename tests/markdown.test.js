// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/sidepanel/markdown.js';

describe('renderMarkdown (EC-UI-01, EC-UI-03, EC-INJ-04)', () => {
  it('renders ordinary markdown', () => {
    const html = renderMarkdown('**Bold** and `code`\n\n- one\n- two');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
  });

  it('shows raw HTML as text instead of running it', () => {
    const html = renderMarkdown('Hello <script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('drops markdown images (could be tracking pixels), keeping alt text', () => {
    const html = renderMarkdown('![a chart](https://tracker.example/pixel.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('a chart');
  });

  it('removes javascript: and data: links but keeps http(s) links with safe rel', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('javascript:');
    expect(renderMarkdown('[x](data:text/html,hi)')).not.toContain('data:');
    const html = renderMarkdown('[docs](https://example.com/a)');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('strips style and event-handler attributes', () => {
    // Raw HTML from the model is shown as text, so no element gets these attributes.
    const box = document.createElement('div');
    box.innerHTML = renderMarkdown('<p style="color:red" onclick="x()">hi</p> and **bold**');
    const attrs = [...box.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name));
    expect(attrs.filter((a) => a === 'style' || a.startsWith('on'))).toEqual([]);
    expect(box.querySelector('p p, [onclick]')).toBeNull();
    expect(box.textContent).toContain('<p style="color:red" onclick="x()">hi</p>');
  });
});

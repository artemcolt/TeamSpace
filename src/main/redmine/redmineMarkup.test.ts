import { describe, expect, it } from 'vitest';
import { markdownToRedmineHtml } from './redmineMarkup';

describe('markdownToRedmineHtml', () => {
  it('formats agent markdown for Redmine descriptions', () => {
    const html = markdownToRedmineHtml([
      '## Что было сделано',
      '',
      '- Добавлена вкладка **GitLab**',
      '- Подключен `BrowserView`',
      '',
      'Первая строка описания',
      'Вторая строка описания',
      '',
      '<script>alert(1)</script>'
    ].join('\n'));

    expect(html).toContain('<h2>Что было сделано</h2>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>Добавлена вкладка <strong>GitLab</strong></li>');
    expect(html).toContain('<li>Подключен <code>BrowserView</code></li>');
    expect(html).toContain('<p>Первая строка описания<br>Вторая строка описания</p>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

// Markdown → safe HTML for model output. The assistant reads web pages, so its text may contain injected HTML/script
// (prompt injection). Everything is sanitised before rendering; links open in a new tab without referrer.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer nofollow'); }
});

export function md(text: string): string {
  return DOMPurify.sanitize(marked.parse(text ?? '', { async: false }) as string, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'hr', 'del'],
    ALLOWED_ATTR: ['href', 'title'],
    ALLOWED_URI_REGEXP: /^(https?:|mailto:|#)/i,   // no javascript: or data: links
  });
}

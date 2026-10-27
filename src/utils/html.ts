function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function escapeHtmlTemplate(
  strings: TemplateStringsArray,
  ...values: (string | number)[]
): string {
  let result = '';

  for (let i = 0; i < strings.length; i++) {
    const str = strings[i] ?? '';
    const value = values[i] ?? '';
    result += str + escapeHtml(value.toString());
  }

  return result;
}

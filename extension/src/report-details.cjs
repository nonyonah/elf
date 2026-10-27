function cells(line) {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}
function reportSection(markdown, title) {
  const lines = markdown.split('\n');
  const index = lines.indexOf(`### ${title === 'Deprecations overdue' ? 'Deprecation overdue' : title}`);
  if (index < 0) return null;
  let end = index + 1;
  while (end < lines.length && !lines[end].startsWith('### ')) end++;
  const section = lines.slice(index, end);
  const table = section.filter(line => line.startsWith('|'));
  const headers = table.length ? cells(table[0]) : [];
  const items = table.slice(2).map(line => {
    const values = cells(line); const name = values[0].replace(/`/g, '');
    return { name, summary: headers.map((header, i) => i ? `${header}: ${values[i] || '—'}` : '').filter(Boolean).join(' · '),
      content: `# ${name}\n\n${headers.map((header, i) => `${header}: ${values[i] || '—'}`).join('\n\n')}\n` };
  });
  return { content: section.join('\n'), items };
}
// Newest first. Hide unchanged repeated checks without discarding intervening
// sync/error events or a check whose resource fingerprint actually changed.
function compactActivity(items) {
  let previousCheck;
  return items.filter(item => {
    if (item.type !== 'check') return true;
    const key = item.fingerprint || item.message;
    if (key === previousCheck) return false;
    previousCheck = key; return true;
  });
}
module.exports = { reportSection, compactActivity };

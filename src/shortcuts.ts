export function shortcutKey(event: Pick<KeyboardEvent, 'code' | 'key'>): string {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  if (event.code === 'BracketLeft') return '[';
  if (event.code === 'BracketRight') return ']';
  const key = event.key.toLowerCase();
  // Virtual keyboards can omit physical key codes.
  if ((!event.code || event.code === 'Unidentified') && key.length === 1) {
    const russian = 'йцукенгшщзхъфывапролджэячсмитьбю';
    const english = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";
    return english[russian.indexOf(key)] ?? key;
  }
  return key;
}

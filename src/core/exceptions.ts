/** Eine Ausnahme-Zeile (.gitignore-Art), die genau diesen Pfad trifft: am Vault-Anfang verankert, `* ? \` und ein führendes `#`/`!` maskiert. */
export function exceptionLine(path: string): string {
  const escaped = path.replace(/[\\*?]/g, "\\$&").replace(/^([#!])/, "\\$1");
  return `/${escaped}`;
}

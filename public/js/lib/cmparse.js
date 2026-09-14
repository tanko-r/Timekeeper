// Pull a CM# (6-digit client number + 6-digit matter number) out of
// arbitrary pasted text — a bare "123456-123456", or that same pair buried
// in a whole paragraph. The lookaround on both ends rejects any digit run
// that isn't exactly 12 digits long (optionally split by one separator), so
// a longer account number, phone number, or ZIP+date elsewhere in the text
// never gets sliced into a false match.
const CM_IN_TEXT = /(?<!\d)(\d{6})[-.\s]?(\d{6})(?!\d)/;

export function extractCmDigits(text) {
  const m = CM_IN_TEXT.exec(String(text ?? ''));
  return m ? { clientNumber: m[1], matterNumber: m[2] } : null;
}

// The CM number (client/matter) is the derived string client_number-matter_number,
// e.g. "100001-000012". Client and matter numbers are each exactly six digits.
export const SIX = /^\d{6}$/;

export function buildCmNumber(clientNumber, matterNumber) {
  return `${clientNumber}-${matterNumber}`;
}

export function splitCmNumber(cm) {
  const m = /^(\d{6})-(\d{6})$/.exec(String(cm ?? ''));
  return m ? { clientNumber: m[1], matterNumber: m[2] } : null;
}

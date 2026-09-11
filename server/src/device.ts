/** Constant-time authentication for physical clients opening the shared socket. */
export function deviceIsAuthorized(authorization: string | null, expected: string): boolean {
  const given = authorization ?? "";
  const wanted = `Bearer ${expected}`;
  if (given.length !== wanted.length || expected.length === 0) return false;
  let difference = 0;
  for (let index = 0; index < wanted.length; index += 1) {
    difference |= given.charCodeAt(index) ^ wanted.charCodeAt(index);
  }
  return difference === 0;
}

export class LocalError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const requireValue = (condition, code, status) => {
  if (!condition) throw new LocalError(code, status);
};

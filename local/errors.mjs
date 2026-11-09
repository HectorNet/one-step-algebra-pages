export class LocalError extends Error {
  constructor(code, status = 400, diagnostic) {
    super(code); this.code = code; this.status = status;
    if (diagnostic) this.diagnostic = diagnostic;
  }
}
export const requireValue = (condition, code, status) => {
  if (!condition) throw new LocalError(code, status);
};

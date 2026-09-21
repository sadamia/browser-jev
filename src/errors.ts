export type BjErrorCode =
  | "not_found"
  | "ambiguous"
  | "low_confidence"
  | "timeout"
  | "expectation"
  | "navigation"
  | "not_actionable"
  | "config";

export class BjError extends Error {
  code: BjErrorCode;
  details: Record<string, unknown>;
  constructor(code: BjErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "BjError";
    this.code = code;
    this.details = details;
  }
}

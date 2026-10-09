export type FoxmemoryCode =
  | "bad_input"
  | "not_found"
  | "redacted"
  | "embed_failed"
  | "full"
  | "bad_import"
  | "corrupt"
  | "locked"
  | "unavailable";

/** Every failure in foxmemory. `code` says what went wrong. */
export class FoxmemoryError extends Error {
  readonly code: FoxmemoryCode;

  constructor(code: FoxmemoryCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FoxmemoryError";
    this.code = code;
  }
}

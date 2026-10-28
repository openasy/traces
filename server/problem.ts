export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "invalid-query"
  | "not-found"
  | "not-configured"
  | "payload-too-large"
  | "storage-unavailable"
  | "internal-error";

/** An error the API answers with Problem Details (ADR 0014); `code` is the stable part clients match on. */
export class TracesError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

export const bad = (detail: string) => new TracesError(422, "invalid-body", detail);
export const badQuery = (detail: string) => new TracesError(400, "invalid-query", detail);
export const notFound = (what: string) => new TracesError(404, "not-found", `${what} does not exist.`);

/** A plain object from a request body, or undefined. */
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

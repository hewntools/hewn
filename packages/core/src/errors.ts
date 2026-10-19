// SPDX-License-Identifier: AGPL-3.0-or-later
export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "not_ready"
  | "invalid_request"
  | "invalid_input"
  | "invalid_output"
  | "operation_failed"
  | "awaiting_confirmation";

export class PlatformError extends Error {
  code: ErrorCode;
  details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

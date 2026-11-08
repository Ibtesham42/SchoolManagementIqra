export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = new.target.name;
  }
  get status() {
    return STATUS[this.code];
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Please sign in to continue.") {
    super("UNAUTHENTICATED", message);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action.") {
    super("FORBIDDEN", message);
  }
}
export class NotFoundError extends AppError {
  constructor(message = "Not found.") {
    super("NOT_FOUND", message);
  }
}
export class ConflictError extends AppError {
  constructor(message: string) {
    super("CONFLICT", message);
  }
}
export class ValidationError extends AppError {
  constructor(message: string, details?: { path: string; message: string }[]) {
    super("VALIDATION_FAILED", message, details);
  }
}
export class RateLimitedError extends AppError {
  constructor(message = "Too many attempts. Please try again later.") {
    super("RATE_LIMITED", message);
  }
}
/** Thrown when a free-tier usage cap configured for an external service is reached. */
export class QuotaExceededError extends AppError {
  constructor(message: string) {
    super("QUOTA_EXCEEDED", message);
  }
}

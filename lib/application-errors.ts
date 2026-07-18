export type ApplicationErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "concurrency_conflict"
  | "invalid_transition"
  | "duplicate_command"
  | "dependency_conflict"
  | "database_unavailable";

export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationFailedError extends ApplicationError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation_failed", message, details);
  }
}

export class ConcurrencyConflictError extends ApplicationError {
  constructor(details?: Record<string, unknown>, options?: ErrorOptions) {
    super("concurrency_conflict", "The aggregate changed before this command could be applied", details, options);
  }
}

export class DatabaseUnavailableError extends ApplicationError {
  constructor(options?: ErrorOptions) {
    super("database_unavailable", "The database is temporarily unavailable", undefined, options);
  }
}

export class NotFoundError extends ApplicationError {
  constructor(resource: string) {
    super("not_found", `${resource} was not found`);
  }
}

export class InvalidTransitionError extends ApplicationError {
  constructor(aggregate: string, from: string, to: string) {
    super("invalid_transition", `${aggregate} cannot transition from ${from} to ${to}`, { aggregate, from, to });
  }
}

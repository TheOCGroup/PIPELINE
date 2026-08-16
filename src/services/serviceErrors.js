/** Typed, safe service errors. Messages never contain secrets or paths. */

export class ValidationError extends Error {
  constructor(message, { field } = {}) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
    this.code = "invalid_request";
    this.field = field;
  }
}

export class NotFoundError extends Error {
  constructor(message = "not_found") {
    super(message);
    this.name = "NotFoundError";
    this.status = 404;
    this.code = "not_found";
  }
}

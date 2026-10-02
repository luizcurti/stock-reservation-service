export class customError extends Error {
  public status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'customError';
    // Fix prototype chain for instanceof checks when targeting ES5/ES2015
    Object.setPrototypeOf(this, new.target.prototype);
    // Optional: improve stack trace clarity in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, customError);
    }
  }
}

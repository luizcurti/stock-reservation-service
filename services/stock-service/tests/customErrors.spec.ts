import { customError } from '../src/customErrors/customErrors';

describe('customError', () => {
  it('should create error with correct properties', () => {
    const error = new customError(404, 'Not found');

    expect(error.status).toBe(404);
    expect(error.message).toBe('Not found');
    expect(error).toBeInstanceOf(customError);
  });

  it('should create error with different status codes', () => {
    const badRequestError = new customError(400, 'Bad request');
    const serverError = new customError(500, 'Internal server error');

    expect(badRequestError.status).toBe(400);
    expect(badRequestError.message).toBe('Bad request');

    expect(serverError.status).toBe(500);
    expect(serverError.message).toBe('Internal server error');
  });

  it('should handle various error messages', () => {
    const error = new customError(422, 'Validation error');

    expect(error.status).toBe(422);
    expect(error.message).toBe('Validation error');
    expect(error).toBeInstanceOf(customError);
  });
});

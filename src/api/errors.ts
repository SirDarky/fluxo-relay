export class ApiError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

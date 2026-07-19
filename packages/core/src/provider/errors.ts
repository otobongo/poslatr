// Provider error taxonomy (PRD ISS-005). The scheduler's retry policy keys off
// these classes and nothing else, so mapping discipline in providers is what
// keeps retries sane.
//
// Mapping guidance (the first concrete provider codifies it; every provider
// follows the same shape):
//   RetryableProviderError  429, 5xx, network failures, timeouts. The worker
//                           retries with exponential backoff + jitter, max 5.
//   TerminalProviderError   4xx validation-class failures (422 and kin).
//                           No retry; dead-letter + user notification.
//   AuthExpiredError        401/invalid-token. No retry; the connection is
//                           marked broken and the user is asked to reconnect.

export class ProviderError extends Error {
  readonly providerId: string;

  constructor(providerId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderError';
    this.providerId = providerId;
  }
}

export class RetryableProviderError extends ProviderError {
  constructor(providerId: string, message: string, options?: { cause?: unknown }) {
    super(providerId, message, options);
    this.name = 'RetryableProviderError';
  }
}

export class TerminalProviderError extends ProviderError {
  constructor(providerId: string, message: string, options?: { cause?: unknown }) {
    super(providerId, message, options);
    this.name = 'TerminalProviderError';
  }
}

export class AuthExpiredError extends ProviderError {
  constructor(providerId: string, message: string, options?: { cause?: unknown }) {
    super(providerId, message, options);
    this.name = 'AuthExpiredError';
  }
}

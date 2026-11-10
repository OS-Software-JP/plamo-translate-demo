import type {WorkerErrorCode, WorkerFailure} from '../protocol';

export class WorkerError extends Error {
  readonly code: WorkerErrorCode;
  readonly inputTokens?: number;
  readonly tokenLimit?: number;

  constructor(code: WorkerErrorCode, message: string, tokens?: {inputTokens: number; tokenLimit: number}) {
    super(message);
    this.code = code;
    this.inputTokens = tokens?.inputTokens;
    this.tokenLimit = tokens?.tokenLimit;
  }
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function toFailure(error: unknown): WorkerFailure {
  if (error instanceof WorkerError) {
    return {code: error.code, message: error.message, inputTokens: error.inputTokens, tokenLimit: error.tokenLimit};
  }
  return {code: 'unknown', message: errorMessage(error)};
}

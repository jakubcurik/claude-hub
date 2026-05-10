// SPDX-License-Identifier: Apache-2.0
export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_error'
  | 'rate_limited'
  | 'conflict'
  | 'internal_error'
  | 'invalid_input'
  | 'unsupported_type'
  | 'sha256_mismatch'
  | 'slug_taken'
  | 'version_exists';

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

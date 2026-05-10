// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'invalid slug');

export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'must be MAJOR.MINOR.PATCH');

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'must be 64 hex chars');

export const artifactTypeSchema = z.enum(['skill', 'plugin', 'command', 'agent']);

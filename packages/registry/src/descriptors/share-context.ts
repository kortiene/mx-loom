import { defineDescriptor, type ToolDescriptor } from '../descriptor.js';
import { JSON_SCHEMA_DIALECT } from '../validator.js';

/**
 * `mx_share_context` — publish a file / diff / env artifact to the workspace.
 * Backed by `share.file` / `share.diff` / `share.env` in T107. `sync`.
 */
export const MX_SHARE_CONTEXT: ToolDescriptor = defineDescriptor({
  name: 'mx_share_context',
  description: 'Publish a shared context artifact (file, diff, or env snapshot) to the workspace.',
  async_semantics: 'sync',
  input_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_share_context input',
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['file', 'diff', 'env'], description: 'The kind of artifact to share.' },
      path: { type: 'string', description: 'Logical path/name of the artifact.' },
      content: { type: 'string', description: 'Inline artifact content (≤256 KiB; larger uses the media path).' },
      encoding: { type: 'string', enum: ['utf-8', 'base64'], description: 'Encoding of `content`.' },
    },
    required: ['kind'],
    additionalProperties: false,
  },
  output_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_share_context result',
    type: 'object',
    properties: {
      context_id: { type: 'string', description: 'Id to fetch the artifact back via mx_get_context.' },
      sha256: { type: 'string', description: 'Content digest for integrity verification.' },
    },
    required: ['context_id', 'sha256'],
    additionalProperties: false,
  },
});

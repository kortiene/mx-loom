import { defineDescriptor, type ToolDescriptor } from '../descriptor.js';
import { JSON_SCHEMA_DIALECT } from '../validator.js';

/**
 * `mx_get_context` — fetch a shared artifact by id. Backed by `share.list` /
 * `share.get` in T107. `sync`.
 */
export const MX_GET_CONTEXT: ToolDescriptor = defineDescriptor({
  name: 'mx_get_context',
  description: 'Fetch a shared context artifact by its id.',
  async_semantics: 'sync',
  input_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_get_context input',
    type: 'object',
    properties: {
      context_id: { type: 'string', description: 'The artifact id returned by mx_share_context.' },
    },
    required: ['context_id'],
    additionalProperties: false,
  },
  output_schema: {
    $schema: JSON_SCHEMA_DIALECT,
    title: 'mx_get_context result',
    type: 'object',
    properties: {
      context_id: { type: 'string' },
      kind: { type: 'string', enum: ['file', 'diff', 'env'] },
      sha256: { type: 'string' },
      size_bytes: { type: 'integer', minimum: 0 },
      inline: { type: 'string', description: 'Inline content when small enough to embed.' },
      media_mxc: { type: 'string', description: 'Matrix media reference (mxc://) when stored out-of-band.' },
    },
    required: ['context_id'],
    additionalProperties: true,
  },
});

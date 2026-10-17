/**
 * @fileoverview Barrel export for all tool definitions.
 * @module mcp-server/tools/definitions
 */

import { arxivGetMetadata } from './arxiv-get-metadata.tool.js';
import { arxivListCategories } from './arxiv-list-categories.tool.js';
import { arxivReadPaper } from './arxiv-read-paper.tool.js';
import { arxivSearchPapers } from './arxiv-search-papers.tool.js';

export const allToolDefinitions = [
  arxivSearchPapers,
  arxivGetMetadata,
  arxivReadPaper,
  arxivListCategories,
];

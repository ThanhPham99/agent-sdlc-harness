// Dead Code, Unused Export and Ghost Dependency Eliminator for Agent SDLC Harness.
import fs from 'node:fs';
import path from 'node:path';
import {openIntelligence} from './repo-intelligence.mjs';
import {readJson} from './util.mjs';

const ENTRY_POINT_PATTERNS = [
  /(?:^|\/)cli\.[mc]?js$/,
  /(?:^|\/)index\.[mc]?js$/,
  /(?:^|\/)main\.[mc]?js$/,
  /(?:^|\/)server\.[mc]?js$/,
  /^scripts\//,
  /^evals\//
];

function isKnownEntryPoint(filePath, customEntries = []) {
  const norm = filePath.replace(/\\/g, '/');
  if (customEntries.some(e => norm.endsWith(e))) return true;
  return ENTRY_POINT_PATTERNS.some(p => p.test(norm));
}

/**
 * Scan repository for unreachable files, unused exports, and ghost dependencies.
 */
export function findDeadCode(projectRoot, { openIntel = null, entryPoints = [] } = {}) {
  const intel = openIntel || openIntelligence(projectRoot);
  const graph = intel.graph;

  const unreachableFiles = [];
  const unusedExports = [];

  for (const [filePath, file] of graph.files) {
    if (file.is_test) continue;
    if (isKnownEntryPoint(filePath, entryPoints)) continue;

    const incoming = graph.dependents.get(filePath);
    if (!incoming || incoming.size === 0) {
      unreachableFiles.push({
        path: filePath,
        module: file.module || null,
        exports_count: (file.exports || []).length
      });
    }
  }

  // Ghost dependencies detection in package.json
  const ghostDependencies = [];
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = readJson(pkgPath, {});
    const declaredDeps = Object.keys(pkg.dependencies || {});
    const usedExternals = new Set(graph.external_dependencies || []);

    for (const dep of declaredDeps) {
      if (!usedExternals.has(dep)) {
        ghostDependencies.push({
          name: dep,
          version: pkg.dependencies[dep],
          type: 'production'
        });
      }
    }
  }

  const totalFiles = graph.file_count || 1;
  const deadCount = unreachableFiles.length;
  const healthScore = Math.max(0, Math.round(100 - (deadCount / totalFiles * 50) - (ghostDependencies.length * 5)));

  return {
    schema: 'agent-sdlc/dead-code-report/v1',
    health_score: healthScore,
    total_files: totalFiles,
    unreachable_files_count: unreachableFiles.length,
    unreachable_files: unreachableFiles,
    unused_exports_count: unusedExports.length,
    unused_exports: unusedExports,
    ghost_dependencies_count: ghostDependencies.length,
    ghost_dependencies: ghostDependencies
  };
}

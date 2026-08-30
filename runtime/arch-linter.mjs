// Architectural Linter and Module Boundary Enforcer for Agent SDLC Harness.
import {openIntelligence} from './repo-intelligence.mjs';

const norm = p => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Find all circular dependency cycles in the repository import graph.
 */
export function findCircularDependencies(graph) {
  const adj = new Map();
  for (const [p] of graph.files) adj.set(p, new Set());
  for (const e of graph.edges) {
    if (e.from && e.to && e.from !== e.to) {
      if (!adj.has(e.from)) adj.set(e.from, new Set());
      adj.get(e.from).add(e.to);
    }
  }

  const visited = new Map(); // 0: unvisited, 1: visiting, 2: visited
  const stack = [];
  const foundCycles = [];
  const cycleSignatures = new Set();

  function dfs(node) {
    visited.set(node, 1);
    stack.push(node);

    for (const neighbor of adj.get(node) || []) {
      const state = visited.get(neighbor) || 0;
      if (state === 1) {
        // Cycle detected: extract cycle slice from stack
        const cycleStartIndex = stack.indexOf(neighbor);
        if (cycleStartIndex !== -1) {
          const cycle = stack.slice(cycleStartIndex);
          // Normalize rotation to avoid duplicate cycle representations
          const minIdx = cycle.reduce((min, cur, idx) => cur < cycle[min] ? idx : min, 0);
          const normalized = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
          const signature = normalized.join(' -> ');
          if (!cycleSignatures.has(signature)) {
            cycleSignatures.add(signature);
            foundCycles.push(normalized);
          }
        }
      } else if (state === 0) {
        dfs(neighbor);
      }
    }

    stack.pop();
    visited.set(node, 2);
  }

  for (const [node] of adj) {
    if ((visited.get(node) || 0) === 0) {
      dfs(node);
    }
  }

  return {
    cycles: foundCycles,
    cycle_count: foundCycles.length
  };
}

/**
 * Check module boundary rules and layering constraints.
 */
export function checkModuleBoundaries(graph, { rules = [] } = {}) {
  const violations = [];
  for (const e of graph.edges) {
    const fromFile = graph.files.get(e.from);
    const toFile = graph.files.get(e.to);
    if (!fromFile || !toFile) continue;

    // Cross-module import check
    if (fromFile.module && toFile.module && fromFile.module !== toFile.module) {
      // Check if importing test file from non-test file
      if (toFile.is_test && !fromFile.is_test) {
        violations.push({
          type: 'PRODUCTION_IMPORTS_TEST',
          from: e.from,
          to: e.to,
          reason: `Production file "${e.from}" imports test file "${e.to}"`
        });
      }
    }
  }

  return {
    violations,
    violation_count: violations.length
  };
}

/**
 * Perform a full architectural governance audit on the repository.
 */
export function auditArchitecture(projectRoot, { strict = false, openIntel = null } = {}) {
  const intel = openIntel || openIntelligence(projectRoot);
  const circ = findCircularDependencies(intel.graph);
  const bounds = checkModuleBoundaries(intel.graph);

  const totalIssues = circ.cycle_count + bounds.violation_count;
  const status = totalIssues === 0 ? 'PASS' : (strict ? 'FAIL' : 'WARN');

  return {
    schema: 'agent-sdlc/arch-audit/v1',
    status,
    file_count: intel.graph.file_count,
    edge_count: intel.graph.edge_count,
    circular_dependencies: circ.cycles,
    circular_dependency_count: circ.cycle_count,
    boundary_violations: bounds.violations,
    boundary_violation_count: bounds.violation_count,
    total_issues: totalIssues
  };
}

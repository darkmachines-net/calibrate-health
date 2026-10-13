/** @file Select changed release components using semantic identities and explicit adapter-owned cohorts and dependencies. */
import { immutable, invariant, validateId } from './core.mjs';

/**
 * Select enabled components whose semantic identity differs from their completed baseline, then expand cohorts/dependencies.
 * Reasons are descriptive and never force selection; force must be explicit. Missing baselines select first releases.
 * Dependencies mean a selected component requires another release component, not a workflow execution ordering.
 */
export function selectComponents({ components, groups = [], dependencies = [] }) {
  invariant(Array.isArray(components) && Array.isArray(groups) && Array.isArray(dependencies), 'Release selection requires component, group, and dependency arrays.');
  const states = new Map();
  for (const component of components) {
    validateId(component.id, 'Component id');
    validateId(component.kind, 'Component kind');
    invariant(!states.has(component.id), `Duplicate component ${component.id}.`);
    invariant(typeof component.identity === 'string' && component.identity.length > 0, `Component ${component.id} needs an identity.`);
    invariant(component.baselineIdentity == null || typeof component.baselineIdentity === 'string' && component.baselineIdentity.length > 0, `Component ${component.id} baseline is invalid.`);
    invariant(component.enabled === undefined || typeof component.enabled === 'boolean', 'Component enabled must be boolean.');
    invariant(component.force === undefined || typeof component.force === 'boolean', 'Component force must be boolean.');
    invariant(component.reasons === undefined || Array.isArray(component.reasons) && component.reasons.every((reason) => typeof reason === 'string' && reason.length > 0), 'Component reasons must be nonempty strings.');
    const enabled = component.enabled !== false;
    const selected = enabled && (component.force === true || component.identity !== component.baselineIdentity);
    const reasons = new Set(selected ? component.reasons ?? [] : []);
    if (selected) reasons.add(component.force ? 'forced' : component.baselineIdentity == null ? 'missing-baseline' : 'identity-changed');
    states.set(component.id, { id: component.id, kind: component.kind, enabled, selected, reasons });
  }
  function lookup(id) {
    invariant(states.has(id), `Unknown release component ${id}.`);
    return states.get(id);
  }
  const cohorts = groups.map((group) => {
    invariant(Array.isArray(group) && group.length > 0 && new Set(group).size === group.length, 'Release groups must be nonempty lists of distinct component ids.');
    group.forEach(lookup);
    return [...group].sort();
  });
  const edges = dependencies.map((dependency) => {
    lookup(dependency.component);
    invariant(Array.isArray(dependency.requires) && new Set(dependency.requires).size === dependency.requires.length, 'Dependency requires must contain distinct component ids.');
    dependency.requires.forEach(lookup);
    return { component: dependency.component, requires: [...dependency.requires].sort() };
  });
  let changed = true;
  function select(id, reason) {
    const state = lookup(id);
    invariant(state.enabled, `Selected release requires disabled component ${id}.`);
    if (!state.selected) { state.selected = true; changed = true; }
    state.reasons.add(reason);
  }
  while (changed) {
    changed = false;
    for (const cohort of cohorts) {
      const selected = cohort.filter((id) => lookup(id).selected);
      for (const source of selected) for (const target of cohort) if (target !== source) select(target, `group:${source}`);
    }
    for (const edge of edges) {
      if (lookup(edge.component).selected) for (const target of edge.requires) if (target !== edge.component) select(target, `required-by:${edge.component}`);
    }
  }
  const result = [...states.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(({ id, kind, selected, reasons }) => ({ id, kind, selected, reasons: [...reasons].sort() }));
  const selected = result.filter((component) => component.selected).map((component) => component.id);
  return immutable({ selected, noop: selected.length === 0, components: result });
}

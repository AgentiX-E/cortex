/**
 * The reach a contract reports, checked against the reach the same contract assembles.
 *
 * ## The failure this file exists for
 *
 * Run `42310779222` was audited by the arm's own readout and the audit said:
 *
 * ```
 * FAIL  reach  ask=verbatim touches ['multi-session', 'flat', 'temporal', 'abstention'],
 *              of which ['abstention', 'flat', 'multi-session', 'temporal'] never rendered
 * ```
 *
 * The run was fine. `RENDERING_ROUTES['evidence-blocks-unsourced']` was `[]`, because the
 * author read the table as "which routes draw a **sourced** rendering" and the answer for
 * that contract is "none". But `[]` is the *baseline's* answer and the baseline's alone --
 * `abstention` administers no rendering, so naming routes there would claim a treatment the
 * control never received -- and every other contract is administered on every route, because
 * `instructionsFor` returns the contract's own block for every route an ask does not override.
 *
 * So the artifact read as §12.8's defect: a contract named, four of five capabilities never
 * reached. The audit caught it, which is what the audit is for, and this file is the check
 * that would have caught it before the run -- for free, in a second, without an artifact.
 *
 * ## What can be asserted here and what cannot
 *
 * The **route vocabulary** is the product's and this package cannot import it (the same
 * layering that makes `PROMPT_CONTRACTS` a checked duplicate). What is asserted is the
 * *relation* between the two tables this package does own: a contract that assembles a route
 * must also render on it, and `[]` is reserved for the contract that does nothing at all.
 * Relation assertions are what the wrong value violated; a literal list would have needed
 * updating in the same commit as the mistake.
 */
import { describe, expect, it } from 'vitest';

import {
  cortextMemoryArmOptions,
  PROMPT_CONTRACTS,
  toMemoryArmConfig,
} from '../bench-memory-arm.js';

/** The config a run with this contract would publish, built the way a dispatch builds it. */
function configFor(contract: string) {
  return toMemoryArmConfig(
    cortextMemoryArmOptions({ CORTEX_MEMORY: '1', CORTEX_MEMORY_PROMPT_CONTRACT: contract }),
  );
}

const CONTRACTS = Object.keys(PROMPT_CONTRACTS);

describe('the reach a contract reports', () => {
  it('names no route only for the control, and names the control only once', () => {
    const silent = CONTRACTS.filter(
      (contract) => (configFor(contract).renderingRoutes ?? []).length === 0,
    );
    // The one entry, with its reason: `abstention` administers no rendering, so a non-empty
    // list would claim a treatment the control side of every A/B never received.
    expect(silent).toEqual(['abstention']);
  });

  it('reaches the same routes on every other contract, because the block is a fallthrough', () => {
    // The mechanism, not a coincidence: `instructionsFor` begins with
    // `const own = CONTRACT_INSTRUCTIONS[contract](date)` and returns it for every route an
    // ask does not override. A contract therefore cannot reach a subset of the vocabulary --
    // and the contract that reported a subset was the one that was wrong.
    const reaches = CONTRACTS.filter((contract) => contract !== 'abstention').map(
      (contract) => configFor(contract).renderingRoutes,
    );
    for (const list of reaches) expect(list).toEqual(reaches[0]);
    expect(reaches[0] ?? []).toHaveLength(6);
  });

  it('never assembles a route it does not also render', () => {
    // The invariant `42310779222` violated, stated as a relation so it cannot be satisfied by
    // editing one list: `assemblyRoutes` is `['multi-session']` for the two `instruction-first`
    // contracts, and a rendering reach that omitted `multi-session` made the artifact claim an
    // assembly administered on a route the run never rendered.
    for (const contract of CONTRACTS) {
      const config = configFor(contract);
      const rendered = new Set(config.renderingRoutes);
      for (const route of config.assemblyRoutes ?? []) expect(rendered.has(route)).toBe(true);
    }
  });

  it('renders the routes the shipped ask touches, for every contract that administers one', () => {
    // `ask=verbatim` is the shipped ask (§13.248) and the one every recent artifact ran. Its
    // reach is fixed at four routes, written here rather than read from the product for the
    // layering reason above; the assertion is that no non-control contract can be dispatched
    // under the shipped ask and leave one of those four unrendered.
    const VERBATIM_ROUTES = ['multi-session', 'flat', 'temporal', 'abstention'];
    for (const contract of CONTRACTS) {
      const rendered = new Set(configFor(contract).renderingRoutes);
      const unrendered = VERBATIM_ROUTES.filter((route) => !rendered.has(route));
      expect(unrendered).toEqual(contract === 'abstention' ? VERBATIM_ROUTES : []);
    }
  });

  it('reports the assembly only where the product applies one', () => {
    // The other half of the pair, held to the same rule: an assembly reach on the control would
    // claim an order change nobody received, and an assembly on a flat contract would claim a
    // builder that cannot take the option (`buildPrompt`'s signature does not carry it).
    //
    // Two contracts select the reference's order and one does not: `abstention-evidence-blocks`
    // renders without assembling, which is why the assertion is the **equivalence** rather than
    // "every non-control contract assembles". A non-empty list beside an absent `promptAssembly`
    // would be a reach the artifact cannot name.
    for (const contract of CONTRACTS) {
      const config = configFor(contract);
      const assembles = (config.assemblyRoutes ?? []).length > 0;
      expect(assembles).toBe(config.promptAssembly !== undefined);
      if (assembles) expect(config.promptAssembly).toBe('instruction-first');
      if (contract === 'abstention') expect(assembles).toBe(false);
    }
  });
});

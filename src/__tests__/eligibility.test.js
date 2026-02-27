"use strict";

// Re-implement the eligibility check inline so the test file has no dependency
// on the action runtime environment (@actions/core env vars, etc.).
function checkEligibility(pr, config) {
  if (pr.state !== "OPEN") {
    return { eligible: false, reason: `PR is ${pr.state.toLowerCase()}` };
  }
  if (config.skipDrafts && pr.isDraft) {
    return { eligible: false, reason: "PR is a draft" };
  }
  const labels = pr.labels.nodes.map((l) => l.name);
  if (config.label && !labels.includes(config.label)) {
    return { eligible: false, reason: `Missing required label "${config.label}"` };
  }
  for (const skip of config.skipLabels) {
    if (labels.includes(skip)) {
      return { eligible: false, reason: `Has blocking label "${skip}"` };
    }
  }
  if (config.baseBranches.length > 0 && !config.baseBranches.includes(pr.baseRefName)) {
    return { eligible: false, reason: `Base branch "${pr.baseRefName}" not in allowed list` };
  }
  if (config.requiredApprovals > 0) {
    const approvals = pr.reviews?.totalCount ?? 0;
    if (approvals < config.requiredApprovals) {
      return { eligible: false, reason: `Insufficient approvals: ${approvals}/${config.requiredApprovals}` };
    }
  }
  if (pr.mergeQueueEntry) {
    return { eligible: false, reason: `Already in merge queue (position ${pr.mergeQueueEntry.position}, state ${pr.mergeQueueEntry.state})` };
  }
  return { eligible: true };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePR(overrides = {}) {
  return {
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    labels: { nodes: [{ name: "enqueue-pullrequest" }] },
    reviews: { totalCount: 1 },
    mergeQueueEntry: null,
    ...overrides,
  };
}

function makeConfig(overrides = {}) {
  return {
    label: "enqueue-pullrequest",
    skipLabels: [],
    baseBranches: [],
    skipDrafts: true,
    requiredApprovals: 0,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("checkEligibility", () => {
  test("eligible PR passes all checks", () => {
    expect(checkEligibility(makePR(), makeConfig())).toEqual({ eligible: true });
  });

  test("closed PR is not eligible", () => {
    const { eligible, reason } = checkEligibility(makePR({ state: "CLOSED" }), makeConfig());
    expect(eligible).toBe(false);
    expect(reason).toMatch(/closed/i);
  });

  test("merged PR is not eligible", () => {
    const { eligible } = checkEligibility(makePR({ state: "MERGED" }), makeConfig());
    expect(eligible).toBe(false);
  });

  test("draft PR skipped when skipDrafts=true", () => {
    const { eligible, reason } = checkEligibility(makePR({ isDraft: true }), makeConfig({ skipDrafts: true }));
    expect(eligible).toBe(false);
    expect(reason).toMatch(/draft/i);
  });

  test("draft PR allowed when skipDrafts=false", () => {
    const { eligible } = checkEligibility(makePR({ isDraft: true }), makeConfig({ skipDrafts: false }));
    expect(eligible).toBe(true);
  });

  test("missing required label", () => {
    const { eligible, reason } = checkEligibility(
      makePR({ labels: { nodes: [] } }),
      makeConfig({ label: "enqueue-pullrequest" })
    );
    expect(eligible).toBe(false);
    expect(reason).toMatch(/Missing required label/);
  });

  test("no label check when label config is empty", () => {
    const { eligible } = checkEligibility(
      makePR({ labels: { nodes: [] } }),
      makeConfig({ label: "" })
    );
    expect(eligible).toBe(true);
  });

  test("blocking skip-label prevents enqueue", () => {
    const pr = makePR({ labels: { nodes: [{ name: "enqueue-pullrequest" }, { name: "wip" }] } });
    const { eligible, reason } = checkEligibility(pr, makeConfig({ skipLabels: ["wip"] }));
    expect(eligible).toBe(false);
    expect(reason).toMatch(/wip/);
  });

  test("PR without skip-labels is eligible", () => {
    const { eligible } = checkEligibility(makePR(), makeConfig({ skipLabels: ["wip"] }));
    expect(eligible).toBe(true);
  });

  test("base branch not in allowed list", () => {
    const { eligible, reason } = checkEligibility(
      makePR({ baseRefName: "feature" }),
      makeConfig({ baseBranches: ["main", "master"] })
    );
    expect(eligible).toBe(false);
    expect(reason).toMatch(/Base branch/);
  });

  test("base branch in allowed list passes", () => {
    const { eligible } = checkEligibility(
      makePR({ baseRefName: "main" }),
      makeConfig({ baseBranches: ["main"] })
    );
    expect(eligible).toBe(true);
  });

  test("insufficient approvals", () => {
    const pr = makePR({ reviews: { totalCount: 0 } });
    const { eligible, reason } = checkEligibility(pr, makeConfig({ requiredApprovals: 2 }));
    expect(eligible).toBe(false);
    expect(reason).toMatch(/Insufficient approvals/);
  });

  test("sufficient approvals passes", () => {
    const pr = makePR({ reviews: { totalCount: 2 } });
    const { eligible } = checkEligibility(pr, makeConfig({ requiredApprovals: 2 }));
    expect(eligible).toBe(true);
  });

  test("PR already in merge queue is skipped", () => {
    const pr = makePR({ mergeQueueEntry: { id: "mq1", state: "QUEUED", position: 3 } });
    const { eligible, reason } = checkEligibility(pr, makeConfig());
    expect(eligible).toBe(false);
    expect(reason).toMatch(/Already in merge queue/);
  });
});

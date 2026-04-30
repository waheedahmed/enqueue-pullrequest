"use strict";

const core = require("@actions/core");

// ─── Configuration ────────────────────────────────────────────────────────────

function getConfig() {
  return {
    token: core.getInput("github-token", { required: true }),
    label: core.getInput("label").trim(),
    branch: core.getInput("branch").trim(),
    skipLabels: core
      .getInput("skip-labels")
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean),
    baseBranches: core
      .getInput("base-branches")
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean),
    skipDrafts: core.getInput("skip-drafts") !== "false",
    requiredApprovals: parseInt(core.getInput("required-approvals"), 10) || 0,
    enqueueRetries: parseInt(core.getInput("enqueue-retries"), 10),
    enqueueRetrySleep: parseInt(core.getInput("enqueue-retry-sleep"), 10),
  };
}

// ─── GitHub GraphQL helpers ───────────────────────────────────────────────────

/** Returns the GraphQL node ID and current merge-queue state for a PR. */
async function getPRDetails(octokit, owner, repo, prNumber) {
  const { repository } = await octokit.graphql(
    `
    query PRDetails($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
          isDraft
          state
          title
          baseRefName
          labels(first: 20) {
            nodes { name }
          }
          reviews(states: [APPROVED], last: 10) {
            totalCount
          }
          mergeQueueEntry {
            id
            state
            position
          }
        }
      }
    }
    `,
    { owner, repo, number: prNumber }
  );
  return repository?.pullRequest ?? null;
}

/** Adds a PR (by GraphQL node ID) to the merge queue. */
async function enqueue(octokit, prNodeId) {
  const result = await octokit.graphql(
    `
    mutation Enqueue($prId: ID!) {
      enqueuePullRequest(input: { pullRequestId: $prId }) {
        mergeQueueEntry {
          id
          state
          position
        }
      }
    }
    `,
    { prId: prNodeId }
  );
  return result.enqueuePullRequest?.mergeQueueEntry ?? null;
}

/** Returns true if the merge queue is enabled for the given branch. */
async function isMergeQueueEnabled(octokit, owner, repo, branch) {
  const { repository } = await octokit.graphql(
    `
    query MergeQueueEnabled($owner: String!, $repo: String!, $branch: String!) {
      repository(owner: $owner, name: $repo) {
        mergeQueue(branch: $branch) {
          id
        }
      }
    }
    `,
    { owner, repo, branch }
  );
  return repository?.mergeQueue != null;
}

// ─── Eligibility checks ───────────────────────────────────────────────────────

/**
 * Returns `{ eligible: true }` or `{ eligible: false, reason: string }`.
 * Uses data already fetched via GraphQL to avoid extra round-trips.
 */
function checkEligibility(pr, config) {
  if (pr.state !== "OPEN") {
    return { eligible: false, reason: `PR is ${pr.state.toLowerCase()}` };
  }

  if (config.skipDrafts && pr.isDraft) {
    return { eligible: false, reason: "PR is a draft" };
  }

  const labels = pr.labels.nodes.map((l) => l.name);

  if (config.label && !labels.includes(config.label)) {
    return {
      eligible: false,
      reason: `Missing required label "${config.label}"`,
    };
  }

  for (const skip of config.skipLabels) {
    if (labels.includes(skip)) {
      return { eligible: false, reason: `Has blocking label "${skip}"` };
    }
  }

  if (
    config.baseBranches.length > 0 &&
    !config.baseBranches.includes(pr.baseRefName)
  ) {
    return {
      eligible: false,
      reason: `Base branch "${pr.baseRefName}" not in allowed list`,
    };
  }

  if (config.requiredApprovals > 0) {
    const approvals = pr.reviews?.totalCount ?? 0;
    if (approvals < config.requiredApprovals) {
      return {
        eligible: false,
        reason: `Insufficient approvals: ${approvals}/${config.requiredApprovals}`,
      };
    }
  }

  if (pr.mergeQueueEntry) {
    return {
      eligible: false,
      reason: `Already in merge queue (position ${pr.mergeQueueEntry.position}, state ${pr.mergeQueueEntry.state})`,
    };
  }

  return { eligible: true };
}

// ─── Per-PR processing ────────────────────────────────────────────────────────

async function processPR(octokit, owner, repo, prNumber, config) {
  core.info(`\n── PR #${prNumber} ──`);

  let pr;
  try {
    pr = await getPRDetails(octokit, owner, repo, prNumber);
  } catch (err) {
    core.warning(`Could not fetch details for PR #${prNumber}: ${err.message}`);
    return;
  }

  if (!pr) {
    core.warning(`PR #${prNumber} not found`);
    return;
  }

  core.info(`Title: ${pr.title}`);
  core.info(`Base:  ${pr.baseRefName}`);

  const { eligible, reason } = checkEligibility(pr, config);

  if (!eligible) {
    core.info(`Skipping: ${reason}`);
    return;
  }

  core.info("Eligible — checking merge queue is enabled…");

  const mqEnabled = await isMergeQueueEnabled(octokit, owner, repo, pr.baseRefName);
  if (!mqEnabled) {
    core.setFailed(
      `Merge queue is not enabled for branch "${pr.baseRefName}". Enable it under Settings → Branches → branch protection rules.`
    );
    return;
  }

  core.info("Adding to merge queue…");

  // Retry logic for enqueue
  const maxRetries = typeof config.enqueueRetries === 'number' && !isNaN(config.enqueueRetries) ? config.enqueueRetries : 6;
  const retrySleep = typeof config.enqueueRetrySleep === 'number' && !isNaN(config.enqueueRetrySleep) ? config.enqueueRetrySleep : 5000;

  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      const entry = await enqueue(octokit, pr.id);
      if (entry) {
        core.info(
          `Added to merge queue: position=${entry.position}, state=${entry.state}`
        );
      } else {
        core.info("Added to merge queue (no entry details returned)");
      }
      return;
    } catch (err) {
      if (maxRetries === 0 || attempt === maxRetries) {
        core.setFailed(`Failed to enqueue PR #${prNumber}: ${err.message}`);
        return;
      }
      core.warning(`Enqueue failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}`);
      if (retrySleep > 0) {
        core.info(`Sleeping for ${retrySleep}ms before retrying…`);
        await new Promise((resolve) => setTimeout(resolve, retrySleep));
      }
    }
    attempt++;
  }
}

// ─── Event routing ────────────────────────────────────────────────────────────

/**
 * Returns the list of PR numbers to inspect for the current event.
 * For events that carry a specific PR we use only that one; for broader events
 * (schedule, workflow_dispatch, push, etc.) we list open PRs, optionally
 * filtered to a specific head branch via the `branch` input.
 */
async function getPRNumbers(octokit, owner, repo, context, config) {
  const { eventName, payload } = context;

  // Events that identify a single PR directly
  const singlePREvents = new Set([
    "pull_request",
    "pull_request_target",
    "pull_request_review",
    "pull_request_review_comment",
  ]);

  if (singlePREvents.has(eventName)) {
    const number = payload.pull_request?.number;
    if (!number) {
      core.warning(`Event ${eventName} carried no pull_request number`);
      return [];
    }
    return [number];
  }

  // For check_run / check_suite the PR list is embedded in the payload
  if (eventName === "check_run") {
    return (payload.check_run?.pull_requests ?? []).map((pr) => pr.number);
  }

  if (eventName === "check_suite") {
    return (payload.check_suite?.pull_requests ?? []).map((pr) => pr.number);
  }

  // For all other events use the branch input to narrow the search when provided.
  const listParams = { owner, repo, state: "open", per_page: 100 };

  if (config.branch) {
    core.info(`Fetching open PRs with head branch "${config.branch}"`);
    listParams.head = `${owner}:${config.branch}`;
  } else {
    core.info(`Scanning all open pull requests in ${owner}/${repo}`);
  }

  const prs = await octokit.paginate(octokit.rest.pulls.list, listParams);
  return prs.map((pr) => pr.number);
}

module.exports = { getConfig, getPRNumbers, processPR };
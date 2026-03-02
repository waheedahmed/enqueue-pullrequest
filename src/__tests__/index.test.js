"use strict";

jest.mock("@actions/core");
jest.mock("@actions/github");

// Drain all pending promises (lets the async run() complete).
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

describe("enqueue-pullrequest action", () => {
  let core;
  let github;
  let mockOctokit;

  beforeEach(() => {
    // Fresh module registry so each test gets a clean run() invocation.
    jest.resetModules();
    core = require("@actions/core");
    github = require("@actions/github");

    jest.spyOn(core, "info").mockImplementation(() => {});
    jest.spyOn(core, "warning").mockImplementation(() => {});
    jest.spyOn(core, "error").mockImplementation(() => {});
    jest.spyOn(core, "debug").mockImplementation(() => {});
    jest.spyOn(core, "setFailed").mockImplementation(() => {});

    mockOctokit = {
      graphql: jest.fn(),
      paginate: jest.fn().mockResolvedValue([]),
      rest: { pulls: { list: jest.fn() } },
    };

    jest.spyOn(github, "getOctokit").mockReturnValue(mockOctokit);

    // Default: pull_request event for PR #42
    github.context = {
      eventName: "pull_request",
      payload: { pull_request: { number: 42 } },
      repo: { owner: "acme", repo: "my-repo" },
    };
  });

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function setupInputs(overrides = {}) {
    const defaults = {
      "github-token": "ghs_test",
      "label": "enqueue-pullrequest",
      "skip-labels": "",
      "base-branches": "",
      "skip-drafts": "true",
      "required-approvals": "0",
    };
    jest.spyOn(core, "getInput").mockImplementation(
      (name) => ({ ...defaults, ...overrides }[name] ?? "")
    );
  }

  function makePRPayload(overrides = {}) {
    return {
      id: "PR_abc123",
      state: "OPEN",
      isDraft: false,
      title: "My feature",
      baseRefName: "main",
      labels: { nodes: [{ name: "enqueue-pullrequest" }] },
      reviews: { totalCount: 0 },
      mergeQueueEntry: null,
      ...overrides,
    };
  }

  // Mocks for each GraphQL call in order.
  const mqEnabled  = { repository: { mergeQueue: { id: "MQ_1" } } };
  const mqDisabled = { repository: { mergeQueue: null } };

  function mockEnqueue(id = "MQE_1", position = 1) {
    return { enqueuePullRequest: { mergeQueueEntry: { id, state: "QUEUED", position } } };
  }

  // Loads the action module, which immediately calls run().
  async function runAction() {
    require("../index");
    await flushPromises();
  }

  // ─── processPR ──────────────────────────────────────────────────────────────

  describe("processPR", () => {
    test("enqueues an eligible PR", async () => {
      setupInputs();
      mockOctokit.graphql
        .mockResolvedValueOnce({ repository: { pullRequest: makePRPayload() } }) // getPRDetails
        .mockResolvedValueOnce(mqEnabled)                                         // isMergeQueueEnabled
        .mockResolvedValueOnce(mockEnqueue());                                    // enqueuePullRequest

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledTimes(3);
      expect(mockOctokit.graphql).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("MergeQueueEnabled"),
        expect.objectContaining({ branch: "main" })
      );
      expect(mockOctokit.graphql).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining("enqueuePullRequest"),
        { prId: "PR_abc123" }
      );
      expect(core.setFailed).not.toHaveBeenCalled();
    });

    test("fails the workflow when merge queue is not enabled for the base branch", async () => {
      setupInputs();
      mockOctokit.graphql
        .mockResolvedValueOnce({ repository: { pullRequest: makePRPayload() } })
        .mockResolvedValueOnce(mqDisabled);

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledTimes(2);
      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining("Merge queue is not enabled")
      );
    });

    test("skips a closed PR without calling enqueue", async () => {
      setupInputs();
      mockOctokit.graphql.mockResolvedValueOnce({
        repository: { pullRequest: makePRPayload({ state: "CLOSED" }) },
      });

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledTimes(1);
      expect(core.info).toHaveBeenCalledWith(expect.stringContaining("Skipping"));
    });

    test("skips a draft PR when skip-drafts=true", async () => {
      setupInputs({ "skip-drafts": "true" });
      mockOctokit.graphql.mockResolvedValueOnce({
        repository: { pullRequest: makePRPayload({ isDraft: true }) },
      });

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledTimes(1);
      expect(core.info).toHaveBeenCalledWith(expect.stringContaining("Skipping"));
    });

    test("enqueues a draft PR when skip-drafts=false", async () => {
      setupInputs({ "skip-drafts": "false" });
      mockOctokit.graphql
        .mockResolvedValueOnce({ repository: { pullRequest: makePRPayload({ isDraft: true }) } })
        .mockResolvedValueOnce(mqEnabled)
        .mockResolvedValueOnce(mockEnqueue());

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledTimes(3);
      expect(mockOctokit.graphql).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining("enqueuePullRequest"),
        expect.anything()
      );
    });

    test("skips a PR missing the required label", async () => {
      setupInputs({ label: "enqueue-pullrequest" });
      mockOctokit.graphql.mockResolvedValueOnce({
        repository: { pullRequest: makePRPayload({ labels: { nodes: [] } }) },
      });

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledTimes(1);
      expect(core.info).toHaveBeenCalledWith(expect.stringContaining("Skipping"));
    });

    test("enqueues PR with no label requirement when label input is empty", async () => {
      setupInputs({ label: "" });
      mockOctokit.graphql
        .mockResolvedValueOnce({ repository: { pullRequest: makePRPayload({ labels: { nodes: [] } }) } })
        .mockResolvedValueOnce(mqEnabled)
        .mockResolvedValueOnce(mockEnqueue("MQE_2"));

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledTimes(3);
      expect(mockOctokit.graphql).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining("enqueuePullRequest"),
        expect.anything()
      );
    });

    test("skips PR with a blocking skip-label", async () => {
      setupInputs({ "skip-labels": "wip,do-not-merge" });
      mockOctokit.graphql.mockResolvedValueOnce({
        repository: {
          pullRequest: makePRPayload({
            labels: { nodes: [{ name: "enqueue-pullrequest" }, { name: "wip" }] },
          }),
        },
      });

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledTimes(1);
    });

    test("skips a PR that is already in the merge queue", async () => {
      setupInputs();
      mockOctokit.graphql.mockResolvedValueOnce({
        repository: {
          pullRequest: makePRPayload({
            mergeQueueEntry: { id: "MQE_existing", state: "QUEUED", position: 2 },
          }),
        },
      });

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledTimes(1);
      expect(core.info).toHaveBeenCalledWith(expect.stringContaining("Skipping"));
    });

    test("skips PR with insufficient required approvals", async () => {
      setupInputs({ "required-approvals": "2" });
      mockOctokit.graphql.mockResolvedValueOnce({
        repository: { pullRequest: makePRPayload({ reviews: { totalCount: 1 } }) },
      });

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledTimes(1);
      expect(core.info).toHaveBeenCalledWith(expect.stringContaining("Skipping"));
    });

    test("enqueues PR that meets the required approvals threshold", async () => {
      setupInputs({ "required-approvals": "2" });
      mockOctokit.graphql
        .mockResolvedValueOnce({ repository: { pullRequest: makePRPayload({ reviews: { totalCount: 2 } }) } })
        .mockResolvedValueOnce(mqEnabled)
        .mockResolvedValueOnce(mockEnqueue());

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledTimes(3);
    });

    test("skips PR targeting a branch not in base-branches list", async () => {
      setupInputs({ "base-branches": "main,master" });
      mockOctokit.graphql.mockResolvedValueOnce({
        repository: { pullRequest: makePRPayload({ baseRefName: "develop" }) },
      });

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledTimes(1);
      expect(core.info).toHaveBeenCalledWith(expect.stringContaining("Skipping"));
    });
  });

  // ─── Error handling ──────────────────────────────────────────────────────────

  describe("error handling", () => {
    test("fails the workflow when enqueue throws", async () => {
      setupInputs();
      mockOctokit.graphql
        .mockResolvedValueOnce({ repository: { pullRequest: makePRPayload() } })
        .mockResolvedValueOnce(mqEnabled)
        .mockRejectedValueOnce(new Error("Branch protection not enabled"));

      await runAction();

      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining("Branch protection not enabled")
      );
    });

    test("logs warning when PR is not found (null response)", async () => {
      setupInputs();
      mockOctokit.graphql.mockResolvedValueOnce({
        repository: { pullRequest: null },
      });

      await runAction();

      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("not found"));
    });

    test("logs warning and continues when getPRDetails throws", async () => {
      setupInputs();
      mockOctokit.graphql.mockRejectedValueOnce(new Error("Network error"));

      await runAction();

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Could not fetch details")
      );
      expect(core.setFailed).not.toHaveBeenCalled();
    });
  });

  // ─── Event routing (getPRNumbers) ────────────────────────────────────────────

  describe("event routing", () => {
    test("pull_request event: fetches details for the PR in the payload", async () => {
      setupInputs();
      github.context = {
        eventName: "pull_request",
        payload: { pull_request: { number: 99 } },
        repo: { owner: "acme", repo: "my-repo" },
      };
      mockOctokit.graphql
        .mockResolvedValueOnce({ repository: { pullRequest: makePRPayload() } })
        .mockResolvedValueOnce(mqEnabled)
        .mockResolvedValueOnce(mockEnqueue());

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledWith(
        expect.stringContaining("PRDetails"),
        expect.objectContaining({ number: 99 })
      );
    });

    test("pull_request_review event: fetches details for the PR in the payload", async () => {
      setupInputs();
      github.context = {
        eventName: "pull_request_review",
        payload: { pull_request: { number: 7 } },
        repo: { owner: "acme", repo: "my-repo" },
      };
      mockOctokit.graphql
        .mockResolvedValueOnce({ repository: { pullRequest: makePRPayload() } })
        .mockResolvedValueOnce(mqEnabled)
        .mockResolvedValueOnce(mockEnqueue());

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledWith(
        expect.stringContaining("PRDetails"),
        expect.objectContaining({ number: 7 })
      );
    });

    test("check_run event: processes all PRs listed in the payload", async () => {
      setupInputs();
      github.context = {
        eventName: "check_run",
        payload: { check_run: { pull_requests: [{ number: 10 }, { number: 11 }] } },
        repo: { owner: "acme", repo: "my-repo" },
      };
      mockOctokit.graphql
        .mockResolvedValueOnce({ repository: { pullRequest: makePRPayload() } })
        .mockResolvedValueOnce(mqEnabled)
        .mockResolvedValueOnce(mockEnqueue("MQE_1"))
        .mockResolvedValueOnce({ repository: { pullRequest: makePRPayload() } })
        .mockResolvedValueOnce(mqEnabled)
        .mockResolvedValueOnce(mockEnqueue("MQE_2", 2));

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledWith(
        expect.stringContaining("PRDetails"),
        expect.objectContaining({ number: 10 })
      );
      expect(mockOctokit.graphql).toHaveBeenCalledWith(
        expect.stringContaining("PRDetails"),
        expect.objectContaining({ number: 11 })
      );
    });

    test("check_suite event: processes all PRs listed in the payload", async () => {
      setupInputs();
      github.context = {
        eventName: "check_suite",
        payload: { check_suite: { pull_requests: [{ number: 20 }] } },
        repo: { owner: "acme", repo: "my-repo" },
      };
      mockOctokit.graphql
        .mockResolvedValueOnce({ repository: { pullRequest: makePRPayload() } })
        .mockResolvedValueOnce(mqEnabled)
        .mockResolvedValueOnce(mockEnqueue());

      await runAction();

      expect(mockOctokit.graphql).toHaveBeenCalledWith(
        expect.stringContaining("PRDetails"),
        expect.objectContaining({ number: 20 })
      );
    });

    test("schedule event: uses paginate to scan all open PRs", async () => {
      setupInputs();
      github.context = {
        eventName: "schedule",
        payload: {},
        repo: { owner: "acme", repo: "my-repo" },
      };
      mockOctokit.paginate.mockResolvedValue([{ number: 5 }, { number: 6 }]);
      mockOctokit.graphql
        .mockResolvedValueOnce({ repository: { pullRequest: makePRPayload() } })
        .mockResolvedValueOnce(mqEnabled)
        .mockResolvedValueOnce(mockEnqueue("MQE_1"))
        .mockResolvedValueOnce({ repository: { pullRequest: makePRPayload() } })
        .mockResolvedValueOnce(mqEnabled)
        .mockResolvedValueOnce(mockEnqueue("MQE_2", 2));

      await runAction();

      expect(mockOctokit.paginate).toHaveBeenCalledWith(
        mockOctokit.rest.pulls.list,
        expect.objectContaining({ state: "open" })
      );
      expect(mockOctokit.graphql).toHaveBeenCalledTimes(6);
    });

    test("workflow_dispatch event with no open PRs logs and exits cleanly", async () => {
      setupInputs();
      github.context = {
        eventName: "workflow_dispatch",
        payload: {},
        repo: { owner: "acme", repo: "my-repo" },
      };
      mockOctokit.paginate.mockResolvedValue([]);

      await runAction();

      expect(mockOctokit.graphql).not.toHaveBeenCalled();
      expect(core.info).toHaveBeenCalledWith("No pull requests to process.");
      expect(core.setFailed).not.toHaveBeenCalled();
    });

    test("pull_request event with missing PR number logs warning", async () => {
      setupInputs();
      github.context = {
        eventName: "pull_request",
        payload: {},
        repo: { owner: "acme", repo: "my-repo" },
      };

      await runAction();

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("no pull_request number")
      );
      expect(mockOctokit.graphql).not.toHaveBeenCalled();
    });
  });
});
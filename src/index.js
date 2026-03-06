"use strict";

const core = require("@actions/core");
const github = require("@actions/github");
const { getConfig, getPRNumbers, processPR } = require("./api");

// ─── Entry point ─────────────────────────────────────────────────────────────

async function run() {
  const config = getConfig();
  const octokit = github.getOctokit(config.token);
  const context = github.context;
  const { owner, repo } = context.repo;

  core.info(`enqueue-pullrequest running on event: ${context.eventName}`);
  core.debug(`Config: ${JSON.stringify({ ...config, token: "***" })}`);

  const prNumbers = await getPRNumbers(octokit, owner, repo, context, config);

  if (prNumbers.length === 0) {
    core.info("No pull requests to process.");
    return;
  }

  core.info(`Processing ${prNumbers.length} PR(s): ${prNumbers.join(", ")}`);

  for (const number of prNumbers) {
    await processPR(octokit, owner, repo, number, config);
  }

  core.info("\nDone.");
}

run().catch((err) => {
  core.setFailed(err.message);
});

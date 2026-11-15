# Workflow definitions

Labeling guide for the `Workflow` label group. Use it to label issues by hand, and as the spec for the classifier prompt.

Status: draft for HOK-3485. Examples were picked from issue titles, except where a description is cited.

## How to label

Read the title and the full description. Then ask these questions in order. Stop at the first yes.

1. Does the work live in child issues? → `workflow:decompose`
2. Is the deliverable an action run against a live system? → `workflow:operate`
3. Is a decision open, the goal unclear, the result a matter of taste, or the task something only a person can do? → `workflow:interactive`
4. Is the output a report, measurement, audit, spike result or design memo, with no change to production behavior? → `workflow:investigate`
5. Does it pass every test in "Low-risk enough for direct"? → `workflow:direct`
6. Otherwise → `workflow:standard`

The order is the tie-break. An issue that fits two workflows takes the earlier one.

One issue, one label. If an issue needs two workflows, it is two issues. Split it, or label it decompose.

## The six workflows

### `workflow:direct`

A change with a known pattern and a small blast radius. One model can do it from the issue text without a plan, and a wrong result is cheap to catch in review and to revert.

Examples:
- HOK-3387: Add a crawlable link to `/rework-risk/dependencies` from the Rework Risk page and footer.
- HOK-3188: Suppress warnings for skipping epics.
- HOK-3050: Add a second recipient to the contact form.
- HOK-3144: Retire gemini-2.5-pro and hand its routing to gemini-3.1-pro-preview.
- HOK-1600: Docs: correct the CRR range from 5%–50% to 5%–100%.

Near-misses:
- HOK-3300: Add an absolute floor to the AMM per-trade size limit. Small, but a smart-contract change. → standard
- HOK-3466: Discover tests by glob; delete the hand-kept runner lists. Mechanical, but it changes which tests CI runs. → standard
- HOK-3396: Mainnet: admin Safe `resetModelHead(30)`. One transaction, but it runs against mainnet. → operate

### `workflow:standard`

Technical work that needs a plan before code: several files or components, a design choice, or a risky surface. It runs plan, code, review, and it is the default when nothing else fits.

Examples:
- HOK-3454: One task-record write gate: fix the lifecycle writers, refuse violations, delete the shadow flag.
- HOK-3413: Contribution 2/5: canonical ingestion reprices v4 rows, assigns cost trust, stores canonical rows.
- HOK-3320: Build dependency release outcome pages under `/rework-risk/dependencies`.
- HOK-3281: Implement the upgradeable AMM pool with permanent graduation and storage-layout CI.
- HOK-3212: Merge label reconciler never matches a task, so no PR gets `wm:ready`.

Near-misses:
- HOK-3291: Execute the mainnet redeploy, retire the legacy deployment, cut over consumers. The work is the execution. → operate
- HOK-3152: Design: a durable task ledger for the mill. The output is a design document. → investigate
- HOK-3173: [Epic] Unattended mill. The work lives in its children. → decompose

### `workflow:investigate`

The output is knowledge: a report, a measurement, an audit, a spike result or a design memo. The PR adds documents, data or throwaway code and changes no production behavior.

Examples:
- HOK-3478: Stall Risk: audit OpenTraces label fit as a supplemental corpus.
- HOK-3337: MQ-1.1: Inventory every writer of task lifecycle, queue, CI and cost telemetry.
- HOK-3336: MQ-0.1: Baseline cost-per-task decomposition and queue depth.
- HOK-3150: Spike: run a native coding arm on Pi 1.0 + pi-durable and test crash resume.
- HOK-3289: Security review of the fresh upgradeable-AMM release.

Near-misses:
- HOK-2205: Investigate: replace prose regex closure with structured evidence requirements. This is a feature for MTTR's Investigate stage. → standard
- HOK-3153: Pi Durable: go/no-go decision and file the follow-on issues. A person makes the decision. → interactive
- HOK-3268: Full corpus run to S3 plus a per-repo sanity report. There is a report, but the deliverable is the run. → operate

### `workflow:interactive`

The issue cannot be executed as written. A decision is open, the goal is unclear, the result depends on taste, or a person has to do it. The session often ends by rewriting the issue into runnable ones.

Examples:
- HOK-3405: Decide whether to cap local test concurrency across mill agents.
- HOK-3195: Diligence: channel test go/no-go decision.
- HOK-3192: Diligence: legal check on using and retaining git history under an engagement letter.
- HOK-3193: Diligence: channel outreach to 5 tech-DD providers and 5 search-fund buyers.
- HOK-3028: Train Rework Risk on outcome labels and run the full comparison.

Near-misses:
- HOK-3319: Realign the homepage wording with the positioning docs. It is copy, but the source of truth exists. → direct
- HOK-2722: Error when trying to generate recommendations. A bare bug report; the planner diagnoses it. → standard
- HOK-3026: Design the Jev question set for merge-time snap judgment. The output is a document a person reviews afterward. → investigate

### `workflow:operate`

The deliverable is an action run against a live system: mainnet, production infrastructure, production data or a model registry. A PR may be part of it, but the risk is in the execution, so it needs a runbook, a rehearsal where one is possible, and a human gate.

Examples:
- HOK-3396: Mainnet: admin Safe `resetModelHead(30)` to Technical Task Router v8.
- HOK-3291: Execute the mainnet redeploy, retire the legacy deployment, cut over consumers.
- HOK-3287: Drain the legacy HROUT pool and retire the July 2026 mainnet deployment.
- HOK-3410: Model 30 v10: rebuild with the cheap-model batch, gate against v9, release with one Safe reset.
- HOK-2531: Certify zero-evidence Kimi launch-priority models.

Near-misses:
- HOK-3281: Implement the upgradeable AMM pool. Contract code, with no execution in the issue. → standard
- HOK-2169: Gate 8: deployment-state verification script. It builds the script; running it against mainnet is a separate issue. → standard
- HOK-3024: Run trivial and classical JIT defect-prediction baselines. It runs on offline data and touches nothing live. → investigate

### `workflow:decompose`

The issue is a container: an epic, programme or umbrella whose work lives in child issues. The output is a set of child issues, each with a workflow label and its dependencies.

Examples:
- HOK-3173: [Epic] Unattended mill: stop patching stall shapes, make the mill converge on its own.
- HOK-3411: [Epic] One contribution path for Model 30.
- HOK-3302: [Epic] Smart task picker.
- HOK-2857: Support provisional stealth models through verified promotion. No "Epic" in the title, but it is a parent.
- HOK-2329: Improve MTTR agent root-cause direction and incident actionability.

Near-misses:
- HOK-3061: Native runtime — Epic 10.9: Bounded eval/scoring tools in native review. "Epic 10.9" is a number. The issue is a leaf. → standard
- HOK-1124: Automate the feedback loop. Too vague to split; it needs a scoping session first. → interactive
- HOK-2118: Contract-deployer: burn down about 1,700 eslint warnings. Large, but mechanical and needs no children. → direct

## Low-risk enough for direct

An issue is direct only if every test passes. If the mill cannot compute a test, the test fails.

1. **Repo.** The repo is not on the never-direct list: Hokusai smart contracts, and the auth, billing, settlement and mint paths.
2. **Predicted touch set.** At most 5 files. None in mill-core paths (monitor, tend, reconciler, ledger, failure policy). No schema, contract, migration or CI workflow files.
3. **Blast radius.** The lowest tier of the blast-radius scale from HOK-3238.
4. **Concrete change.** The issue names what changes: a file, flag, string, version or config value. No question is left open.
5. **Existing check.** An existing test, build step or visible result shows whether it worked.
6. **Confidence.** The classifier's confidence is above its threshold.

Size is not a test. A 7,000-line dead-code deletion can be direct. A one-line contract change cannot.

If a direct task's diff leaves the predicted touch set, the task falls back to standard.

## Fixed rules

- Smart-contract changes are never direct.
- Anything run against mainnet, production data or a model registry is operate.
- A bare bug report is standard. The planner does the diagnosis. This holds for auto-filed errors such as "TypeError: Failed to fetch".
- "Diagnose and fix" is standard. Diagnosis alone, ending in a report, is investigate.
- An infrastructure-as-code change that ships through the normal deploy is standard at a high risk tier. It is operate when a person must run a step by hand.
- Model work splits three ways. Offline experiment with a report: investigate. Retrain and promote a model that already exists: operate. First training of a new model, iterating on data: interactive.

## Vague titles

Read the description. Label from what it says, not from the title.

A vague title does not make an issue interactive. HOK-2239 is titled "Homepage copy changes". Its description gives the new hero, section heading and four cards word for word. Nothing is left to decide. → direct

If the goal is still unclear after reading the description, label it interactive. Titles that cannot be labeled alone: "Bug: error in logs", "Improve rewards display", "Log hygiene".

## Known traps

- **"Investigate:" in MTTR.** It names the Investigate stage of the MTTR agent. These are features. → standard (HOK-2201 to HOK-2205)
- **"Epic N.M" in a title.** Numbered leaves under the Native runtime epics. → usually standard (HOK-3053 to HOK-3061)
- **"Phase N —" in a title.** Often a leaf in a sequence, not a parent. Check for children. (HOK-2225 to HOK-2229)
- **"Verify ..." and "Verification companion".** They check a rollout and write no production code. → investigate (HOK-2413 to HOK-2425)
- **"Certify ...".** A live certification run that changes what the router may select. → operate
- **"Docs:" against "Design:" or "Spec:".** Docs that record what exists are direct. A design or spec is investigate.
- **"Review ..." a paper, tweet or PR.** A person does the reading. → interactive (HOK-2851)
- **"Enable" or "Re-enable" a flag.** A config default is direct. Arming something in production is operate (HOK-2404).
- **"Decide ..." inside a build issue.** If the decision gates the work, the issue is interactive until the decision is written down (HOK-3276).

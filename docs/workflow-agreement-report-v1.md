# Workflow labels: agreement report v1

For HOK-3487. Compares the first-pass labels (titles and project only, 2026-11-14) with Tim's gold labels (full descriptions, 2026-11-15).

## Sample

- 150 issues, 25 from each first-pass class. 68 from the last three months, 25 with vague titles.
- Gold labels: the Gold set tab of the HOK-3486 sheet. The gold set is held out. It is never used to tune a prompt.
- Each class is 17% of the sample but between 3% and 67% of the corpus, so overall numbers are reweighted to the corpus mix.

## Results

| | |
|---|---|
| Raw agreement | 122 / 150 (81%) |
| Cohen's kappa | 0.78 |
| Agreement reweighted to the corpus mix | 94% |
| Vague titles that agreed | 21 / 25 |

Per class, scored against the gold label:

| Workflow | Precision | Recall | Gold count |
|---|---|---|---|
| direct | 0.88 | 0.88 | 25 |
| standard | 1.00 | 0.69 | 36 |
| investigate | 0.76 | 0.79 | 24 |
| interactive | 0.68 | 0.85 | 20 |
| operate | 0.76 | 0.79 | 24 |
| decompose | 0.80 | 0.95 | 21 |

Confusion matrix. Rows are first-pass labels; columns are gold labels.

| | direct | standard | investigate | interactive | operate | decompose |
|---|---|---|---|---|---|---|
| direct | 22 | 3 | 0 | 0 | 0 | 0 |
| standard | 0 | 25 | 0 | 0 | 0 | 0 |
| investigate | 0 | 2 | 19 | 2 | 1 | 1 |
| interactive | 2 | 1 | 1 | 17 | 4 | 0 |
| operate | 1 | 3 | 2 | 0 | 19 | 0 |
| decompose | 0 | 2 | 2 | 1 | 0 | 20 |

With 25 issues per class, each precision or recall figure is uncertain by about ±0.15.

## Against the proposed bar

| Measure | Proposed | Result | |
|---|---|---|---|
| Precision on direct | ≥ 0.85 | 0.88 | pass |
| Recall on operate | ≥ 0.90 | 0.79 | fail |
| Recall on decompose | ≥ 0.90 | 0.95 | pass |

## The disagreements

| Pattern | Issues | Cause | Fix in definitions v2 |
|---|---|---|---|
| Human errands | HOK-3025, HOK-659, HOK-3194, HOK-3200 | First pass called them interactive. Tim calls a step a person does by hand operate. | Hand steps are operate. New section: operate against interactive. |
| Runs that report back | HOK-2713, HOK-2217 | First pass called them operate. They run on offline data and need no operator. | Runs that report back are investigate. |
| Model work done as code | HOK-2866, HOK-3401, HOK-2864, HOK-2865 | First pass called them operate. The work was code. | No rule change. The second pass reads the description. |
| "Epic" in the title, no children | HOK-2810, HOK-3113, HOK-636, HOK-1143 | First pass called them decompose. | Check for children; the title alone does not decide it. |
| Smart-contracts project labeled direct | HOK-2459 | First pass broke its own rule. | The rule now names config and wiring in the contracts project. |
| Other direct to standard | HOK-3157, HOK-2553 | Fixes to subtle failures that needed a plan. | No rule change. |
| Design and copy | HOK-1824, HOK-1071 to direct; HOK-966 to interactive | Vague titles. The descriptions settled them. | Already covered by the vague-title rule. |
| Diagnosis that ends in a fix | HOK-1566, HOK-593, HOK-1844 | First pass called them investigate or interactive. The work was a fix. | "Diagnose and fix" is standard (already a rule). |
| Placeholders and parents | HOK-650 to decompose; HOK-2836 to interactive | A design issue that became a parent; a placeholder epic waiting on a decision. | None. Watch in the second pass. |
| Investigation needing a person | HOK-1941 to operate; HOK-2068 to interactive; HOK-2142 to investigate | Close calls. | None. Watch in the second pass. |

## Decisions

1. **Agreement bar for Phase 0 exit.** The second-pass labels must reach, against the gold set:
   - precision on direct ≥ 0.85
   - recall on operate ≥ 0.90
   - recall on decompose ≥ 0.90
   - recall on interactive ≥ 0.85
   - kappa ≥ 0.80
2. **What WF-0.5 relabels.** Every issue whose first-pass label is not standard: 923 issues. First-pass standard had precision 1.00, so its 1,900 issues keep their label. A random 50 of them get read from description as a spot check. If more than 3 of the 50 change, all 1,900 get relabeled.
3. **Operate and interactive stay separate for now.** Merged, raw agreement would rise from 122 to 126. Revisit with the classifier shadow data (HOK-3480).

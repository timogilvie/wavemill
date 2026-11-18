# HOK-3325 / HOK-3447: Ready stall after a repair launch

Sanitised evidence for the Ready-remediation stall class this change fixes.
No local paths, real task ids or secrets are preserved.

## Shape

A native `coding` stage ran and recorded its launch. CI then failed, and the
mill launched two Ready remediation attempts. Because the native launcher
minted a deterministic runtime session id (`<session>-coding-<issue>`), every
repair reused the *same* `sessionRef` as the coding launch:

```
{"type":"launch","sessionRef":"wavemill-coding-HOK-0000", ... stage:"coding"}
{"type":"launch","sessionRef":"wavemill-coding-HOK-0000", ... kind:"ready-remediation"}
{"type":"launch","sessionRef":"wavemill-coding-HOK-0000", ... kind:"ready-remediation"}
```

`readOwnershipFiles` used to collapse rows by `sessionRef` (keeping the
earliest). Disposition and progress then read the *coding* row as the
newest — `readStageAgentLaunch("ready-remediation")` returned null — so the
finished repair was never seen: no publication, no Ready re-check, and the
arm sat until an operator touched it.

## Oracle

`ownership.jsonl` is read by
`shared/lib/session-ownership.test.ts` (`HOK-3325 replay`). The canonical
selector must return the **second** repair (the newest attempt) and the
metering projection must still bill the shared ref once.

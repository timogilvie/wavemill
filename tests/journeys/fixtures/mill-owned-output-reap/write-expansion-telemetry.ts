import { annotateTaskSize } from '../../../../shared/lib/issue-expander.ts';
const [repoDir, issueId] = process.argv.slice(2);
if (!repoDir || !issueId) throw new Error('expected repoDir and issueId');
await annotateTaskSize('## Technical Context\n\nA small journey packet.', {
  repoDir,
  issueId,
  probe: null,
  limits: {
    enabled: true, maxAddedLines: 800, maxFiles: 12, coreFiles: [],
    anchorCoreFile: 'shared/lib/wavemill-monitor.sh', maxCoreCompanions: 2,
  },
});

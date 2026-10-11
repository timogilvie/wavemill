import { Ledger } from '../../shared/lib/ledger.ts';
const [dbPath, mode, parentId, key] = process.argv.slice(2);
const ledger = Ledger.open({ dbPath });
try {
  if (mode === 'crash') {
    ledger.transaction(tx => { tx.insertTask({ parentId, kind: 'step', slug: 'crashed', inputsHash: key }); process.kill(process.pid, 'SIGKILL'); });
  } else if (mode === 'insert') {
    const row = ledger.transaction(tx => tx.insertTask({ parentId, kind: 'step', slug: 'duplicate', inputsHash: key }));
    console.log(JSON.stringify({ ok: true, id: row.id }));
  } else if (mode === 'effect') {
    const result = ledger.transaction(tx => {
      const recorded = tx.recordSideEffect({ stepId: parentId, kind: 'git-push', idempotencyKey: key });
      if (recorded.isNew) tx.applySideEffect(recorded.row.id, { ok: true });
      return recorded.isNew;
    });
    console.log(JSON.stringify({ ok: true, isNew: result }));
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: (error as { code?: string }).code ?? 'error' }));
} finally { ledger.close(); }

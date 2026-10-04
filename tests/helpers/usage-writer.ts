// Child process for the usage ledger tests: writes to one ledger file, then flushes anything the lock made it hold back.
import { openUsageLedger } from "../../src/usage.js";

const [path, iterations, startAt, usd] = process.argv.slice(2) as [string, string, string, string];
const ledger = openUsageLedger({ path });
// Start together, so the writers overlap.
while (Date.now() < Number(startAt)) { /* wait for the start time */ }
for (let index = 0; index < Number(iterations); index++) {
  ledger.recordStart();
  ledger.recordSuccess(10, 3, Number(usd));
}
ledger.flush?.();

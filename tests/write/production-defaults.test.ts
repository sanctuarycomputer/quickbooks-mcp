// Sanctuary Computer (quickbooks-mcp-294): spec A3.5 and Q10. The write server started as production starts it: writeMode() and
// startWriteServer with no deps at all (Date.now, performance.now, child_process.spawn, 293's buildBody, node:fs), the Stacks fake
// answering a token whose expiry is built from Date.now() (whole seconds, as Stacks gives it), a stamp written with
// new Date().toISOString(), the real switch file, and the fake receipt command run by the real spawn: qbo_categorize_purchase.json gives
// sent.json. A wrong kind of clock answers write:sweep (the wall) or fork-error (the registry's). And src/index.ts loads write mode with
// no argument.
import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { stacksFake } from '../fakes/stacks-token.js';
import { fakePath, REALMS, ROOT, fixtureToken } from '../helpers/server.js';
import { fixture } from './derive.js';
import { stubOf, world, writeRig } from './write-rig.js';

jest.setTimeout(30000);
const rig = writeRig();

describe('A3.5: the production defaults', () => {
  it('no deps anywhere: qbo_categorize_purchase.json is sent.json', async () => {
    rig.stacks = stacksFake({
      sequence: [
        {
          status: 200,
          body: { enterprise: 'garden3d', realm_id: REALMS.garden3d, access_token: fixtureToken('garden3d'), expires_at: new Date(Date.now() + 3_600_000).toISOString().replace(/\.[0-9]{3}Z$/, 'Z'), company_name: 'garden3d, LLC' },
        },
      ],
    });
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-sent.json'] });
    writeFileSync(w.stampPath, JSON.stringify({ v: 1, at: new Date().toISOString(), clean: true, jobs: 7 }));
    w.post = () => stubOf(fixture('answers/update-sent.json'));
    const { client } = await rig.start({ env: w.env, production: true });
    const call = JSON.parse(readFileSync(fakePath('tool-calls/qbo_categorize_purchase.json'), 'utf8'));
    const got = await client.callTool({ name: 'qbo_categorize_purchase', arguments: call });
    expect(got).toEqual(JSON.parse(readFileSync(fakePath('tool-results/qbo_categorize_purchase/sent.json'), 'utf8')));
    expect(w.fake.requests().map((r: any) => r.cmd)).toEqual(['intent', 'outcome']);
    expect(rig.posts()).toHaveLength(1);
  });

  it('Q10: src/index.ts loads write mode as exactly (await import("./write/mode.js")).writeMode(), with no argument', () => {
    const index = readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf8');
    const loads = index.match(/\(await import\("\.\/write\/mode\.js"\)\)\.writeMode\([^)]*\)/g);
    expect(loads).toEqual(['(await import("./write/mode.js")).writeMode()']);
  });
});

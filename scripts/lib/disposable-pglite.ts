import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { freePort } from './disposable-postgres.ts';
/** Always creates an empty in-memory database; never accepts an external connection. */
export async function disposablePglite() {
  const database = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
  const port = await freePort();
  const server = new PGLiteSocketServer({ db: database, port, host: '127.0.0.1', maxConnections: 1 });
  await server.start();
  return { database, url: `postgres://postgres@127.0.0.1:${port}/postgres`, async stop() { await server.stop(); await database.close(); } };
}

"use strict";

// Durable leases let both Node and Workers recover jobs after a process restart.
// External effects must also use stable provider idempotency keys.
function createJobs(query) {
  return {
    async enqueue(kind, key, payload, client) {
      return (client ? client.query.bind(client) : query)(
        `INSERT INTO background_jobs(kind,dedupe_key,payload) VALUES($1,$2,$3)
         ON CONFLICT(dedupe_key) DO NOTHING`,
        [kind, key, payload],
      );
    },
    async run(kinds, handle, limit = 10) {
      for (let i = 0; i < limit; i++) {
        const {
          rows: [job],
        } = await query(
          `
          UPDATE background_jobs SET locked_until=NOW()+INTERVAL '2 minutes', attempts=attempts+1
          WHERE id=(SELECT id FROM background_jobs WHERE kind=ANY($1::text[]) AND completed_at IS NULL
            AND attempts<12 AND available_at<=NOW() AND (locked_until IS NULL OR locked_until<NOW())
            ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
          [kinds],
        );
        if (!job) break;
        try {
          await handle(job);
          await query(
            "UPDATE background_jobs SET completed_at=NOW(),locked_until=NULL,last_error=NULL WHERE id=$1",
            [job.id],
          );
        } catch (error) {
          // Store a provider code only; messages may contain URLs or credentials.
          await query(
            `UPDATE background_jobs SET locked_until=NULL,last_error=$2,
            available_at=NOW()+($3*INTERVAL '1 second') WHERE id=$1`,
            [
              job.id,
              String(error.code || error.name || "job_failed").slice(0, 100),
              Math.min(3600, 2 ** job.attempts * 10),
            ],
          );
        }
      }
    },
  };
}
module.exports = { createJobs };

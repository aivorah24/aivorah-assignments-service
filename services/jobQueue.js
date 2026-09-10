// ── Swappable job queue ─────────────────────────────────────────────────────
// ONE interface, TWO backends — chosen by the QUEUE_DRIVER env var:
//
//   • 'db' (default)  → enqueue into the Supabase `upload_jobs` table; drained by
//                       POST /jobs/process (hit by a Cloud Scheduler cron) or a
//                       worker loop. Zero extra infra — right for the beta.
//   • 'kafka'         → enqueue + publish the job id to a Kafka topic; an always-on
//                       consumer (worker.js, Cloud Run --min-instances=1) drains it.
//                       Right for scale. Needs `npm i kafkajs` + cluster creds.
//
// In BOTH modes `upload_jobs` is the source of truth for status, so the client can
// poll GET /jobs/:id no matter which transport is active. Switching db ↔ kafka is a
// config change (env vars), not a rewrite.

const crypto   = require('crypto');
const supabase = require('./supabase');

const DRIVER = (process.env.QUEUE_DRIVER || 'db').toLowerCase();
const TOPIC  = process.env.KAFKA_TOPIC || 'uploads';

const handlers = new Map(); // type → async (payload, job) => result

/** Register a processor for a job type. Call at startup (see services/jobHandlers.js). */
function registerHandler(type, fn) { handlers.set(type, fn); }

// ── Kafka (lazy — only loaded when QUEUE_DRIVER=kafka, so the beta needs no dep) ──
let _kafka = null, _producer = null;
function getKafka() {
  if (_kafka) return _kafka;
  const { Kafka } = require('kafkajs'); // lazy require
  _kafka = new Kafka({
    clientId: 'aivorah',
    brokers: (process.env.KAFKA_BROKERS || '').split(',').map(s => s.trim()).filter(Boolean),
    ssl: process.env.KAFKA_SSL !== 'false',
    sasl: process.env.KAFKA_USERNAME ? {
      mechanism: process.env.KAFKA_SASL_MECHANISM || 'plain',
      username: process.env.KAFKA_USERNAME,
      password: process.env.KAFKA_PASSWORD,
    } : undefined,
  });
  return _kafka;
}
let _producerPromise = null;
async function getProducer() {
  if (_producer) return _producer;
  // Cache the in-flight CONNECTION, not just the producer object — publishJob()
  // is called concurrently (e.g. several teachers uploading at once), and the
  // old version assigned `_producer` synchronously before `connect()` resolved,
  // so a second concurrent call saw a truthy `_producer` and tried to send on it
  // before the connection was actually established ("producer is disconnected").
  if (!_producerPromise) {
    _producerPromise = (async () => {
      const producer = getKafka().producer();
      await producer.connect();
      _producer = producer;
      return producer;
    })();
  }
  return _producerPromise;
}

/**
 * Enqueue a job. Returns { jobId }. The heavy file should already be in storage
 * (Cloudinary/GCS) — pass its URL in `payload`, never the raw bytes.
 */
async function publishJob(type, payload = {}) {
  const id = crypto.randomUUID();
  const { error } = await supabase.from('upload_jobs').insert({ id, type, payload, status: 'pending' });
  if (error) throw new Error(`[jobQueue] enqueue failed (${error.message}). Did you run server/sql/upload_jobs.sql?`);
  if (DRIVER === 'kafka') {
    const producer = await getProducer();
    await producer.send({ topic: TOPIC, messages: [{ key: id, value: JSON.stringify({ jobId: id, type }) }] });
  }
  return { jobId: id };
}

/**
 * Process a single job by id. Used by both drivers. Claims the row atomically
 * (conditional update on status='pending') so concurrent workers/instances never
 * double-process — i.e. idempotent even under Kafka's at-least-once delivery.
 */
async function processJobById(id) {
  const now = new Date().toISOString();
  const { data: claimed } = await supabase
    .from('upload_jobs')
    .update({ status: 'processing', locked_at: now, updated_at: now })
    .eq('id', id).eq('status', 'pending')
    .select();
  if (!claimed || claimed.length === 0) return false; // already taken / not pending

  const job = claimed[0];
  try {
    const handler = handlers.get(job.type);
    if (!handler) throw new Error(`no handler registered for job type "${job.type}"`);
    const result = await handler(job.payload, job);
    await supabase.from('upload_jobs')
      .update({ status: 'done', result: result ?? null, updated_at: new Date().toISOString() })
      .eq('id', id);
    return true;
  } catch (err) {
    await supabase.from('upload_jobs')
      .update({ status: 'failed', error: String(err?.message || err), updated_at: new Date().toISOString() })
      .eq('id', id);
    console.error(`[jobQueue] job ${id} (${job.type}) failed:`, err?.message || err);
    return false;
  }
}

/**
 * Drain up to `limit` pending jobs (db driver). Called by POST /jobs/process
 * (Cloud Scheduler) or a local loop. Returns { claimed, processed }.
 */
async function runWorkerOnce(limit = 5) {
  // aivorah-assignments-service specific: this microservice and the
  // monolith (ai-mentor/server) share the SAME upload_jobs table (same
  // Supabase project) and BOTH run a local drain loop against it. Without
  // filtering to only the job types THIS instance has a handler for, the
  // two drain loops race to claim any pending row regardless of type - if
  // the wrong instance wins, processJobById finds no handler and marks the
  // job permanently failed (wasting the one processing attempt) instead of
  // letting the instance that actually knows how to do it get a chance.
  // Scoping the poll itself to known types avoids the race entirely, without
  // touching the monolith's own copy of this file at all.
  const knownTypes = [...handlers.keys()];
  let query = supabase
    .from('upload_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (knownTypes.length > 0) query = query.in('type', knownTypes);
  const { data: pending, error } = await query;
  if (error) throw new Error(`[jobQueue] drain failed (${error.message})`);
  let processed = 0;
  for (const row of (pending || [])) {
    if (await processJobById(row.id)) processed++;
  }
  return { claimed: (pending || []).length, processed };
}

/** Always-on Kafka consumer loop (scale mode). No-op in db mode. */
async function startConsumer() {
  if (DRIVER !== 'kafka') {
    console.log('[jobQueue] QUEUE_DRIVER=db → no Kafka consumer; drain via POST /jobs/process.');
    return;
  }
  const consumer = getKafka().consumer({ groupId: process.env.KAFKA_GROUP_ID || 'aivorah-workers' });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
  console.log(`[jobQueue] Kafka consumer running on topic "${TOPIC}"`);
  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const { jobId } = JSON.parse(message.value.toString());
        if (jobId) await processJobById(jobId);
      } catch (err) {
        console.error('[jobQueue] bad message:', err?.message || err);
      }
    },
  });
}

async function getJob(id) {
  const { data } = await supabase.from('upload_jobs').select('*').eq('id', id).maybeSingle();
  return data || null;
}

module.exports = { DRIVER, publishJob, registerHandler, runWorkerOnce, processJobById, startConsumer, getJob };

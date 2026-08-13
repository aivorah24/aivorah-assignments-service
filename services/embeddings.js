let embedder = null;

async function getEmbedder() {
  if (!embedder) {
    console.log('Loading embedding model (first time only)...');
    // Lazy-require so the module doesn't crash on cold start in serverless envs
    const { pipeline } = require('@xenova/transformers');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('Embedding model ready.');
  }
  return embedder;
}

async function embed(text) {
  const pipe = await getEmbedder();
  const output = await pipe(text.trim(), { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

module.exports = { embed };

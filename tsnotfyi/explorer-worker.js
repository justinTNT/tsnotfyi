/**
 * Explorer Worker — dedicated thread for explorer computation.
 *
 * Owns its own KD-tree + RadialSearch copy (~200-250MB). Receives exploration
 * requests from the main thread, runs the full computation pipeline, and posts
 * results back. The main event loop is never blocked by explorer work.
 *
 * Startup sequence:
 *   1. Main thread posts { type: 'init' } after its own KD-tree is ready
 *   2. Worker loads its own KD-tree from PostgreSQL
 *   3. Worker posts { type: 'ready' }
 *   4. Explorer requests can now be served
 */

const { parentPort } = require('worker_threads');
const RadialSearchService = require('./radial-search');
const { runExplorerComputation } = require('./services/explorer-service');

let radialSearch = null;
let ready = false;

parentPort.on('message', async (msg) => {
  switch (msg.type) {
    case 'init':
      await initialize();
      break;

    case 'explore':
      await handleExploreRequest(msg);
      break;

    default:
      console.warn(`[explorer-worker] Unknown message type: ${msg.type}`);
  }
});

async function initialize() {
  try {
    console.log('[explorer-worker] Initializing RadialSearch with own KD-tree...');
    const startTime = Date.now();
    radialSearch = new RadialSearchService();
    await radialSearch.initialize();
    ready = true;
    const elapsed = Date.now() - startTime;
    console.log(`[explorer-worker] Ready (KD-tree loaded in ${elapsed}ms)`);
    parentPort.postMessage({ type: 'ready', loadTimeMs: elapsed });
  } catch (error) {
    console.error('[explorer-worker] Failed to initialize:', error);
    parentPort.postMessage({ type: 'error', error: error.message });
  }
}

async function handleExploreRequest(msg) {
  const { requestId, trackId, sessionContext, config } = msg;

  if (!ready) {
    parentPort.postMessage({
      type: 'explore_result',
      requestId,
      error: 'worker_not_ready'
    });
    return;
  }

  try {
    const result = await runExplorerComputation(radialSearch, trackId, sessionContext, config);

    parentPort.postMessage({
      type: 'explore_result',
      requestId,
      explorerData: result.explorerData,
      radiusUsed: result.radiusUsed,
      neighborhoodSize: result.neighborhoodSize,
      dynamicRadiusState: result.dynamicRadiusState,
      computeTimeMs: result.computeTimeMs,
      error: result.error || null
    });
  } catch (error) {
    console.error(`[explorer-worker] Exploration failed for ${trackId}:`, error);
    parentPort.postMessage({
      type: 'explore_result',
      requestId,
      error: error.message
    });
  }
}

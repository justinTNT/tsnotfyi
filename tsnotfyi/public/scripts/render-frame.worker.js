importScripts('./deck-frame-builder.js');

const workerBuilder = self.DeckFrameBuilder || null;

function serializeWorkerError(error) {
    if (!error) {
        return { message: 'Unknown worker error' };
    }
    return {
        message: error.message || String(error),
        name: error.name || 'Error',
        stack: error.stack || null
    };
}

self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type !== 'build-frame' || typeof data.id === 'undefined') {
        return;
    }

    if (!workerBuilder || typeof workerBuilder.buildDeckRenderFrame !== 'function') {
        self.postMessage({
            id: data.id,
            type: 'frame',
            success: false,
            error: serializeWorkerError(new Error('DeckFrameBuilder unavailable in worker'))
        });
        return;
    }

    try {
        const frame = workerBuilder.buildDeckRenderFrame(data.payload || {});
        self.postMessage({
            id: data.id,
            type: 'frame',
            success: true,
            frame
        });
    } catch (error) {
        self.postMessage({
            id: data.id,
            type: 'frame',
            success: false,
            error: serializeWorkerError(error)
        });
    }
});

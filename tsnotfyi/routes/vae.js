// VAE endpoints
// Extracted from server.js for readability

function setupVaeRoutes(app, { vaeService, radialSearch }) {

  // Get VAE service status and model information
  app.get('/vae/status', (req, res) => {
    try {
      const status = vaeService.getStatus();
      const stats = radialSearch.getStats();

      res.json({
        vae: status,
        coverage: stats.vaeStats || null,
        isReady: status.isReady
      });
    } catch (error) {
      console.error('VAE status error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get available search modes for a track
  app.get('/vae/search-modes/:trackId', (req, res) => {
    try {
      const { trackId } = req.params;
      const modes = radialSearch.getAvailableSearchModes(trackId);

      if (!modes) {
        return res.status(404).json({ error: 'Track not found' });
      }

      res.json(modes);
    } catch (error) {
      console.error('VAE search modes error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Encode track features to VAE latent space
  app.post('/vae/encode', async (req, res) => {
    try {
      const { features } = req.body;

      if (!features || typeof features !== 'object') {
        return res.status(400).json({ error: 'Features object required' });
      }

      if (!vaeService.isReady()) {
        return res.status(503).json({ error: 'VAE service not available' });
      }

      const latent = await vaeService.encode(features);
      res.json({ latent });

    } catch (error) {
      console.error('VAE encode error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Decode VAE latent vector to features
  app.post('/vae/decode', async (req, res) => {
    try {
      const { latent } = req.body;

      if (!Array.isArray(latent) || latent.length !== 8) {
        return res.status(400).json({ error: '8D latent vector required' });
      }

      if (!vaeService.isReady()) {
        return res.status(503).json({ error: 'VAE service not available' });
      }

      const features = await vaeService.decode(latent);
      res.json({ features });

    } catch (error) {
      console.error('VAE decode error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Interpolate between two latent vectors
  app.post('/vae/interpolate', async (req, res) => {
    try {
      const { latent1, latent2, steps = 5 } = req.body;

      if (!Array.isArray(latent1) || latent1.length !== 8) {
        return res.status(400).json({ error: 'latent1: 8D vector required' });
      }
      if (!Array.isArray(latent2) || latent2.length !== 8) {
        return res.status(400).json({ error: 'latent2: 8D vector required' });
      }

      if (!vaeService.isReady()) {
        return res.status(503).json({ error: 'VAE service not available' });
      }

      const interpolations = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const interpolated = latent1.map((v, j) => v + t * (latent2[j] - v));
        const features = await vaeService.decode(interpolated);
        interpolations.push({
          step: i,
          t,
          latent: interpolated,
          features
        });
      }

      res.json({ interpolations, steps });

    } catch (error) {
      console.error('VAE interpolate error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Flow along a latent dimension
  app.post('/vae/flow', async (req, res) => {
    try {
      const { startLatent, dimension, steps = 10, magnitude = 2.0 } = req.body;

      if (!Array.isArray(startLatent) || startLatent.length !== 8) {
        return res.status(400).json({ error: 'startLatent: 8D vector required' });
      }
      if (typeof dimension !== 'number' || dimension < 0 || dimension > 7) {
        return res.status(400).json({ error: 'dimension: 0-7 required' });
      }

      if (!vaeService.isReady()) {
        return res.status(503).json({ error: 'VAE service not available' });
      }

      const flow = [];
      for (let i = -steps; i <= steps; i++) {
        const offset = (i / steps) * magnitude;
        const latent = [...startLatent];
        latent[dimension] += offset;
        const features = await vaeService.decode(latent);
        flow.push({
          step: i,
          offset,
          latent,
          features
        });
      }

      res.json({ flow, dimension, magnitude, steps });

    } catch (error) {
      console.error('VAE flow error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Explore latent space around a track
  app.post('/vae/explore', async (req, res) => {
    try {
      const { trackId, radius = 0.5, samples = 10 } = req.body;

      if (!trackId) {
        return res.status(400).json({ error: 'trackId required' });
      }

      if (!vaeService.isReady()) {
        return res.status(503).json({ error: 'VAE service not available' });
      }

      const neighbors = radialSearch.kdTree.vaeRadiusSearch(
        { identifier: trackId },
        radius,
        samples
      );

      res.json({
        center: trackId,
        radius,
        neighbors: neighbors.map(n => ({
          identifier: n.identifier,
          distance: n.distance,
          title: n.title,
          artist: n.artist
        }))
      });

    } catch (error) {
      console.error('VAE explore error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get VAE latent space dimensions and information
  app.get('/vae/dimensions', async (req, res) => {
    try {
      if (!vaeService.isReady()) {
        return res.status(503).json({ error: 'VAE service not available' });
      }

      const info = await vaeService.getLatentInfo();
      res.json(info);

    } catch (error) {
      console.error('VAE dimensions error:', error);
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { setupVaeRoutes };

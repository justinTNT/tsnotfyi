"""Unit tests for MusicVAE inference compatibility."""

import sys
import unittest
import tempfile
from pathlib import Path

import numpy as np


PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from services.musicVAE import MusicVAE, save_model  # noqa: E402
from ml.music_vae import MusicVAEInference  # noqa: E402


class MusicVAEInferenceTests(unittest.TestCase):
    """Verify that inference can load checkpoints produced by the trainer."""

    def test_inference_loads_and_encodes_saved_model(self) -> None:
        model = MusicVAE(input_dim=18, latent_dim=8)
        feature_names = [
            'bpm', 'danceability', 'onset_rate', 'beat_punch', 'tonal_clarity',
            'tuning_purity', 'fifths_strength', 'chord_strength',
            'chord_change_rate', 'crest', 'entropy', 'spectral_centroid',
            'spectral_rolloff', 'spectral_kurtosis', 'spectral_energy',
            'spectral_flatness', 'sub_drive', 'air_sizzle'
        ]

        metadata = {
            'trained_at': '2024-01-01T00:00:00Z',
            'feature_names': feature_names,
            'core_features': feature_names,
            'scaler_mean': [0.0] * len(feature_names),
            'scaler_scale': [1.0] * len(feature_names),
            'beta': model.beta,
            'latent_dim': model.latent_dim,
            'history': [],
            'model_version': 'test_model',
            'model_config': {
                'input_dim': model.input_dim,
                'latent_dim': model.latent_dim,
                'hidden_dims': model.hidden_dims,
                'beta': model.beta,
                'dropout': model.dropout,
            },
            'hidden_dims': model.hidden_dims,
            'dropout': model.dropout,
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            checkpoint_path = Path(tmpdir) / 'music_vae.pt'
            save_model(model, str(checkpoint_path), metadata=metadata)

            inference = MusicVAEInference(device='cpu')
            load_result = inference.load_model(str(checkpoint_path))

            self.assertEqual(load_result['status'], 'success', load_result)
            self.assertTrue(inference.is_loaded)
            self.assertEqual(inference.feature_names, feature_names)

            sample_features = np.zeros(len(feature_names), dtype=np.float32)
            latent = inference.encode(sample_features.tolist())
            self.assertEqual(len(latent), model.latent_dim)

            decoded = inference.decode([0.0] * model.latent_dim)
            self.assertEqual(len(decoded), len(feature_names))


if __name__ == '__main__':
    unittest.main()

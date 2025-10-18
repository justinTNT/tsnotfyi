#!/usr/bin/env python3
"""
VAE Inference Script for tsnotfyi
Handles subprocess communication for VAE model inference operations.

This script runs as a persistent subprocess and communicates with Node.js
via JSON messages over stdin/stdout.

Usage:
    python vae_inference.py --model-path ./models/music_vae.pt
"""

import argparse
import json
import sys
import traceback
from pathlib import Path

# Add the ml module to Python path
sys.path.insert(0, str(Path(__file__).parent.parent / 'ml'))

from music_vae import MusicVAEInference


class VAEInferenceServer:
    """
    JSON-RPC style server for VAE inference operations.
    Processes requests from Node.js and returns responses via stdout.
    """
    
    def __init__(self, model_path: str):
        self.model_path = model_path
        self.vae = MusicVAEInference()
        self.is_model_loaded = False
        
        # Send ready signal
        self.send_response({'status': 'ready', 'message': 'VAE inference server started'})
    
    def send_response(self, response: dict):
        """Send JSON response to stdout."""
        try:
            json_response = json.dumps(response)
            print(json_response, flush=True)
        except Exception as e:
            error_response = {
                'status': 'error',
                'error': f'Failed to serialize response: {str(e)}'
            }
            print(json.dumps(error_response), flush=True)
    
    def send_error(self, request_id: int, error_message: str, exception: Exception = None):
        """Send error response."""
        response = {
            'id': request_id,
            'status': 'error',
            'error': error_message
        }
        
        if exception:
            response['exception_type'] = type(exception).__name__
            response['traceback'] = traceback.format_exc()
        
        self.send_response(response)
    
    def handle_load_model(self, request: dict) -> dict:
        """Load VAE model from specified path."""
        model_path = request.get('model_path', self.model_path)
        
        try:
            result = self.vae.load_model(model_path)
            
            if result['status'] == 'success':
                self.is_model_loaded = True
                return {
                    'status': 'success',
                    'message': 'Model loaded successfully',
                    'model_info': result['model_info']
                }
            else:
                return result
                
        except Exception as e:
            return {
                'status': 'error',
                'error': f'Failed to load model: {str(e)}'
            }
    
    def handle_encode(self, request: dict) -> dict:
        """Encode features to latent space."""
        if not self.is_model_loaded:
            return {'status': 'error', 'error': 'Model not loaded'}
        
        try:
            features = request['features']
            latent = self.vae.encode(features)
            
            return {
                'status': 'success',
                'latent': latent
            }
            
        except Exception as e:
            return {
                'status': 'error',
                'error': f'Encoding failed: {str(e)}'
            }
    
    def handle_decode(self, request: dict) -> dict:
        """Decode latent vector to features."""
        if not self.is_model_loaded:
            return {'status': 'error', 'error': 'Model not loaded'}
        
        try:
            latent = request['latent']
            features = self.vae.decode(latent)
            
            return {
                'status': 'success',
                'features': features
            }
            
        except Exception as e:
            return {
                'status': 'error',
                'error': f'Decoding failed: {str(e)}'
            }
    
    def handle_interpolate(self, request: dict) -> dict:
        """Interpolate between two tracks in latent space."""
        if not self.is_model_loaded:
            return {'status': 'error', 'error': 'Model not loaded'}
        
        try:
            features_a = request['features_a']
            features_b = request['features_b']
            steps = request.get('steps', 10)
            
            interpolation = self.vae.interpolate(features_a, features_b, steps)
            
            return {
                'status': 'success',
                'interpolation': interpolation,
                'steps': steps
            }
            
        except Exception as e:
            return {
                'status': 'error',
                'error': f'Interpolation failed: {str(e)}'
            }
    
    def handle_flow(self, request: dict) -> dict:
        """Move in latent space from starting point."""
        if not self.is_model_loaded:
            return {'status': 'error', 'error': 'Model not loaded'}
        
        try:
            features = request['features']
            direction = request['direction']
            amount = request.get('amount', 1.0)
            
            result_features = self.vae.flow(features, direction, amount)
            
            return {
                'status': 'success',
                'features': result_features,
                'direction': direction,
                'amount': amount
            }
            
        except Exception as e:
            return {
                'status': 'error',
                'error': f'Flow operation failed: {str(e)}'
            }
    
    def handle_get_info(self, request: dict) -> dict:
        """Get model and latent space information."""
        if not self.is_model_loaded:
            return {'status': 'error', 'error': 'Model not loaded'}
        
        try:
            info = self.vae.get_info()
            
            return {
                'status': 'success',
                'info': info
            }
            
        except Exception as e:
            return {
                'status': 'error',
                'error': f'Info retrieval failed: {str(e)}'
            }
    
    def handle_request(self, request: dict):
        """Handle incoming request from Node.js."""
        request_id = request.get('id')
        action = request.get('action')
        
        if not request_id:
            self.send_error(0, 'Missing request ID')
            return
        
        if not action:
            self.send_error(request_id, 'Missing action')
            return
        
        try:
            # Dispatch to appropriate handler
            if action == 'load_model':
                result = self.handle_load_model(request)
            elif action == 'encode':
                result = self.handle_encode(request)
            elif action == 'decode':
                result = self.handle_decode(request)
            elif action == 'interpolate':
                result = self.handle_interpolate(request)
            elif action == 'flow':
                result = self.handle_flow(request)
            elif action == 'get_info':
                result = self.handle_get_info(request)
            else:
                result = {
                    'status': 'error',
                    'error': f'Unknown action: {action}'
                }
            
            # Add request ID and send response
            result['id'] = request_id
            self.send_response(result)
            
        except Exception as e:
            self.send_error(request_id, 'Internal server error', e)
    
    def run(self):
        """Main server loop - process requests from stdin."""
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                
                try:
                    request = json.loads(line)
                    self.handle_request(request)
                    
                except json.JSONDecodeError as e:
                    self.send_error(0, f'Invalid JSON: {str(e)}')
                    
                except Exception as e:
                    self.send_error(0, f'Request processing error: {str(e)}', e)
        
        except KeyboardInterrupt:
            self.send_response({'status': 'info', 'message': 'VAE inference server shutting down'})
        
        except Exception as e:
            self.send_response({
                'status': 'error', 
                'error': f'Server error: {str(e)}',
                'traceback': traceback.format_exc()
            })


def main():
    parser = argparse.ArgumentParser(description='VAE Inference Server for tsnotfyi')
    parser.add_argument('--model-path', required=True, help='Path to trained VAE model')
    parser.add_argument('--verbose', action='store_true', help='Enable verbose logging')
    
    args = parser.parse_args()
    
    # Validate model path
    if not Path(args.model_path).exists():
        print(json.dumps({
            'status': 'error',
            'error': f'Model file not found: {args.model_path}'
        }), flush=True)
        sys.exit(1)
    
    # Start server
    try:
        server = VAEInferenceServer(args.model_path)
        server.run()
    except Exception as e:
        print(json.dumps({
            'status': 'error',
            'error': f'Failed to start VAE inference server: {str(e)}',
            'traceback': traceback.format_exc()
        }), flush=True)
        sys.exit(1)


if __name__ == '__main__':
    main()
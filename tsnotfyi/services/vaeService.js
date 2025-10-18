const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * VAE Service Wrapper
 * Manages Python subprocess for VAE model inference operations
 * 
 * Provides methods for:
 * - encode: Project 18D features to 8D latent space
 * - decode: Generate 18D features from 8D latent vectors
 * - interpolate: Create smooth paths between tracks in latent space
 * - flow: Move in specific directions within latent space
 */
class VAEService {
    constructor(config = {}) {
        this.config = {
            modelPath: config.modelPath || './models/music_vae.pt',
            pythonPath: config.pythonPath || 'python',
            scriptPath: config.scriptPath || path.join(__dirname, 'musicVAE.py'),
            timeout: config.timeout || 30000, // 30 second timeout
            maxRetries: config.maxRetries || 3,
            ...config
        };
        
        this.isInitialized = false;
        this.pythonProcess = null;
        this.requestId = 0;
        this.pendingRequests = new Map();
        this.modelLoaded = false;
        
        // Core 18 features (must match training order from beets2tsnot.py)
        this.featureNames = [
            'bpm', 'danceability', 'onset_rate', 'beat_punch',
            'tonal_clarity', 'tuning_purity', 'fifths_strength',
            'chord_strength', 'chord_change_rate', 'crest', 'entropy',
            'spectral_centroid', 'spectral_rolloff', 'spectral_kurtosis',
            'spectral_energy', 'spectral_flatness', 'sub_drive', 'air_sizzle'
        ];
    }
    
    async initialize() {
        if (this.isInitialized) {
            return;
        }
        
        console.log('🧠 Initializing VAE Service...');
        
        // Check if model file exists
        if (!fs.existsSync(this.config.modelPath)) {
            throw new Error(`VAE model not found at: ${this.config.modelPath}`);
        }
        
        // Check if inference script exists
        if (!fs.existsSync(this.config.scriptPath)) {
            throw new Error(`VAE inference script not found at: ${this.config.scriptPath}`);
        }
        
        await this.startPythonProcess();
        await this.loadModel();
        
        this.isInitialized = true;
        console.log('✓ VAE Service initialized successfully');
    }
    
    async startPythonProcess() {
        console.log('🐍 Starting Python VAE inference process...');
        
        this.pythonProcess = spawn(this.config.pythonPath, [
            this.config.scriptPath,
            '--model-path', this.config.modelPath
        ], {
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        // Handle process errors
        this.pythonProcess.on('error', (error) => {
            console.error('❌ Python process error:', error);
            this.handleProcessError(error);
        });
        
        this.pythonProcess.on('exit', (code, signal) => {
            console.warn(`⚠️ Python process exited with code ${code}, signal ${signal}`);
            this.handleProcessExit(code, signal);
        });
        
        // Handle stdout responses
        let buffer = '';
        this.pythonProcess.stdout.on('data', (data) => {
            buffer += data.toString();
            
            // Process complete JSON messages
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                const message = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                
                if (message.trim()) {
                    this.handlePythonResponse(message);
                }
            }
        });
        
        // Handle stderr
        this.pythonProcess.stderr.on('data', (data) => {
            const message = data.toString().trim();
            if (message) {
                console.warn('🐍 Python stderr:', message);
            }
        });
        
        // Wait for process to be ready
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Python process startup timeout'));
            }, 10000);
            
            this.pythonProcess.stdout.once('data', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
        
        console.log('✓ Python process started');
    }
    
    async loadModel() {
        console.log('📦 Loading VAE model...');
        
        const response = await this.sendRequest({
            action: 'load_model',
            model_path: this.config.modelPath
        });
        
        if (response.status === 'success') {
            this.modelLoaded = true;
            console.log('✓ VAE model loaded successfully');
            console.log(`  - Input dimensions: ${response.model_info.input_dim}`);
            console.log(`  - Latent dimensions: ${response.model_info.latent_dim}`);
            console.log(`  - Model architecture: ${response.model_info.hidden_dims.join(' → ')}`);
        } else {
            throw new Error(`Failed to load VAE model: ${response.error}`);
        }
    }
    
    async sendRequest(request) {
        if (!this.pythonProcess) {
            throw new Error('Python process not initialized');
        }
        
        const requestId = ++this.requestId;
        const fullRequest = { id: requestId, ...request };
        
        return new Promise((resolve, reject) => {
            // Set up timeout
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`Request ${requestId} timeout after ${this.config.timeout}ms`));
            }, this.config.timeout);
            
            // Store request
            this.pendingRequests.set(requestId, { resolve, reject, timeout });
            
            // Send request
            const requestJson = JSON.stringify(fullRequest) + '\n';
            this.pythonProcess.stdin.write(requestJson);
        });
    }
    
    handlePythonResponse(message) {
        try {
            const response = JSON.parse(message);
            const requestId = response.id;
            
            const pendingRequest = this.pendingRequests.get(requestId);
            if (pendingRequest) {
                clearTimeout(pendingRequest.timeout);
                this.pendingRequests.delete(requestId);
                
                if (response.status === 'success') {
                    pendingRequest.resolve(response);
                } else {
                    pendingRequest.reject(new Error(response.error || 'Unknown error'));
                }
            }
        } catch (error) {
            console.error('❌ Failed to parse Python response:', message, error);
        }
    }
    
    handleProcessError(error) {
        // Reject all pending requests
        for (const [requestId, request] of this.pendingRequests) {
            clearTimeout(request.timeout);
            request.reject(new Error(`Python process error: ${error.message}`));
        }
        this.pendingRequests.clear();
        
        this.pythonProcess = null;
        this.modelLoaded = false;
        this.isInitialized = false;
    }
    
    handleProcessExit(code, signal) {
        // Reject all pending requests
        for (const [requestId, request] of this.pendingRequests) {
            clearTimeout(request.timeout);
            request.reject(new Error(`Python process exited with code ${code}`));
        }
        this.pendingRequests.clear();
        
        this.pythonProcess = null;
        this.modelLoaded = false;
        this.isInitialized = false;
    }
    
    // Convert track features object to array in correct order
    featuresToArray(features) {
        return this.featureNames.map(name => {
            const value = features[name];
            if (value === undefined || value === null) {
                throw new Error(`Missing feature: ${name}`);
            }
            return value;
        });
    }
    
    // Convert array back to features object
    arrayToFeatures(array) {
        if (array.length !== this.featureNames.length) {
            throw new Error(`Expected ${this.featureNames.length} features, got ${array.length}`);
        }
        
        const features = {};
        this.featureNames.forEach((name, index) => {
            features[name] = array[index];
        });
        return features;
    }
    
    /**
     * Encode 18D features to 8D latent space
     * @param {Object} features - Track features object
     * @returns {Array} 8D latent vector
     */
    async encode(features) {
        if (!this.isInitialized || !this.modelLoaded) {
            throw new Error('VAE service not initialized or model not loaded');
        }
        
        const featureArray = this.featuresToArray(features);
        
        const response = await this.sendRequest({
            action: 'encode',
            features: featureArray
        });
        
        return response.latent;
    }
    
    /**
     * Decode 8D latent vector to 18D features
     * @param {Array} latent - 8D latent vector
     * @returns {Object} Reconstructed features object
     */
    async decode(latent) {
        if (!this.isInitialized || !this.modelLoaded) {
            throw new Error('VAE service not initialized or model not loaded');
        }
        
        if (!Array.isArray(latent) || latent.length !== 8) {
            throw new Error('Latent vector must be an array of 8 numbers');
        }
        
        const response = await this.sendRequest({
            action: 'decode',
            latent: latent
        });
        
        return this.arrayToFeatures(response.features);
    }
    
    /**
     * Interpolate between two tracks in latent space
     * @param {Object} trackA - First track features
     * @param {Object} trackB - Second track features  
     * @param {number} steps - Number of interpolation steps
     * @returns {Array} Array of feature objects representing interpolation path
     */
    async interpolate(trackA, trackB, steps = 10) {
        if (!this.isInitialized || !this.modelLoaded) {
            throw new Error('VAE service not initialized or model not loaded');
        }
        
        const featuresA = this.featuresToArray(trackA);
        const featuresB = this.featuresToArray(trackB);
        
        const response = await this.sendRequest({
            action: 'interpolate',
            features_a: featuresA,
            features_b: featuresB,
            steps: steps
        });
        
        return response.interpolation.map(featureArray => this.arrayToFeatures(featureArray));
    }
    
    /**
     * Move in latent space from a starting point
     * @param {Object} baseFeatures - Starting track features
     * @param {Array} direction - 8D direction vector in latent space
     * @param {number} amount - Magnitude of movement (default: 1.0)
     * @returns {Object} New features object after movement
     */
    async flow(baseFeatures, direction, amount = 1.0) {
        if (!this.isInitialized || !this.modelLoaded) {
            throw new Error('VAE service not initialized or model not loaded');
        }
        
        if (!Array.isArray(direction) || direction.length !== 8) {
            throw new Error('Direction must be an array of 8 numbers');
        }
        
        const featureArray = this.featuresToArray(baseFeatures);
        
        const response = await this.sendRequest({
            action: 'flow',
            features: featureArray,
            direction: direction,
            amount: amount
        });
        
        return this.arrayToFeatures(response.features);
    }
    
    /**
     * Get latent space statistics and information
     * @returns {Object} Model and latent space information
     */
    async getLatentInfo() {
        if (!this.isInitialized || !this.modelLoaded) {
            throw new Error('VAE service not initialized or model not loaded');
        }
        
        const response = await this.sendRequest({
            action: 'get_info'
        });
        
        return response.info;
    }
    
    /**
     * Check if VAE service is ready
     * @returns {boolean} Service status
     */
    isReady() {
        return this.isInitialized && this.modelLoaded && this.pythonProcess !== null;
    }
    
    /**
     * Get service status and statistics
     * @returns {Object} Service status information
     */
    getStatus() {
        return {
            initialized: this.isInitialized,
            modelLoaded: this.modelLoaded,
            processActive: this.pythonProcess !== null,
            pendingRequests: this.pendingRequests.size,
            modelPath: this.config.modelPath,
            isReady: this.isReady()
        };
    }
    
    /**
     * Shutdown VAE service and clean up resources
     */
    async shutdown() {
        console.log('🛑 Shutting down VAE service...');
        
        // Reject all pending requests
        for (const [requestId, request] of this.pendingRequests) {
            clearTimeout(request.timeout);
            request.reject(new Error('VAE service shutting down'));
        }
        this.pendingRequests.clear();
        
        // Terminate Python process
        if (this.pythonProcess) {
            this.pythonProcess.kill('SIGTERM');
            
            // Force kill after 5 seconds
            setTimeout(() => {
                if (this.pythonProcess) {
                    this.pythonProcess.kill('SIGKILL');
                }
            }, 5000);
            
            this.pythonProcess = null;
        }
        
        this.isInitialized = false;
        this.modelLoaded = false;
        
        console.log('✓ VAE service shutdown complete');
    }
}

module.exports = VAEService;
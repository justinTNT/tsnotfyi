const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class AudioMixer {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.clients = new Set();
    this.isActive = false;
    this.ambientProcess = null;

    // Audio configuration
    this.sampleRate = 44100;
    this.channels = 2;
    this.bitRate = 192; // kbps

    console.log(`Created audio mixer for session: ${sessionId}`);
  }

  // Start ambient background audio
  startAmbient() {
    if (this.ambientProcess) {
      this.ambientProcess.kill('SIGTERM');
    }

    console.log(`Starting ambient for session: ${this.sessionId}`);

    // Get current hour for time-synced ambient
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const second = now.getSeconds();

    const hourFile = hour + 1;
    const hourPadded = hourFile < 10 ? `0${hourFile}` : `${hourFile}`;
    const seekSeconds = minute * 60 + second;

    const clippingDir = "/Volumes/willbe/fulllength/2022/Sep 22/clipping/2016 DREAM REMX";
    const trackPath = `${clippingDir}/${hourPadded} - hour ${hourFile}.flac`;

    // Check if hourly track exists
    const useHourlyTrack = fs.existsSync(trackPath);

    if (useHourlyTrack) {
      console.log(`Playing hourly track: ${trackPath} - continuous streaming`);

      // Use spawn directly for more control - play continuously without seeking
      const ffmpegArgs = [
        '-stream_loop', '-1', // Loop indefinitely
        '-i', trackPath,
        '-vn', // No video (skip album art)
        '-ac', '2',
        '-ar', '44100',
        '-b:a', '64k',
        '-filter:a', 'volume=1.0,highpass=f=80,lowpass=f=8000', // Full volume
        '-f', 'mp3',
        '-map_metadata', '-1', // Strip metadata
        'pipe:1'
      ];

      this.ambientProcess = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      console.log(`FFmpeg started with args: ffmpeg ${ffmpegArgs.join(' ')}`);

      // Handle stdout data
      this.ambientProcess.stdout.on('data', (chunk) => {
        console.log(`📻 Received ${chunk.length} bytes of audio data`);
        this.broadcastToClients(chunk);
      });

      // Handle errors
      this.ambientProcess.stderr.on('data', (data) => {
        console.error('FFmpeg stderr:', data.toString());
      });

      this.ambientProcess.on('close', (code) => {
        console.log(`FFmpeg process exited with code ${code}`);
        if (this.isActive) {
          setTimeout(() => this.startAmbient(), 1000);
        }
      });

      this.ambientProcess.on('error', (err) => {
        console.error('FFmpeg spawn error:', err);
        this.fallbackToNoise();
      });

    } else {
      console.log('Hourly track not found, using brown noise');
      this.fallbackToNoise();
    }
  }

  // Fallback to generated noise
  fallbackToNoise() {
    console.log('Using silence fallback instead of noise');

    // For now, let's just use a simple silence generator
    const ffmpegArgs = [
      '-f', 'lavfi',
      '-i', 'anoisesrc=color=brown:sample_rate=44100:duration=3600', // 1 hour of brown noise
      '-ac', '2',
      '-ar', '44100',
      '-b:a', '32k',
      '-filter:a', 'volume=0.05,highpass=f=100,lowpass=f=4000',
      '-f', 'mp3',
      'pipe:1'
    ];

    this.ambientProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    console.log(`Noise fallback started: ffmpeg ${ffmpegArgs.join(' ')}`);

    // Handle stdout data
    this.ambientProcess.stdout.on('data', (chunk) => {
      this.broadcastToClients(chunk);
    });

    // Handle errors
    this.ambientProcess.stderr.on('data', (data) => {
      console.error('Noise FFmpeg stderr:', data.toString());
    });

    this.ambientProcess.on('close', (code) => {
      console.log(`Noise FFmpeg process exited with code ${code}`);
      if (this.isActive) {
        setTimeout(() => this.fallbackToNoise(), 1000);
      }
    });

    this.ambientProcess.on('error', (err) => {
      console.error('Noise FFmpeg spawn error:', err);
    });
  }

  // Add a client to receive the stream
  addClient(response) {
    console.log(`Adding client to session: ${this.sessionId}`);

    // Set proper headers for MP3 streaming
    response.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range',
      'Accept-Ranges': 'none'
    });

    this.clients.add(response);

    // Start ambient if this is the first client
    if (this.clients.size === 1 && !this.isActive) {
      this.startStreaming();
    }

    // Handle client disconnect
    response.on('close', () => {
      console.log(`❌ Client disconnected from session: ${this.sessionId}`);
      this.clients.delete(response);

      // Stop streaming if no clients
      if (this.clients.size === 0) {
        this.stopStreaming();
      }
    });

    response.on('error', (err) => {
      console.error('❌ Client response error:', err);
      this.clients.delete(response);
    });

    response.on('finish', () => {
      console.log(`✅ Client response finished for session: ${this.sessionId}`);
    });
  }

  // Start the audio streaming pipeline
  startStreaming() {
    if (this.isActive) return;

    console.log(`Starting streaming for session: ${this.sessionId}`);
    this.isActive = true;

    this.startAmbient();

    // Audio streaming is set up in startAmbient() method
  }

  // Stop streaming
  stopStreaming() {
    if (!this.isActive) return;

    console.log(`Stopping streaming for session: ${this.sessionId}`);
    this.isActive = false;

    if (this.ambientProcess) {
      this.ambientProcess.kill('SIGTERM');
      this.ambientProcess = null;
    }
  }

  // Send audio data to all connected clients
  broadcastToClients(chunk) {
    console.log(`🎵 Broadcasting ${chunk.length} bytes to ${this.clients.size} clients`);
    for (const client of this.clients) {
      try {
        if (!client.destroyed) {
          client.write(chunk);
        }
      } catch (err) {
        console.error('Error writing to client:', err);
        this.clients.delete(client);
      }
    }
  }

  // Clean up
  destroy() {
    console.log(`Destroying mixer for session: ${this.sessionId}`);
    this.stopStreaming();

    // Close all client connections
    for (const client of this.clients) {
      try {
        client.end();
      } catch (err) {
        // Ignore errors when closing
      }
    }
    this.clients.clear();
  }

  // Get session stats
  getStats() {
    return {
      sessionId: this.sessionId,
      clients: this.clients.size,
      isActive: this.isActive,
      hasAmbient: !!this.ambientProcess
    };
  }
}

module.exports = AudioMixer;
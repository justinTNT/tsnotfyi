# User Data API Documentation

## Overview

The User Data API provides endpoints for managing user interactions with tracks, including ratings, play statistics, and playlists. All data is stored in PostgreSQL with proper foreign key relationships to the music analysis table.

## Database Schema

### Tables Created by Migration 002

- **`play_stats`** - Track completion statistics
- **`ratings`** - User love/hate ratings  
- **`playlists`** - Named playlist collections
- **`playlist_items`** - Individual tracks within playlists

## API Endpoints

### Track Ratings

#### `POST /api/track/:id/rate`
Rate a track with love/hate preference.

**Request Body:**
```json
{
  "rating": 1  // -1 = hate, 0 = neutral, 1 = love
}
```

**Response:**
```json
{
  "identifier": "track_001",
  "rating": 1,
  "rated_at": "2025-10-15T10:30:00Z"
}
```

### Play Statistics

#### `POST /api/track/:id/complete`
Mark a track as completed (successful crossfade).

**Request Body:**
```json
{
  "playTime": 180  // optional: seconds of listening time
}
```

**Response:**
```json
{
  "identifier": "track_001",
  "completion_count": 5,
  "total_play_time": 900,
  "last_completed": "2025-10-15T10:30:00Z"
}
```

#### `GET /api/track/:id/stats`
Get combined rating and play statistics for a track.

**Response:**
```json
{
  "identifier": "track_001",
  "rating": 1,
  "rated_at": "2025-10-15T10:30:00Z",
  "completion_count": 5,
  "total_play_time": 900,
  "last_completed": "2025-10-15T10:30:00Z"
}
```

### Playlists

#### `POST /api/playlists`
Create a new playlist.

**Request Body:**
```json
{
  "name": "My Journey",
  "description": "A musical exploration" // optional
}
```

**Response:**
```json
{
  "id": 1,
  "name": "My Journey",
  "description": "A musical exploration",
  "created_at": "2025-10-15T10:30:00Z",
  "updated_at": "2025-10-15T10:30:00Z"
}
```

#### `GET /api/playlists`
Get all playlists with track counts.

**Response:**
```json
[
  {
    "id": 1,
    "name": "My Journey",
    "description": "A musical exploration",
    "created_at": "2025-10-15T10:30:00Z",
    "updated_at": "2025-10-15T10:30:00Z",
    "track_count": "3"
  }
]
```

#### `GET /api/playlists/:id`
Get a specific playlist with all tracks.

**Response:**
```json
{
  "id": 1,
  "name": "My Journey",
  "description": "A musical exploration",
  "created_at": "2025-10-15T10:30:00Z",
  "updated_at": "2025-10-15T10:30:00Z",
  "tracks": [
    {
      "id": 1,
      "identifier": "track_001",
      "position": 0,
      "direction": null,
      "scope": "magnify",
      "added_at": "2025-10-15T10:30:00Z",
      "bt_artist": "Artist Name",
      "bt_title": "Track Title",
      "bt_album": "Album Name"
    },
    {
      "id": 2,
      "identifier": "track_002", 
      "position": 1,
      "direction": "bpm_positive",
      "scope": "micro",
      "added_at": "2025-10-15T10:31:00Z",
      "bt_artist": "Another Artist",
      "bt_title": "Another Track",
      "bt_album": "Another Album"
    }
  ]
}
```

#### `POST /api/playlists/:id/tracks`
Add a track to a playlist.

**Request Body:**
```json
{
  "identifier": "track_003",
  "direction": "entropy_negative", // optional: how we arrived at this track
  "scope": "tele"                  // optional: search scope used
}
```

**Response:**
```json
{
  "id": 3,
  "playlist_id": 1,
  "identifier": "track_003",
  "position": 2,
  "direction": "entropy_negative",
  "scope": "tele",
  "added_at": "2025-10-15T10:32:00Z"
}
```

## Data Model Details

### Direction and Scope Fields

- **`direction`**: Represents how we arrived at this track from the previous one
  - `null` for first track (seed/starting point)
  - Explorer direction keys like `"bpm_positive"`, `"entropy_negative"`
  - Preserves the journey path for visualization and replay

- **`scope`**: Search resolution level used
  - `"micro"` - microscope view
  - `"magnify"` - magnifying glass view  
  - `"tele"` - telescope view
  - `"jump"` - manually injected track

### Foreign Key Relationships

All user data tables have foreign keys to `music_analysis.identifier` with `ON DELETE CASCADE`, ensuring data integrity when tracks are removed.

## Error Responses

All endpoints return appropriate HTTP status codes:

- **400** - Bad Request (missing/invalid parameters)
- **404** - Not Found (track or playlist doesn't exist)
- **500** - Internal Server Error

Error response format:
```json
{
  "error": "Error message describing what went wrong"
}
```

## Usage Examples

### Rating Workflow
```bash
# Love a track
curl -X POST http://localhost:3000/api/track/abc123/rate \
  -H "Content-Type: application/json" \
  -d '{"rating": 1}'

# Check stats
curl http://localhost:3000/api/track/abc123/stats
```

### Completion Tracking
```bash
# Mark track completed after successful crossfade
curl -X POST http://localhost:3000/api/track/abc123/complete \
  -H "Content-Type: application/json" \
  -d '{"playTime": 240}'
```

### Playlist Creation
```bash
# Create playlist
PLAYLIST=$(curl -s -X POST http://localhost:3000/api/playlists \
  -H "Content-Type: application/json" \
  -d '{"name": "Evening Journey"}')

PLAYLIST_ID=$(echo $PLAYLIST | jq -r '.id')

# Add tracks with journey context
curl -X POST http://localhost:3000/api/playlists/$PLAYLIST_ID/tracks \
  -H "Content-Type: application/json" \
  -d '{"identifier": "track001", "direction": null, "scope": "magnify"}'

curl -X POST http://localhost:3000/api/playlists/$PLAYLIST_ID/tracks \
  -H "Content-Type: application/json" \
  -d '{"identifier": "track002", "direction": "bpm_positive", "scope": "micro"}'
```

## Migration

To apply the database schema:

```bash
# Apply migration 002 to your PostgreSQL database
psql -d tsnotfyi -f migrations/002_add_user_data_tables.sql
```

## Testing

Use the provided test script to verify all endpoints:

```bash
# Update TEST_TRACK variable with a real track identifier first
./test_user_data_endpoints.sh
```
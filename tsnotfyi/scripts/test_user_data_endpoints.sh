#!/bin/bash

# Test script for user data endpoints
# Assumes tsnotfyi server is running on localhost:3000

BASE_URL="http://localhost:3000"
TEST_TRACK="test_track_001" # Replace with actual track identifier

echo "🧪 Testing User Data Endpoints"
echo "================================"

# Test 1: Rate a track (love)
echo "Test 1: Rate track as loved..."
curl -X POST "$BASE_URL/api/track/$TEST_TRACK/rate" \
  -H "Content-Type: application/json" \
  -d '{"rating": 1}' \
  | jq '.'

echo -e "\n"

# Test 2: Mark track as completed
echo "Test 2: Mark track as completed..."
curl -X POST "$BASE_URL/api/track/$TEST_TRACK/complete" \
  -H "Content-Type: application/json" \
  -d '{"playTime": 180}' \
  | jq '.'

echo -e "\n"

# Test 3: Get track stats
echo "Test 3: Get track stats..."
curl -X GET "$BASE_URL/api/track/$TEST_TRACK/stats" \
  | jq '.'

echo -e "\n"

# Test 4: Create a playlist
echo "Test 4: Create a playlist..."
PLAYLIST_RESPONSE=$(curl -s -X POST "$BASE_URL/api/playlists" \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Journey", "description": "A test playlist for user data endpoints"}')

echo "$PLAYLIST_RESPONSE" | jq '.'

# Extract playlist ID for next test
PLAYLIST_ID=$(echo "$PLAYLIST_RESPONSE" | jq -r '.id')
echo "Created playlist with ID: $PLAYLIST_ID"

echo -e "\n"

# Test 5: Add track to playlist
echo "Test 5: Add track to playlist..."
curl -X POST "$BASE_URL/api/playlists/$PLAYLIST_ID/tracks" \
  -H "Content-Type: application/json" \
  -d "{\"identifier\": \"$TEST_TRACK\", \"direction\": \"bpm_positive\", \"scope\": \"magnify\"}" \
  | jq '.'

echo -e "\n"

# Test 6: Get all playlists
echo "Test 6: Get all playlists..."
curl -X GET "$BASE_URL/api/playlists" \
  | jq '.'

echo -e "\n"

# Test 7: Get playlist with tracks
echo "Test 7: Get playlist with tracks..."
curl -X GET "$BASE_URL/api/playlists/$PLAYLIST_ID" \
  | jq '.'

echo -e "\n"

# Test 8: Rate track as hated (change rating)
echo "Test 8: Change rating to hate..."
curl -X POST "$BASE_URL/api/track/$TEST_TRACK/rate" \
  -H "Content-Type: application/json" \
  -d '{"rating": -1}' \
  | jq '.'

echo -e "\n"

# Test 9: Mark track completed again (increment count)
echo "Test 9: Mark track completed again..."
curl -X POST "$BASE_URL/api/track/$TEST_TRACK/complete" \
  -H "Content-Type: application/json" \
  -d '{"playTime": 240}' \
  | jq '.'

echo -e "\n"

# Test 10: Final stats check
echo "Test 10: Final track stats..."
curl -X GET "$BASE_URL/api/track/$TEST_TRACK/stats" \
  | jq '.'

echo -e "\n"
echo "✅ User data endpoint tests complete!"
echo "Note: If any test failed with 'Track not found', update TEST_TRACK variable with a real track identifier"
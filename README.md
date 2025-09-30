# sound explorer: data-informed library traversal or over-engineered auto-dj

## Architecture

- **Express.js**: Web server serving the client interface
- **FFmpeg**: Audio processing and encoding for stream input
- **HTML5 Audio**: Browser-native streaming playback

## Getting started

1. beets as source of truth
   for hysterical reasons.

2. ingest script builds a new database
   augmenting beets with essentia analysis
   expect to process 100,000 tracks per day

3. node server.js
   that's all it is.

## Glossy brochure

not another music player. It's a **computational music consciousness** that transforms your personal library from a static collection into an intelligent, explorable musical universe. Instead of browsing by genre or searching for known songs, you navigate through **multidimensional audio feature space** using algorithmic intelligence that knows your library more intimately than any human curator ever could.

Traditional music discovery relies on human categorization (genres, moods, decades) or popularity algorithms (recommendation engines). This system throws out those assumptions entirely. It analyzes the actual audio characteristics of every track using advanced signal processing, then enables navigation through **pure musical similarity** regardless of conventional labels.

You don't search for "upbeat electronic music." Instead, you're currently listening to something, and the system shows you directions to explore: "faster," "darker," "more complex," "chaotic." Each direction leads to tracks that are musically similar in every dimension *except* the one you're navigating, creating coherent yet surprising journeys through your collection.

## The Core Innovation: Radial Search Architecture

Every exploration begins with your current musical position. The system illuminates a multidimensional "spotlight" around that track, finding hundreds of musically similar candidates. It then analyzes which dimensions offer interesting exploration potential *from that specific position*, presenting only the directions that will lead somewhere meaningful.

This contextual approach solves the fundamental problem of multidimensional navigation: showing 50+ dimensions simultaneously would be overwhelming, but showing the same dimensions regardless of context would be useless. The system dynamically surfaces the most relevant exploration directions based on your current musical neighborhood.

## Beyond Human-Scale Discovery

### Exotic Dimensional Hunting
The system can run intensive background analysis to discover musical dimensions that humans haven't conceptualized - combinations of audio features that create traversable paths through your library but defy conventional description. It might discover that tracks with high spectral variance combined with specific rhythmic patterns create a navigation dimension that connects apparently unrelated genres.

### Computational Intimacy
With 100,000+ tracks analyzed, the system builds deep knowledge of your collection's unique connectivity. It learns which tracks serve as "bridges" between different musical regions, identifies isolated musical "islands," and can plan multi-step journeys to reach specific audio characteristics through optimal paths.

### Beautiful Excess
Some discoveries require analyzing the entire library simultaneously - finding the rarest dimensional combinations, mapping unexplored regions, or computing optimal paths through musical space. The system embraces this computational intensity to enable discoveries impossible through casual browsing.

## Interface Philosophy

The UI defies conventional music player design. Instead of a library browser, you see a **three-layer depth architecture**:

- **Layer 1 (Center)**: Current track - detailed, prominent, "you are here"
- **Layer 2 (Action Ring)**: Available dimensions - "faster," "darker," "chaotic" - where navigation decisions happen
- **Layer 3 (Data Horizon)**: Visual preview of where each path leads - glimpses into the topology of musical space

The interface works equally well in manual mode (you steer through dimensional selection) and autopilot mode (algorithm drives, multiple users can watch the same journey unfold).

## Mixing Integration

This isn't just about discovery - it's about seamless playback. Server-side FFmpeg processing provides:
- Crossfades with configurable timing, curves, and EQ envelopes
- Pitch adjustment for BPM matching without tempo artifacts
- Real-time queue management responding to exploration changes

## Paradigm Shift

Most music software assumes you know what you want and helps you find it. This system assumes you don't know what interesting musical territories exist in your own collection, and provides algorithmic tools to explore them systematically.

It transforms music libraries from **statements of taste** into **substrates for computational exploration**, turning the act of listening into a process of dimensional discovery guided by audio analysis rather than human categorization.

This is musical exploration software designed for the reality that most people have access to essentially unlimited music, making the challenge not acquisition but intelligent navigation of overwhelming abundance. It represents the first system architected around **post-scarcity musical exploration** powered by personal computational intimacy.


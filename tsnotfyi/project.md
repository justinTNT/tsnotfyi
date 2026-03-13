# Music Library Exploration Engine

## Overview
Build a computational music discovery system for a 100k+ track personal library using audio feature analysis. Move beyond conventional metadata to enable algorithmic navigation through musical feature space with intelligent mixing and real-time steering capabilities.

## Core Philosophy
Traditional recommendation engines optimize for "more of what you like" - minimizing distance from user preferences. This system inverts that philosophy: The goal is controlled deviation from current position. Each track selection solves: `max(interest) subject to coherence_threshold`
- **Purpose is discovering connections:** Not finding a groove and keeping it

**Journey mode:**
search for next track: lock it in, it slides below the current track, and we can search for its successor. each search is guided by the server's calculated directions.  "What should play next?" becomes "What variations of the emergent dominant discriminators will lead us on an interesting path?"

### Dimensional Thinking
If current track scores high on [energy=0.8, minor_key=0.9, acoustic=0.2], the next track intentionally shifts one primary dimension:
- Keep energy+key, flip acoustic → electronic with same emotional core
- Keep energy+acoustic, shift to major → same intensity, different mood
- Drop energy, keep key+acoustic → intimate folk from driving indie

The algorithm seeks interesting dimensions the playlist might move in.

## Radial Search Primitives

### Core Philosophy: Everything is Dimensional Proximity
All musical exploration reduces to **radial search** through multidimensional space. Rather than complex query languages, the system provides **domain-specific primitives** built on proximity queries that express musical relationships naturally.

### Fundamental Primitive
```javascript
radial_search(center_sha, radius, index_name)
```
All operations compose from this single building block, eliminating architectural complexity while enabling rich musical exploration.

### Adaptive Search Primitives
**Expand until diverse**: `expand_until_diverse(center, min_results, max_radius)`
- Grow search radius until variety threshold met
- Adapts to sparse vs dense regions automatically
- Prevents getting stuck in mono-dimensional clusters

**Density-aware search**: `density_aware_search(center, target_count)`
- Smaller radius in dense areas, larger in sparse regions
- Maintains consistent result counts across library topology
- Natural adaptation to library structure

**Connectivity weighted**: `connectivity_weighted(center, radius, connectivity_threshold)`
- Favor tracks with rich dimensional connections
- Surface hub tracks that bridge multiple regions
- Prioritize exploratory value over pure similarity

### Exploration Primitives
**Gradient walk**: `gradient_walk(start, direction_vector, steps)`
- Follow dimensional gradients for directed exploration
- Navigate toward specific audio characteristics
- Implement "more energy", "more experimental" steering

**Boundary hunt**: `boundary_hunt(center, dimension)`
- Find edges of dimensional clusters
- Discover transition zones between genres/styles
- Surface tracks that bridge disparate regions

**Void discovery**: `void_discovery(center, min_void_radius)`
- Locate empty dimensional spaces
- Find under-explored regions of musical space
- Guide acquisition toward network gaps

### Relationship Primitives
**Bridge finder**: `bridge_finder(cluster_a, cluster_b)`
- Find tracks connecting disparate musical regions
- Surface unlikely but coherent transitions
- Enable navigation between different styles

**Outlier harvest**: `outlier_harvest(center, z_score_threshold)`
- Find dimensional anomalies within clusters
- Surface interesting exceptions to patterns
- Discover edge cases that reveal new dimensions

**Influence radius**: `influence_radius(center, decay_function)`
- Weight results by distance falloff
- Model gradual transitions vs sharp boundaries
- Fine-tune exploration neighborhood shape

## User Interface Philosophy

### Contemplative Rhythm
- **1s response time** acceptable for rich suggestions
- **Laggy UI creates thoughtful feel** - not frantically clicking
- **Decoupled interaction / Delayed gratification** - much of the user action is building the playlist's future - the only immediate UI details are the full screen progress bar and the time.
- **Steering, not browsing** - consulting oracle vs browsing catalog
- **Anticipation over speed** - computation time becomes part of experience

## Operating Modes

### Track Mode (Primary)
- Crossfade mixing for seamless exploration
- Real-time steering and dimensional navigation
- Session-scoped track deduplication
- Gradient-based suggestion engine

### Album Mode
- Gapless playback preserving artistic intent
- End-to-end album experience
- No mixing or crossfading

### Systematic Mode
- Exhaustive exploration within constraints
- "Play every ambient triphop track"
- Coverage-optimized rather than interest-optimized

### Narrative Mode
- Directed journeys with specified start/end points
- Duration-based sessions
- Arc-aware progression algorithms

## Acquisition Strategy Transformation

### From Gatekeeping to Graph Building

**Traditional approach:** Carefully curate based on immediate appeal
- "Will I like this track on its own?"
- Conservative acquisition to maintain quality
- Library as statement of refined taste

**Exploration-enabled approach:** Acquire based on network potential
- "How does this connect to existing collection?"
- Permissive acquisition to expand discovery possibilities
- Library as substrate for computational exploration

### The Bridge Track Hypothesis

Tracks that seem mediocre in isolation may prove valuable as **connector tissue** between different regions of musical space. A weird experimental jazz album might bridge ambient and electronic collections in ways that become apparent only through algorithmic exploration.

### Scaling Strategy

With robust exploration capabilities, library size becomes an asset rather than a burden:
- **200k+ track target:** More material enables richer discovery
- **Tangential content welcome:** Edge cases often reveal interesting connections
- **Quality emerges from quantity:** Good tracks surface through exploration patterns
- **Lidarr acceleration:** Automated acquisition becomes feasible when exploration handles filtering

### Evaluation Shift

Instead of asking "Do I like this?" during acquisition, the question becomes:
- "Does this fill a gap in the exploration graph?"
- "Could this reveal new traversable dimensions?"
- "What musical bridges does this enable?"

The exploration engine makes you **more prepared** to put diverse material on the shelf, trusting that algorithmic discovery will find value in unexpected places.

## Success Metrics

### Discovery Effectiveness
- Find meaningful connections invisible to conventional tools
- Unearth traversable musical dimensions that evade definition
- Reveal under-explored regions of personal collection

### Exploration Quality
- Maintain coherent musical journeys while avoiding repetition
- Balance novelty with continuity
- Successfully navigate preference constraints without staleness

### User Experience
- Steering feels responsive and intentional
- System demonstrates deep knowledge of specific library
- Interface supports both active direction and passive consumption
- Natural interaction patterns emerge for complex musical navigation

### Library Network Effects
- Increased acquisition rate without quality degradation
- Discovery of bridge tracks that connect disparate musical regions
- Emergence of new traversable paths as library grows
- Validation of "mediocre" tracks through algorithmic context
See [radial_search.md](radial_search.md) for core navigation architecture.

- **Library as substrate, not statement** - Include broadly, filter intelligently through computational analysis
- **Exploration over search** - Discover connections rather than find known items
- **Computational intimacy** - Deep algorithmic knowledge of YOUR specific collection
- **Musical programming** - DSL for composing complex musical journeys
- **Post-genre navigation** - Navigate by audio features, not human categories

## End-State Vision

### Party Steering Interface
Central mixing system running on auto-pilot with real-time steering:
- **Auto-pilot mode**: Intelligent queue generation using essentia-derived algorithms
- **Human steering**: "Turn it up", "Go retro", "Something orchestral" - real-time direction changes
- **Seamless mixing**: Professional crossfades with timing, pitch, and EQ control

### Core Stack
1. **Beets** - Initial ingestion and metadata standardization (becomes legacy)
2. **Essentia** - Audio feature extraction (100k tracks → 10GB feature data)
3. **FFmpeg** - decoding
4. **Custom webapp** - Party interface and steering controls + mixing

### Key Components

#### Discriminator Functions
Single functions that collapse multi-dimensional audio features into scalar distances, enabling:
- Spectral similarity across genre boundaries
- Harmonic compatibility for key-aware transitions
- Energy progression mapping for smooth ramps
- Temporal signature matching for rhythm-aware mixing

#### Path Algorithms
- **Energy progression** - Controlled ramping with chaos injection
- **Harmonic journeys** - Key-aware progressions through circle of fifths
- **Spectral bridges** - Connect disparate genres via shared audio DNA
- **Temporal matching** - Rhythm-compatible sequences for seamless mixing
- **Tunable chaos paths** - Structured randomness within feature boundaries

#### Mixing Engine (fed by FFmpeg-decoder)
Server-side audio processing with real-time control:
- **Stream management** - Queue next track with precise timing
- **Crossfade control** - Duration, curve, and EQ envelope specification
- **Pitch adjustment** - BPM matching without tempo artifacts
- **Real-time updates** - Cancel/replace queued tracks based on steering input

## User Capabilities

### Discovery & Exploration
- Navigate by audio similarity regardless of metadata categories
- Find unexpected connections between conventionally different tracks
- Plot multi-step journeys through musical feature space
- Quantify personal taste patterns through computational analysis
- Identify "connector tissue" tracks that bridge musical interests

### Real-Time Control
- **Auto-pilot mixing** with intelligent track selection
- **Multi-modal steering** - desktop keyboard shortcuts + mobile touch interface
- **Contextual buttons** - dynamic steering options based on current track's feature space position
- **Multiple independent streams** - bedroom/living room/phone with separate control
- **Stream sharing** - tune into other streams, optional shared control
- **Subdomain streaming** - genre-specific autopilot stations (ambient.mini.local, party.mini.local)
- **URL-configurable sessions** - bookmarkable autopilot with custom parameters
- **Professional mixing** with crossfades, EQ, and timing control
- **Location-aware streaming** - automatic local vs cloud source switching

### Revolutionary Interface Design
**A UI that defies common sense** by marrying a **hyperdimensional iTunes selector** with the **data drilling thrills of fzf**. One that is just as beautiful to watch in autopilot mode as it is to drive in next-track mode.

**Three-Layer Depth Architecture:**
- **Layer 1 (Front Center)**: Current track - large, detailed, "you are here"
- **Layer 2 (Action Ring)**: Available dimensions - "faster", "louder", "joyful" - where decisions happen
- **Layer 3 (Locked in)**: previous layers of search already 'locked in' behind the current track

**The Navigation Experience:**
Users traverse infinite musical space through **immediate next steps**. Select "faster" → track moves to center, new dimensions emerge. The complexity is **visually suggested** but **interactionally manageable**.

## Plan Tightener

- Plans referencing external inputs must cite the relevant Contract and fixture set before execution.
- Reject plans that cite inputs lacking fixtures or normalization notes.

### The Endgame
A **computational music consciousness** that knows your library more intimately than any human curator could, responds to natural language direction, and creates seamless musical experiences through professional mixing - all powered by deep audio analysis of your specific collection.

The system becomes fluent in YOUR musical language, built from YOUR listening patterns, optimized for YOUR collection's unique connection possibilities.

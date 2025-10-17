# Collaboration Notes

## Communication Optimization Strategies

### Core Principle: Low Syntactic Entropy / High Semantic Value
- Build shared vocabulary that enables compressed, high-bandwidth communication
- Example: "shuffle the deck then flip the cards" → complete UI interaction pattern in 7 words
- Not about token optimization, but about communication efficiency and clarity

### Practical Approaches We'll Try

**1. Vocabulary-First Problem Solving**
- Before diving into implementation, establish precise definitions for key concepts
- If unclear expression → unclear thinking → unclear implementation
- Forces conceptual clarity before building

**2. Meta-Language Reviews** 
- Regular check-ins: "Are we using terms consistently? Any vocabulary gaps slowing us down?"
- Identify and fix communication inefficiencies
- Build/maintain our shared lexicon

**3. Highest Relevant Abstraction Communication**
- Start at the highest useful abstraction level, zoom down only when needed
- Not "add try-catch blocks on lines 23, 47, 83" but "improve error handling"
- Fluid movement between abstraction levels based on what's most efficient

### Working Theories

**Theory 1: Claude as Super Linguist**
- Optimizes for representational clarity and canonical abstractions
- Sees patterns across different representational systems (math, code, natural language, diagrams)
- Values well-defined abstractions for their communicative power, not syntax preferences

**Theory 2: Structure-Dependent Performance**
- Performs better with clear scaffolding and explicit boundaries
- Benefits from canonical references and type definitions
- Example: Zod schemas provided value through definitional clarity, not runtime validation

**Theory 3: aiming for the sweet zone of low syntactic entropy / high semantic value
- when developing a growing system, we want to be able to issue concise but impactful instructions
- debugging is often one liners: that turns it in the other direction

### Language Strategy

**For Debugging: Stay in Familiar Languages**
- Python for ML/data work, JavaScript for web servers
- Debugging requires pattern recognition from seeing lots of failures
- Language familiarity crucial when tracing execution and error patterns

**For Development: Focus on Conceptual Clarity**
- Design abstractions in English using shared vocabulary
- Implement in familiar languages with maximum representational clarity
- Architectural thinking transfers across languages; debugging experience doesn't

### Success Indicators

**When This Approach Works:**
- One-line fixes for complex behavioral issues
- Clean abstractions that match domain concepts
- Efficient problem-solving with minimal back-and-forth
- Natural evolution toward higher communication bandwidth

**When to Adjust:**
- Excessive vocabulary discussion without implementation progress
- Meta-language work that doesn't improve actual outcomes
- Communication becoming ceremonial rather than practical

---

*These are experimental approaches based on observed collaboration patterns. Stay alert to actual improvements in speed, clarity, and outcomes, and watch for new opportunities to lean into these theories about communication and linguistic capabilities. Be alert for experiences that disporve our theories.*

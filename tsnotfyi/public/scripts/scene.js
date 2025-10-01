  // ====== 3D Visualization Setup ======
  const SPARKLE_COUNT = 124;
  const NUM_LONG = 60;
  const NUM_LAT = 80;
  const NUM_LAT_OTHER = 69;
  const TUBE_RADIUS = 0.005;
  const PATH_RES = 123;
  const RADIAL_SEG = 53;
  const BASE_PULSE_HZ = 0.23;
  const SEL_PULSE_HZ = 1.23;

  let RADIUS_SCALE = 0.6;
  let RADIUS_SCALE_TARGET = 0.6;

  // Initialize renderer
  const mount = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 2000);
  makeCurves(scene);
  setUsefulBeams();

  let fuzzyCameraFactor = 1 + Math.random() * Math.random() / 3;
  let rejig = () => camera.position.set(-4 * fuzzyCameraFactor, 8 * fuzzyCameraFactor, -11 * fuzzyCameraFactor);
  rejig();

  const hemi = new THREE.HemisphereLight(0x66ccff, 0x080808, 0.5);
  scene.add(hemi);



  // ====== Force-Based Layout System ======
  class ForceLayoutManager {
      constructor(container) {
          this.container = container;
          this.simulation = null;
          this.nodes = [];
          // Position cards on the right side of screen, leaving left clear for current track
          this.centerX = window.innerWidth * 0.66; // 66% from left (right side)
          this.centerY = window.innerHeight / 2;    // Middle height

          // Layout parameters
          this.baseRadius = 100; // Slightly smaller base radius for tighter grouping
          this.centerForce = 80;  // Strength of center attraction
          this.repelForce = -200; // Less repulsion for tighter clustering
      }

      initializeSimulation() {
          this.simulation = d3.forceSimulation(this.nodes)
              .force('collision', d3.forceCollide().radius(d => d.radius).strength(0.8))
              .force('center', d3.forceCenter(this.centerX, this.centerY).strength(0.1))
              .force('charge', d3.forceManyBody().strength(this.repelForce))
              .force('radial', d3.forceRadial(200, this.centerX, this.centerY).strength(0.3))
              .alphaDecay(0.02) // Slow decay for smooth animation
              .on('tick', () => this.updateCardPositions());

          console.log('🔬 Force simulation initialized');
      }

      addCard(cardElement, cardData) {
          const isNextTrack = cardData.isNextTrack || false;
          const isSelected = cardData.isSelected || false;

          // Dynamic sizing based on card type and selection
          let radius, scale;
          if (isNextTrack && isSelected) {
              radius = this.baseRadius * 1.2; // Largest for selected next track
              scale = 1.0;
          } else if (isNextTrack) {
              radius = this.baseRadius * 1.0; // Medium for next track
              scale = 0.8;
          } else if (isSelected) {
              radius = this.baseRadius * 1.1; // Slightly larger for selected regular
              scale = 0.9;
          } else {
              radius = this.baseRadius * 0.7; // Smallest for regular cards
              scale = 0.5;
          }

          const node = {
              id: cardData.key || `card_${this.nodes.length}`,
              element: cardElement,
              radius: radius,
              scale: scale,
              isNextTrack: isNextTrack,
              isSelected: isSelected,
              // Initialize position near right-side center with some randomness
              x: this.centerX + (Math.random() - 0.5) * 150,
              y: this.centerY + (Math.random() - 0.5) * 150,
              vx: 0,
              vy: 0
          };

          this.nodes.push(node);

          // Apply initial styling with performance optimizations
          cardElement.style.transform = `translate(-50%, -50%) scale(${scale})`;
          cardElement.style.transition = 'transform 0.15s ease-out'; // Faster animation
          cardElement.style.position = 'absolute';
          cardElement.style.zIndex = isNextTrack ? '100' : '50';
          cardElement.style.willChange = 'transform'; // Optimize for transforms

          console.log(`🔬 Added ${isNextTrack ? 'NEXT' : 'REG'} card: ${node.id}, radius: ${radius}`);
          return node;
      }

      updateCardPositions() {
          this.nodes.forEach(node => {
              if (node.element && node.element.parentElement) {
                  // Convert simulation coordinates to percentages
                  const leftPercent = (node.x / window.innerWidth) * 100;
                  const topPercent = (node.y / window.innerHeight) * 100;

                  node.element.style.left = `${leftPercent}%`;
                  node.element.style.top = `${topPercent}%`;
                  node.element.style.transform = `translate(-50%, -50%) scale(${node.scale})`;
              }
          });
      }

      selectCard(cardId) {
          console.log(`🔬 Selecting card: ${cardId}`);

          this.nodes.forEach(node => {
              const wasSelected = node.isSelected;
              node.isSelected = (node.id === cardId);

              // Update radius and scale for selection change
              if (node.isSelected && !wasSelected) {
                  node.radius *= 1.2;
                  node.scale *= 1.1;
                  node.element.style.zIndex = '200'; // Bring to front
              } else if (!node.isSelected && wasSelected) {
                  node.radius /= 1.2;
                  node.scale /= 1.1;
                  node.element.style.zIndex = node.isNextTrack ? '100' : '50';
              }
          });

          // Restart simulation with higher alpha to animate the changes
          if (this.simulation) {
              this.simulation.alpha(0.5).restart();
          }
      }

      resizeContainer() {
          // Keep cards on right side after resize
          this.centerX = window.innerWidth * 0.75; // 75% from left (right side)
          this.centerY = window.innerHeight / 2;    // Middle height

          if (this.simulation) {
              this.simulation
                  .force('center', d3.forceCenter(this.centerX, this.centerY).strength(0.08))
                  .force('radial', d3.forceRadial(200, this.centerX, this.centerY).strength(0.3))
                  .alpha(0.3).restart();
          }
      }

      destroy() {
          if (this.simulation) {
              this.simulation.stop();
          }
          this.nodes = [];
      }
  }




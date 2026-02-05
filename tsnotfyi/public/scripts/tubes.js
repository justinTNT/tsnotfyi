  // ====== Build Visualization Beams ======
  const beams = [];
  const TUBE_RADIUS = 0.005;
  let RADIUS_SCALE = 0.8;
  let RADIUS_SCALE_TARGET = 0.6;
  const SPARKLE_COUNT = 124;
  const NUM_LONG = 60;
  const NUM_LAT = 80;
  const NUM_LAT_OTHER = 69;
  const PATH_RES = 123;
const RADIAL_SEG = 53;
const BASE_PULSE_HZ = 0.23;
const SEL_PULSE_HZ = 1.23;

function hsl(h, s, l) {
    const color = new THREE.Color();
    color.setHSL(((h % 360) + 360) % 360 / 360, s, l);
    return color;
}


  // ====== Sparkle Systems ======
  const sparkleSystems = new Map();
  const latestCurveForIndex = new Map();

  function ensureSparkles(beamIdx) {
      const highlights = [
         '#fdb', // Bright red tint
         '#fdb', // Bright pink tint
         '#bfd', // Bright green tint
         '#dfb', // Bright cyan tint
         '#dbf', // Bright blue tint
         '#bdf', // Bright purple tint
         '#fec', // Bright yellow tint
      ];

      let sys = sparkleSystems.get(beamIdx);
      if (!sys) {
          const g = new THREE.Group();
          g.renderOrder = 2;
          state.scene.add(g);
          sys = { group: g, meta: [] };

          for (let i = 0; i < SPARKLE_COUNT; i++) {
              const t0 = Math.random();
              const speed = 1.5 + Math.random() * 2.0;
              const phase = Math.random() * Math.PI * 2;

              const geom = new THREE.IcosahedronGeometry(1, 1);
              const colorIndex = Math.floor( Math.random() * 7 );
              const mat = new THREE.MeshBasicMaterial({
                  color: highlights[colorIndex], transparent: true, opacity: 0,
                  blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
              });
              const m = new THREE.Mesh(geom, mat);

              g.add(m);
              sys.meta.push({ mesh: m, t: t0, speed, phase });
          }
          sparkleSystems.set(beamIdx, sys);
      }
      return sys;
  }


  function rebuildHotBeamGeometry(beams, i, t) {
      if (i < 0) return;
      const b = beams[i];
      const displaced = b.basePts.map((p, idx) => {
          const s = idx / (b.basePts.length - 1);
          const phase = t * 0.9 + s * Math.PI * 2;
          const mag = 0.20 * Math.sin(phase) * Math.sin(s * Math.PI);
          return new THREE.Vector3(
              p.x + b.swayDir.x * mag,
              p.y + b.swayDir.y * mag,
              p.z + b.swayDir.z * mag
          );
      });

      const curve = new THREE.CatmullRomCurve3(displaced, true, 'centripetal', 0.6);
      const geo = new THREE.TubeGeometry(curve, PATH_RES, TUBE_RADIUS, RADIAL_SEG, true);

      const baseRadiusFn = makePulledThreadRadiusFn(b.rSeedA, b.rSeedB);
      const dynamicRadiusFn = (s) => {
          const micro = 1.0 + 0.06 * Math.sin(2 * Math.PI * (1.2 * s + 0.4 * t));
          return baseRadiusFn(s) * micro * RADIUS_SCALE * pinchMask(s, b.pinches);
      };

      modulateTubeRadius(geo, PATH_RES, RADIAL_SEG, TUBE_RADIUS, dynamicRadiusFn);

      b.mesh.geometry.dispose();
      b.mesh.geometry = geo;
      latestCurveForIndex.set(i, curve);
  }


  // ====== Animation Loop ======
  let t0 = performance.now();
  const tmpColor = new THREE.Color();

  let beamsAnimationId = null;

  function startBeamsAnimation() {
      if (beamsAnimationId !== null) return;
      t0 = performance.now(); // reset clock to avoid jump
      animateBeams();
  }

  function stopBeamsAnimation() {
      if (beamsAnimationId !== null) {
          cancelAnimationFrame(beamsAnimationId);
          beamsAnimationId = null;
      }
  }

  document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
          stopBeamsAnimation();
      } else {
          startBeamsAnimation();
      }
  });

  const FRAME_INTERVAL_MS = 1000 / 30; // 30fps cap
  let lastFrameTime = 0;

  function animateBeams() {
      beamsAnimationId = requestAnimationFrame(animateBeams);
      const now = performance.now();
      if (now - lastFrameTime < FRAME_INTERVAL_MS) return;
      lastFrameTime = now;
      const t = (now - t0) * 0.001;

      // Animate beams
      beams.forEach((b, i) => {
          const isHot = (i === selectedLong) || (i === selectedLat);
          const freq = isHot ? SEL_PULSE_HZ : BASE_PULSE_HZ;
          const amp = isHot ? 0.40 : 0.20;
          const base = isHot ? 0.60 : 0.40;
          b.mesh.material.opacity = base + amp * (0.5 + 0.5 * Math.sin(2 * Math.PI * freq * t + i * 0.05));

          if (isHot) {
              const selHue = ((t * 12) % 360) / 360;
              const shimmer = new THREE.Color().setHSL(selHue, 0.65, 0.60);
              tmpColor.copy(b.color).lerp(shimmer, 0.53);
              b.mesh.material.color.copy(tmpColor);
          } else {
              b.mesh.material.color.copy(b.color);
          }
      });


      // Smooth thickness transition - only update geometry when scale is changing
      const prevScale = RADIUS_SCALE;
      RADIUS_SCALE += (RADIUS_SCALE_TARGET - RADIUS_SCALE) * 0.12;
      const scaleChanged = Math.abs(RADIUS_SCALE - prevScale) > 0.001;
      if (scaleChanged) {
          beams.forEach((b, i) => {
              const isHot = (i === selectedLong) || (i === selectedLat);
              if (isHot) return;
              const baseFn = makePulledThreadRadiusFn(b.rSeedA, b.rSeedB);
              const desiredFn = (s) => baseFn(s) * RADIUS_SCALE;
              retargetTubeRadius(b.mesh.geometry, PATH_RES, RADIAL_SEG, desiredFn);
          });
      }

      // Rebuild hot beams
      rebuildHotBeamGeometry(beams, selectedLong, t);
      rebuildHotBeamGeometry(beams, selectedLat, t);

      // Animate sparkles
      [selectedLong, selectedLat].forEach((hotIdx) => {
          if (hotIdx < 0) return;
          const curve = latestCurveForIndex.get(hotIdx);
          if (!curve) return;
          const sys = ensureSparkles(hotIdx);
          for (const s of sys.meta) {
              const u = (s.t + 0.02 * t) % 1;
              const pos = curve.getPoint(u);
              s.mesh.position.copy(pos);
              const tw = Math.max(0, Math.sin(2 * Math.PI * s.speed * t + s.phase));
              const tw2 = tw * tw;
              s.mesh.material.opacity = 0.5 + 0.5 * tw2;

              const glint = 0.03;
              s.mesh.scale.setScalar(glint * (0.7 + 0.9 * tw2));
          }
      });
      state.renderer.render(state.scene, state.camera);
  }


  function makeMaterial(colorHex, opacity = 0.65) {
      return new THREE.MeshBasicMaterial({
          color: colorHex,
          transparent: true,
          opacity,
          blending: THREE.AdditiveBlending,
          depthWrite: false
      });
  }


  const R = 22;
  function rWarp(theta, phi) {
      return R * (1.0 + 0.12 * Math.sin(3 * phi) + 0.08 * Math.cos(2 * theta) * Math.sin(phi * 1.5));
  }


  function modulateTubeRadius(geo, tubularSegments, radialSegments, baseRadius, radiusAt) {
      const pos = geo.attributes.position;
      const arr = pos.array;
      const ringStride = radialSegments + 1;
      const ringCount = tubularSegments + 1;

      for (let r = 0; r < ringCount; r++) {
          let cx = 0, cy = 0, cz = 0;
          for (let c = 0; c < ringStride; c++) {
              const i3 = ((r * ringStride + c) * 3);
              cx += arr[i3]; cy += arr[i3 + 1]; cz += arr[i3 + 2];
          }
          cx /= ringStride; cy /= ringStride; cz /= ringStride;

          const s = r / tubularSegments;
          const desired = radiusAt(s);
          const rel = desired / baseRadius;

          for (let c = 0; c < ringStride; c++) {
              const i3 = ((r * ringStride + c) * 3);
              const dx = arr[i3] - cx, dy = arr[i3 + 1] - cy, dz = arr[i3 + 2] - cz;
              arr[i3] = cx + dx * rel;
              arr[i3 + 1] = cy + dy * rel;
              arr[i3 + 2] = cz + dz * rel;
          }
      }
      pos.needsUpdate = true;
      // Normals not needed - using MeshBasicMaterial which ignores lighting
  }


  function retargetTubeRadius(geo, tubularSegments, radialSegments, desiredRadiusAt) {
      const pos = geo.attributes.position;
      const arr = pos.array;
      const ringStride = radialSegments + 1;
      const ringCount = tubularSegments + 1;

      for (let r = 0; r < ringCount; r++) {
          let cx = 0, cy = 0, cz = 0;
          for (let c = 0; c < ringStride; c++) {
              const i3 = ((r * ringStride + c) * 3);
              cx += arr[i3]; cy += arr[i3 + 1]; cz += arr[i3 + 2];
          }
          cx /= ringStride; cy /= ringStride; cz /= ringStride;

          let avgR = 0;
          for (let c = 0; c < ringStride; c++) {
              const i3 = ((r * ringStride + c) * 3);
              const dx = arr[i3] - cx, dy = arr[i3 + 1] - cy, dz = arr[i3 + 2] - cz;
              avgR += Math.hypot(dx, dy, dz);
          }
          avgR /= ringStride;

          const s = r / tubularSegments;
          const desired = desiredRadiusAt(s);
          const k = avgR > 1e-6 ? (desired / avgR) : 1;

          for (let c = 0; c < ringStride; c++) {
              const i3 = ((r * ringStride + c) * 3);
              arr[i3] = cx + (arr[i3] - cx) * k;
              arr[i3 + 1] = cy + (arr[i3 + 1] - cy) * k;
              arr[i3 + 2] = cz + (arr[i3 + 2] - cz) * k;
          }
      }
      pos.needsUpdate = true;
      // Normals not needed - using MeshBasicMaterial which ignores lighting
  }

  function makePulledThreadRadiusFn(seedA = 0, seedB = 0) {
      return (s) => {
          const taper = 0.6 + 0.6 * Math.sin(Math.PI * s);
          const wobble = 1.0 +
              0.23 * Math.sin((6 + seedA) * Math.PI * s + seedB * 2.3) +
              0.13 * Math.sin((17 + seedB) * s + seedA * 4.1);
          return TUBE_RADIUS * taper * wobble;
      };
  }

  const PINCH_FLOOR_FRAC = 0.04;

  function makePinches(seedCount = 2) {
      const count = seedCount + (Math.random() < 0.5 ? 1 : 0);
      const pinches = [];
      for (let i = 0; i < count; i++) {
          pinches.push({
              mu: 0.2 + Math.random() * 0.8,
              sigma: 0.3 + Math.random() * 0.4,
              depth: 0.6 + Math.random() * 0.3
          });
      }
      return pinches;
  }

  function pinchMask(s, pinches, t = 0, animate = false) {
      let m = 1.0;
      for (const p of pinches) {
          const mu = animate ? (p.mu + 0.06 * Math.sin(t * 0.6 + p.mu * 12.3)) : p.mu;
          const ds = s - mu;
          const g = Math.exp(-(ds * ds) / (2 * p.sigma * p.sigma));
          m *= (1.0 - p.depth * g);
      }
      return Math.max(PINCH_FLOOR_FRAC, m);
  }

  function makeCurves() {
      const beamsGroup = new THREE.Group();
      state.scene.add(beamsGroup);

      const tubes = [];

      // Longitudes
      for (let i = 0; i < NUM_LONG; i++) {
          const theta = (i / NUM_LONG) * Math.PI * 2;
          const pts = [];
          for (let j = 0; j <= 64; j++) {
              const t = j / 64, phi = t * Math.PI;
              const r = rWarp(theta, phi);
              const x = r * Math.sin(phi) * Math.cos(theta);
              const y = r * Math.sin(phi) * Math.sin(theta);
              const z = r * Math.cos(phi);
              const sway = Math.sin(t * Math.PI * 2 + i * 0.7) * 1.2;
              pts.push(new THREE.Vector3(x + sway * 0.4, y, z + sway));
          }
          tubes.push({ pts, group: 'A' });
      }

      // Latitudes
      for (let i = 1; i <= NUM_LAT; i++) {
          const phi = (i / (NUM_LAT_OTHER + 1)) * Math.PI;
          const pts = [];
          for (let j = 0; j <= 96; j++) {
              const t = j / 96, theta = t * Math.PI * 2;
              const r = rWarp(theta, phi);
              const x = r * Math.sin(phi) * Math.cos(theta);
              const y = r * Math.sin(phi) * Math.sin(theta);
              const z = r * Math.cos(phi);
              const und = Math.sin(theta * 3 + i) * 1.4;
              pts.push(new THREE.Vector3(x, y + und * 0.3, z + und * 0.6));
          }
          tubes.push({ pts, group: 'B' });
      }

      // Create beams with wide hue spread
      const total = tubes.length;
      const step = (Math.floor(total * 0.61803398875) | 1);

      tubes.forEach(({ pts, group }, k) => {
          const idx = (k * step) % total;
          const baseHue = (idx / total) * 360;
          const sat = 0.4 + 0.4 * idx / total, lig = 0.25 + 0.25 * idx / total;
          const col = hsl(baseHue, sat, lig);

          const mat = makeMaterial(col.getHex(), 0.65);
          const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.6);
          const geo = new THREE.TubeGeometry(curve, PATH_RES, TUBE_RADIUS, RADIAL_SEG, true);

          const rSeedA = Math.random(), rSeedB = Math.random();
          const radiusFn = (s) => makePulledThreadRadiusFn(rSeedA, rSeedB)(s) * RADIUS_SCALE;
          modulateTubeRadius(geo, PATH_RES, RADIAL_SEG, TUBE_RADIUS, radiusFn);

          const mesh = new THREE.Mesh(geo, mat);
          const swayDir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();

          beamsGroup.add(mesh);
          const pinches = makePinches();

          beams.push({ basePts: pts, mesh, group, color: col.clone(), swayDir, rSeedA, rSeedB, baseHue, pinches });
      });
  }


  // ====== Beam Selection ======
  const poolLong = [];
  const poolLat = [];

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function setLatCycleRange(start, end) {
      const lo = clamp(Math.min(start, end), 0, beams.length - 1);
      const hi = clamp(Math.max(start, end), 0, beams.length - 1);
      for (let i = lo; i <= hi; i++) {
          if (beams[i].group === 'B') poolLat.push(i);
      }
  }

  function setLonCycleRange(start, end) {
      const lo = clamp(Math.min(start, end), 0, beams.length - 1);
      const hi = clamp(Math.max(start, end), 0, beams.length - 1);
      for (let i = lo; i <= hi; i++) {
          if (beams[i].group === 'A') poolLong.push(i);
      }
  }
  function setUsefulBeams() {
     setLatCycleRange(133, 170);
     setLonCycleRange(5, 27);
  }

  let selectedLong = poolLong.length ? poolLong[(Math.random() * poolLong.length) | 0] : -1;
  let selectedLat = poolLat.length ? poolLat[(Math.random() * poolLat.length) | 0] : -1;

  // Function to update selected tubes based on track data
  function updateSelectedTubes(trackData) {
      // Use track identifier as seed for consistent selection per track
      const trackSeed = trackData.identifier || trackData.title || '';
      const hashSeed = trackSeed.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);

      // Select longitude based on track data
      if (poolLong.length > 0) {
          const longIndex = hashSeed % poolLong.length;
          selectedLong = poolLong[longIndex];
      }

      // Select latitude based on different aspect of track data (PCA values if available)
      if (poolLat.length > 0) {
          let latSeed = hashSeed;
          if (trackData.pca && trackData.pca.primary_d) {
              // Use PCA primary dimension to influence latitude selection
              latSeed = Math.floor(Math.abs(trackData.pca.primary_d * 100)) + hashSeed;
          }
          const latIndex = latSeed % poolLat.length;
          selectedLat = poolLat[latIndex];
      }

      console.log(`🌟 Updated tubes for track: Long ${selectedLong}, Lat ${selectedLat}`);
  }

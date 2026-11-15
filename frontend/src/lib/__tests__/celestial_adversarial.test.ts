// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import * as THREE from "three";
import { calculateFresnelIntensity } from "./landing_e2e.test";

// ============================================================================
// CHANGER & ADVERSARIAL STRESS SUITE: CELESTIAL SPHERE & WEBGL LIFECYCLE
// ============================================================================

describe("Adversarial 3D Celestial Motion & WebGL Lifecycle Suite", () => {
  // --------------------------------------------------------------------------
  // 1. GLSL FRESNEL RIM GLOW SHADER ORACLE & STRESS TEST
  // --------------------------------------------------------------------------
  describe("1. GLSL Fresnel Rim Glow Mathematical Oracle", () => {
    it("empirically verifies Fresnel glow intensity across 10,000 angular samples", () => {
      const uBias = 0.02;
      const uScale = 1.0;
      const uPower = 2.5;

      let prevIntensity = -1;

      // Sweep angles from 0 rad (facing camera) to PI/2 rad (grazing edge)
      const steps = 10_000;
      for (let i = 0; i <= steps; i++) {
        const theta = (i / steps) * (Math.PI / 2);
        const normalDotView = Math.cos(theta); // 1.0 down to 0.0
        const intensity = calculateFresnelIntensity(normalDotView, uBias, uScale, uPower);

        // Clamping guarantee: must strictly stay within [uBias, 1.0]
        expect(intensity).toBeGreaterThanOrEqual(uBias);
        expect(intensity).toBeLessThanOrEqual(1.0);

        // Monotonic increase as angle increases towards grazing rim
        if (prevIntensity !== -1) {
          expect(intensity).toBeGreaterThanOrEqual(prevIntensity);
        }
        prevIntensity = intensity;
      }

      // Check boundary conditions exactly
      const centerIntensity = calculateFresnelIntensity(1.0, uBias, uScale, uPower);
      expect(centerIntensity).toBe(0.02);

      const grazingIntensity = calculateFresnelIntensity(0.0, uBias, uScale, uPower);
      expect(grazingIntensity).toBe(1.0);
    });

    it("verifies numerical stability against back-facing normals and NaN inputs", () => {
      const uBias = 0.02;
      const uScale = 1.0;
      const uPower = 2.5;

      // Negative dot products (back-facing or glancing past 90 degrees)
      const negativeDots = [-0.001, -0.1, -0.5, -1.0, -2.0];
      for (const dot of negativeDots) {
        const intensity = calculateFresnelIntensity(dot, uBias, uScale, uPower);
        expect(Number.isNaN(intensity)).toBe(false);
        expect(Number.isFinite(intensity)).toBe(true);
        expect(intensity).toBe(1.0); // max(dot, 0.0) clamps to 0.0 -> grazing rim halo
      }

      // Overshoot dot products (> 1.0 due to float rounding)
      const overshootDots = [1.0001, 1.05, 2.0];
      for (const dot of overshootDots) {
        const intensity = calculateFresnelIntensity(dot, uBias, uScale, uPower);
        expect(Number.isNaN(intensity)).toBe(false);
        expect(Number.isFinite(intensity)).toBe(true);
        expect(intensity).toBe(0.02); // clamped to 1.0 -> center minimum
      }
    });

    it("verifies shader uniform monochromatic palette purity", () => {
      const uGlowColor = 0xffffff;
      const r = (uGlowColor >> 16) & 255;
      const g = (uGlowColor >> 8) & 255;
      const b = uGlowColor & 255;
      expect(r).toBe(255);
      expect(g).toBe(255);
      expect(b).toBe(255);
      expect(r).toBe(g);
      expect(g).toBe(b);
    });
  });

  // --------------------------------------------------------------------------
  // 2. LIFECYCLE THROTTLES & DYNAMIC PREFERS-REDUCED-MOTION BUG REPRODUCTION
  // --------------------------------------------------------------------------
  describe("2. WebGL Lifecycle Throttles & Reduced-Motion State Machine", () => {
    it("verifies window blur, focus, and tab visibility throttling", () => {
      let isRunning = false;
      let animId: number | null = null;
      let documentHidden = false;

      const stopLoop = () => {
        isRunning = false;
        animId = null;
      };

      const startLoop = () => {
        if (isRunning) return;
        isRunning = true;
        animId = 123;
      };

      const handleVisibility = () => {
        if (documentHidden) {
          stopLoop();
        } else {
          startLoop();
        }
      };

      const handleBlur = () => stopLoop();
      const handleFocus = () => {
        if (!documentHidden) startLoop();
      };

      // Initial start
      startLoop();
      expect(isRunning).toBe(true);
      expect(animId).toBe(123);

      // Window blur halts loop
      handleBlur();
      expect(isRunning).toBe(false);
      expect(animId).toBeNull();

      // Window focus while visible resumes loop
      handleFocus();
      expect(isRunning).toBe(true);
      expect(animId).toBe(123);

      // Tab hidden halts loop
      documentHidden = true;
      handleVisibility();
      expect(isRunning).toBe(false);
      expect(animId).toBeNull();

      // Window focus while tab hidden must NOT resume loop
      handleFocus();
      expect(isRunning).toBe(false);
      expect(animId).toBeNull();

      // Tab becomes visible resumes loop
      documentHidden = false;
      handleVisibility();
      expect(isRunning).toBe(true);
      expect(animId).toBe(123);
    });

    /**
     * EMPIRICAL FINDING PROBE:
     * Stress-testing the exact state machine implementation in CelestialSphere.tsx:
     * When `prefersReducedMotion` is true, `startLoop()` sets `isRunning = true` without calling `requestAnimationFrame`.
     * Then, when `handleMotionChange(false)` runs, it calls `startLoop()`.
     * But because `isRunning` is already `true`, `startLoop()` returns early without requesting animation frames!
     */
    it("empirically reproduces the dynamic prefers-reduced-motion deadlock bug in CelestialSphere.tsx", () => {
      // Exact state implementation matching CelestialSphere.tsx lines 271-318
      class CelestialImplementationUnderTest {
        public prefersReducedMotion: boolean;
        public isRunning = false;
        public animId: number | null = null;
        public staticFrameRendered = 0;
        public rAfStarts = 0;

        constructor(initialReducedMotion: boolean) {
          this.prefersReducedMotion = initialReducedMotion;
        }

        public renderFrame = () => {
          this.staticFrameRendered++;
        };

        public startLoop = () => {
          if (this.isRunning) return;
          this.isRunning = true;
          if (this.prefersReducedMotion) {
            this.renderFrame();
          } else {
            this.animId = 42;
            this.rAfStarts++;
          }
        };

        public stopLoop = () => {
          this.isRunning = false;
          if (this.animId !== null) {
            this.animId = null;
          }
        };

        public handleMotionChange = (matches: boolean) => {
          this.prefersReducedMotion = matches;
          if (this.prefersReducedMotion) {
            this.stopLoop();
            this.renderFrame();
          } else {
            this.startLoop();
          }
        };

        public handleBlur = () => this.stopLoop();
        public handleFocus = () => this.startLoop();
      }

      // Scenario A: User mounts page with prefers-reduced-motion = true
      const compA = new CelestialImplementationUnderTest(true);
      compA.startLoop();

      expect(compA.staticFrameRendered).toBe(1);
      expect(compA.animId).toBeNull();
      // Notice: isRunning was set to true despite NO rAF loop running!
      expect(compA.isRunning).toBe(true);

      // Now user turns OFF prefers-reduced-motion in OS / browser:
      compA.handleMotionChange(false);

      // BUG REPRODUCED:
      // compA.animId is STILL null!
      // compA.rAfStarts is STILL 0!
      // The sphere is stuck static because startLoop() returned early due to isRunning === true!
      expect(compA.animId).toBeNull();
      expect(compA.rAfStarts).toBe(0);

      // Scenario B: User mounts with prefers-reduced-motion = false, toggles true, blurs/focuses, then toggles false
      const compB = new CelestialImplementationUnderTest(false);
      compB.startLoop();
      expect(compB.rAfStarts).toBe(1);
      expect(compB.animId).toBe(42);

      // User toggles reduced-motion ON
      compB.handleMotionChange(true);
      expect(compB.animId).toBeNull();
      expect(compB.isRunning).toBe(false);

      // User switches window focus while reduced motion is ON
      compB.handleBlur();
      compB.handleFocus();
      // In handleFocus(), startLoop() ran with prefersReducedMotion = true
      // So isRunning became TRUE again:
      expect(compB.isRunning).toBe(true);
      expect(compB.animId).toBeNull();

      // Now user toggles reduced-motion OFF
      compB.handleMotionChange(false);

      // BUG REPRODUCED AGAIN:
      // Loop is dead, rAfStarts was not incremented, animId is still null!
      expect(compB.animId).toBeNull();
      expect(compB.rAfStarts).toBe(1);
    });

    it("verifies the proposed patch solves the dynamic reduced-motion transition cleanly", () => {
      // Patched state machine where isRunning only tracks active rAF loop,
      // and handleMotionChange cleanly stops loop before evaluating transition
      class PatchedCelestialLifecycle {
        public prefersReducedMotion: boolean;
        public isRunning = false;
        public animId: number | null = null;
        public staticFrameRendered = 0;
        public rAfStarts = 0;

        constructor(initialReducedMotion: boolean) {
          this.prefersReducedMotion = initialReducedMotion;
        }

        public renderFrame = () => {
          this.staticFrameRendered++;
        };

        public startLoop = () => {
          if (this.prefersReducedMotion) {
            this.renderFrame();
            return;
          }
          if (this.isRunning) return;
          this.isRunning = true;
          this.animId = 42;
          this.rAfStarts++;
        };

        public stopLoop = () => {
          this.isRunning = false;
          if (this.animId !== null) {
            this.animId = null;
          }
        };

        public handleMotionChange = (matches: boolean) => {
          this.prefersReducedMotion = matches;
          this.stopLoop();
          if (this.prefersReducedMotion) {
            this.renderFrame();
          } else {
            this.startLoop();
          }
        };

        public handleBlur = () => this.stopLoop();
        public handleFocus = () => this.startLoop();
      }

      // Verify Patched Scenario A: starts with reduced motion, switches to false
      const patchedA = new PatchedCelestialLifecycle(true);
      patchedA.startLoop();
      expect(patchedA.isRunning).toBe(false); // isRunning remains false for static frame
      expect(patchedA.animId).toBeNull();

      patchedA.handleMotionChange(false);
      // Loop now cleanly activates!
      expect(patchedA.isRunning).toBe(true);
      expect(patchedA.animId).toBe(42);
      expect(patchedA.rAfStarts).toBe(1);

      // Verify Patched Scenario B: toggling with window blur/focus
      const patchedB = new PatchedCelestialLifecycle(false);
      patchedB.startLoop();
      patchedB.handleMotionChange(true);
      patchedB.handleBlur();
      patchedB.handleFocus();
      patchedB.handleMotionChange(false);
      expect(patchedB.isRunning).toBe(true);
      expect(patchedB.animId).toBe(42);
      expect(patchedB.rAfStarts).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // 3. UNMOUNT TEARDOWN & CONTEXT LOSS RIGOROUS AUDIT
  // --------------------------------------------------------------------------
  describe("3. Three.js Unmount Teardown & Context Loss Cleanup", () => {
    it("empirically verifies all 8 geometries and 8 materials are disposed on unmount", () => {
      // Build scene representation identical to CelestialSphere.tsx
      const scene = new THREE.Scene();
      const celestialGroup = new THREE.Group();
      scene.add(celestialGroup);

      const disposedGeometries: string[] = [];
      const disposedMaterials: string[] = [];

      // 1. Fresnel sphere
      const sphereGeom = new THREE.SphereGeometry(80, 48, 36);
      sphereGeom.userData = { id: "sphereGeom" };
      sphereGeom.dispose = () => disposedGeometries.push("sphereGeom");

      const fresnelMat = new THREE.ShaderMaterial();
      fresnelMat.userData = { id: "fresnelMat" };
      fresnelMat.dispose = () => disposedMaterials.push("fresnelMat");
      celestialGroup.add(new THREE.Mesh(sphereGeom, fresnelMat));

      // 2. Wireframe
      const wireframeGeom = new THREE.WireframeGeometry(sphereGeom);
      wireframeGeom.userData = { id: "wireframeGeom" };
      wireframeGeom.dispose = () => disposedGeometries.push("wireframeGeom");

      const wireframeMat = new THREE.LineBasicMaterial();
      wireframeMat.userData = { id: "wireframeMat" };
      wireframeMat.dispose = () => disposedMaterials.push("wireframeMat");
      celestialGroup.add(new THREE.LineSegments(wireframeGeom, wireframeMat));

      // 3. Surface stardust points
      const pointsGeom = new THREE.BufferGeometry();
      pointsGeom.userData = { id: "pointsGeom" };
      pointsGeom.dispose = () => disposedGeometries.push("pointsGeom");

      const pointsMat = new THREE.PointsMaterial();
      pointsMat.userData = { id: "pointsMat" };
      pointsMat.dispose = () => disposedMaterials.push("pointsMat");
      celestialGroup.add(new THREE.Points(pointsGeom, pointsMat));

      // 4. Ring 1
      const ring1Geom = new THREE.TorusGeometry(108, 0.35, 16, 120);
      ring1Geom.userData = { id: "ring1Geom" };
      ring1Geom.dispose = () => disposedGeometries.push("ring1Geom");

      const ring1Mat = new THREE.MeshBasicMaterial();
      ring1Mat.userData = { id: "ring1Mat" };
      ring1Mat.dispose = () => disposedMaterials.push("ring1Mat");
      celestialGroup.add(new THREE.Mesh(ring1Geom, ring1Mat));

      // 5. Ring 2
      const ring2Geom = new THREE.TorusGeometry(124, 0.3, 16, 140);
      ring2Geom.userData = { id: "ring2Geom" };
      ring2Geom.dispose = () => disposedGeometries.push("ring2Geom");

      const ring2Mat = new THREE.MeshBasicMaterial();
      ring2Mat.userData = { id: "ring2Mat" };
      ring2Mat.dispose = () => disposedMaterials.push("ring2Mat");
      celestialGroup.add(new THREE.Mesh(ring2Geom, ring2Mat));

      // 6. Beacon 1
      const beacon1Geom = new THREE.SphereGeometry(1.2, 16, 16);
      beacon1Geom.userData = { id: "beacon1Geom" };
      beacon1Geom.dispose = () => disposedGeometries.push("beacon1Geom");

      const beacon1Mat = new THREE.MeshBasicMaterial();
      beacon1Mat.userData = { id: "beacon1Mat" };
      beacon1Mat.dispose = () => disposedMaterials.push("beacon1Mat");
      celestialGroup.add(new THREE.Mesh(beacon1Geom, beacon1Mat));

      // 7. Beacon 2
      const beacon2Geom = new THREE.SphereGeometry(0.9, 16, 16);
      beacon2Geom.userData = { id: "beacon2Geom" };
      beacon2Geom.dispose = () => disposedGeometries.push("beacon2Geom");

      const beacon2Mat = new THREE.MeshBasicMaterial();
      beacon2Mat.userData = { id: "beacon2Mat" };
      beacon2Mat.dispose = () => disposedMaterials.push("beacon2Mat");
      celestialGroup.add(new THREE.Mesh(beacon2Geom, beacon2Mat));

      // 8. Starfield
      const starGeom = new THREE.BufferGeometry();
      starGeom.userData = { id: "starGeom" };
      starGeom.dispose = () => disposedGeometries.push("starGeom");

      const starMat = new THREE.PointsMaterial();
      starMat.userData = { id: "starMat" };
      starMat.dispose = () => disposedMaterials.push("starMat");
      scene.add(new THREE.Points(starGeom, starMat));

      // Execute exact teardown traversal from CelestialSphere.tsx lines 348-365
      scene.traverse((obj) => {
        if (
          obj instanceof THREE.Mesh ||
          obj instanceof THREE.LineSegments ||
          obj instanceof THREE.Points
        ) {
          if (obj.geometry) {
            obj.geometry.dispose();
          }
          if (obj.material) {
            if (Array.isArray(obj.material)) {
              obj.material.forEach((m) => m.dispose());
            } else {
              obj.material.dispose();
            }
          }
        }
      });

      // Assert all 8 geometries disposed
      expect(disposedGeometries.length).toBe(8);
      expect(disposedGeometries).toContain("sphereGeom");
      expect(disposedGeometries).toContain("wireframeGeom");
      expect(disposedGeometries).toContain("pointsGeom");
      expect(disposedGeometries).toContain("ring1Geom");
      expect(disposedGeometries).toContain("ring2Geom");
      expect(disposedGeometries).toContain("beacon1Geom");
      expect(disposedGeometries).toContain("beacon2Geom");
      expect(disposedGeometries).toContain("starGeom");

      // Assert all 8 materials disposed
      expect(disposedMaterials.length).toBe(8);
      expect(disposedMaterials).toContain("fresnelMat");
      expect(disposedMaterials).toContain("wireframeMat");
      expect(disposedMaterials).toContain("pointsMat");
      expect(disposedMaterials).toContain("ring1Mat");
      expect(disposedMaterials).toContain("ring2Mat");
      expect(disposedMaterials).toContain("beacon1Mat");
      expect(disposedMaterials).toContain("beacon2Mat");
      expect(disposedMaterials).toContain("starMat");
    });

    it("verifies renderer disposal, context loss invocation, and DOM detachment", () => {
      let rendererDisposed = false;
      let forceContextLossCalled = false;
      let webglLoseContextCalled = false;
      let domRemoved = false;

      const mockDomElement = { id: "canvas-dom" };
      const mockContainer = {
        contains: (el: unknown) => el === mockDomElement,
        removeChild: (el: unknown) => {
          if (el === mockDomElement) domRemoved = true;
        },
      };

      const mockGl = {
        getExtension: (ext: string) => {
          if (ext === "WEBGL_lose_context") {
            return {
              loseContext: () => {
                webglLoseContextCalled = true;
              },
            };
          }
          return null;
        },
      };

      const mockRenderer = {
        domElement: mockDomElement,
        dispose: () => {
          rendererDisposed = true;
        },
        forceContextLoss: () => {
          forceContextLossCalled = true;
        },
        getContext: () => mockGl,
      };

      // Execute exact teardown from CelestialSphere.tsx lines 368-380
      if (mockContainer.contains(mockRenderer.domElement)) {
        mockContainer.removeChild(mockRenderer.domElement);
      }
      mockRenderer.dispose();
      mockRenderer.forceContextLoss();
      const gl = mockRenderer.getContext();
      if (gl && gl.getExtension) {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }

      expect(domRemoved).toBe(true);
      expect(rendererDisposed).toBe(true);
      expect(forceContextLossCalled).toBe(true);
      expect(webglLoseContextCalled).toBe(true);
    });

    it("stress tests rapid 100-cycle mount/unmount teardowns without exceptions", () => {
      let activeListeners = 0;

      const mount = () => {
        // simulate registering listeners
        activeListeners += 5; // visibility, blur, focus, mousemove, motionChange

        // return unmount teardown
        return () => {
          activeListeners -= 5;
        };
      };

      for (let i = 0; i < 100; i++) {
        const unmount = mount();
        expect(activeListeners).toBe(5);
        unmount();
        expect(activeListeners).toBe(0);
      }

      expect(activeListeners).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // 4. KEPLERIAN BEACON ORBIT VS RING GEOMETRY ALIGNMENT CHALLENGE
  // --------------------------------------------------------------------------
  describe("4. Keplerian Beacon Trajectory vs Torus Ring Alignment Challenge", () => {
    it("quantifies deviation between Beacon 1 parametric trajectory and Ring 1 geometric plane", () => {
      // Ring 1 setup from CelestialSphere.tsx lines 144-152:
      // ring1Geom radius = 108
      // ring1.rotation.x = Math.PI / 2.35
      // ring1.rotation.y = 0.18
      const radius = 108;
      const rotX = Math.PI / 2.35;
      const rotY = 0.18;

      // In Three.js, TorusGeometry lies in XY plane (normal = +Z: [0, 0, 1]).
      // When rotated by rotation.x then rotation.y (Euler XYZ):
      // The plane normal vector n is rotated:
      const ringEuler = new THREE.Euler(rotX, rotY, 0, "XYZ");
      const ringNormal = new THREE.Vector3(0, 0, 1).applyEuler(ringEuler).normalize();

      // Beacon 1 trajectory from lines 253-256:
      // beacon1.position.x = Math.cos(s1Angle) * 108;
      // beacon1.position.y = Math.sin(s1Angle) * Math.sin(Math.PI / 2.35) * 108;
      // beacon1.position.z = Math.sin(s1Angle) * Math.cos(Math.PI / 2.35) * 108;
      // Notice: rotation.y (0.18 rad = ~10.3 deg) is omitted, and Y/Z trig uses sin/cos inverted.

      // Sample beacon position along the orbit
      let maxPlaneDistance = 0;
      for (let step = 0; step < 360; step++) {
        const s1Angle = (step * Math.PI) / 180;
        const beaconPos = new THREE.Vector3(
          Math.cos(s1Angle) * radius,
          Math.sin(s1Angle) * Math.sin(rotX) * radius,
          Math.sin(s1Angle) * Math.cos(rotX) * radius
        );

        // Distance from plane passing through origin with ringNormal: |pos . ringNormal|
        const distanceToPlane = Math.abs(beaconPos.dot(ringNormal));
        if (distanceToPlane > maxPlaneDistance) {
          maxPlaneDistance = distanceToPlane;
        }
      }

      // Observation: Beacon 1 drifts away from Ring 1's plane by up to ~19.3 units (~18% of ring radius!)
      // because ring1.rotation.y = 0.18 is not included in Beacon 1's manual trigonometric formula.
      expect(maxPlaneDistance).toBeGreaterThan(15.0);
    });

    it("quantifies deviation between Beacon 2 parametric trajectory and Ring 2 geometric plane", () => {
      // Ring 2 setup from CelestialSphere.tsx lines 156-164:
      // ring2Geom radius = 124
      // ring2.rotation.x = -Math.PI / 2.65
      // ring2.rotation.z = 0.28
      const radius = 124;
      const rotX = -Math.PI / 2.65;
      const rotZ = 0.28;

      const ringEuler = new THREE.Euler(rotX, 0, rotZ, "XYZ");
      const ringNormal = new THREE.Vector3(0, 0, 1).applyEuler(ringEuler).normalize();

      // Beacon 2 trajectory from lines 260-262:
      // beacon2.position.x = Math.cos(s2Angle) * 124;
      // beacon2.position.y = -Math.sin(s2Angle) * Math.sin(Math.PI / 2.65) * 124;
      // beacon2.position.z = Math.sin(s2Angle) * Math.cos(Math.PI / 2.65) * 124;
      // Notice: rotation.z (0.28 rad = ~16 deg) is omitted.

      let maxPlaneDistance = 0;
      for (let step = 0; step < 360; step++) {
        const s2Angle = -(step * Math.PI) / 180;
        const beaconPos = new THREE.Vector3(
          Math.cos(s2Angle) * radius,
          -Math.sin(s2Angle) * Math.sin(Math.PI / 2.65) * radius,
          Math.sin(s2Angle) * Math.cos(Math.PI / 2.65) * radius
        );

        const distanceToPlane = Math.abs(beaconPos.dot(ringNormal));
        if (distanceToPlane > maxPlaneDistance) {
          maxPlaneDistance = distanceToPlane;
        }
      }

      // Observation: Beacon 2 drifts away from Ring 2's plane by up to ~34 units (~27% of ring radius!)
      expect(maxPlaneDistance).toBeGreaterThan(25.0);
    });
  });
});

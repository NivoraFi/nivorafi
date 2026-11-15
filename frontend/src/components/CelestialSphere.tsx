"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * Custom GLSL Shaders for Ethereal Monochromatic Glass Rim / Fresnel Glow
 * Computes the angle between the surface normal and camera view vector.
 */
const FRESNEL_VERTEX_SHADER = `
varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = -mvPosition.xyz;
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRESNEL_FRAGMENT_SHADER = `
varying vec3 vNormal;
varying vec3 vViewPosition;

uniform vec3 uGlowColor;
uniform float uBias;
uniform float uScale;
uniform float uPower;
uniform float uAlpha;

void main() {
  vec3 normal = normalize(vNormal);
  vec3 viewDir = normalize(vViewPosition);
  float fresnel = uBias + uScale * pow(1.0 - max(dot(normal, viewDir), 0.0), uPower);
  fresnel = clamp(fresnel, 0.0, 1.0);
  gl_FragColor = vec4(uGlowColor, fresnel * uAlpha);
}
`;

export interface CelestialSphereProps {
  className?: string;
  interactive?: boolean;
  dimmed?: boolean;
}

export default function CelestialSphere({
  className = "",
  interactive = true,
  dimmed = false,
}: CelestialSphereProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 1. Accessibility: dynamic prefers-reduced-motion media query
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let prefersReducedMotion = motionQuery.matches;

    // 2. Scene, Camera & Dimensions
    const scene = new THREE.Scene();
    let width = container.clientWidth || window.innerWidth || 800;
    let height = container.clientHeight || window.innerHeight || 600;

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.z = 250;

    // 3. WebGL Renderer with antialias, alpha, and high-performance profile
    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch {
      // Graceful fallback if WebGL is unavailable or disabled
      return;
    }

    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);

    // 4. Central Group for all rotating celestial elements
    const celestialGroup = new THREE.Group();
    celestialGroup.rotation.x = 0.22;
    scene.add(celestialGroup);

    // --- 5. Geometry & Materials Construction ---

    // A. Outer Hull: Custom GLSL Fresnel Rim Glow Atmosphere Glass Shell
    const radius = 80;
    const sphereGeom = new THREE.SphereGeometry(radius, 48, 36);
    const fresnelMat = new THREE.ShaderMaterial({
      vertexShader: FRESNEL_VERTEX_SHADER,
      fragmentShader: FRESNEL_FRAGMENT_SHADER,
      uniforms: {
        uGlowColor: { value: new THREE.Color(0xffffff) },
        uBias: { value: 0.02 },
        uScale: { value: 1.0 },
        uPower: { value: 2.5 },
        uAlpha: { value: 0.55 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
      depthWrite: false,
    });
    const fresnelMesh = new THREE.Mesh(sphereGeom, fresnelMat);
    celestialGroup.add(fresnelMesh);

    // B. Inner Core: High-Precision Geodesic Wireframe
    const wireframeGeom = new THREE.WireframeGeometry(sphereGeom);
    const wireframeMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.065,
    });
    const sphereWire = new THREE.LineSegments(wireframeGeom, wireframeMat);
    celestialGroup.add(sphereWire);

    // C. Celestial Surface Stardust Nodes
    const posArray = sphereGeom.attributes.position.array;
    const pointsGeom = new THREE.BufferGeometry();
    pointsGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(posArray), 3)
    );
    const pointsMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.85,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
    });
    const globePoints = new THREE.Points(pointsGeom, pointsMat);
    celestialGroup.add(globePoints);

    // D. Dual Keplerian Orbital Yield Rings
    // Ring 1: PT Fixed Yield Ring (Tilted ~35 deg)
    const ring1Geom = new THREE.TorusGeometry(108, 0.35, 16, 120);
    const ring1Mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.16,
    });
    const ring1 = new THREE.Mesh(ring1Geom, ring1Mat);
    ring1.rotation.x = Math.PI / 2.35;
    ring1.rotation.y = 0.18;
    celestialGroup.add(ring1);

    // Ring 2: YT Leverage Ring (Opposing Tilt ~-40 deg)
    const ring2Geom = new THREE.TorusGeometry(124, 0.3, 16, 140);
    const ring2Mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.11,
    });
    const ring2 = new THREE.Mesh(ring2Geom, ring2Mat);
    ring2.rotation.x = -Math.PI / 2.65;
    ring2.rotation.z = 0.28;
    celestialGroup.add(ring2);

    // E. Revolving Beacons (PT & YT Convergence Beacons)
    // Parented directly to ring1 and ring2 for exact zero-drift Keplerian orbital alignment
    const beacon1Geom = new THREE.SphereGeometry(1.2, 16, 16);
    const beacon1Mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
    });
    const beacon1 = new THREE.Mesh(beacon1Geom, beacon1Mat);
    beacon1.position.set(108, 0, 0); // Aligns beacon on ring perimeter for static accessibility frame
    ring1.add(beacon1);

    const beacon2Geom = new THREE.SphereGeometry(0.9, 16, 16);
    const beacon2Mat = new THREE.MeshBasicMaterial({
      color: 0xcccccc,
      transparent: true,
      opacity: 0.65,
    });
    const beacon2 = new THREE.Mesh(beacon2Geom, beacon2Mat);
    beacon2.position.set(124, 0, 0); // Aligns beacon on ring perimeter for static accessibility frame
    ring2.add(beacon2);

    // F. Ambient Starfield Nebula with Parallax
    const starCount = 360;
    const starGeom = new THREE.BufferGeometry();
    const starPositions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount * 3; i += 3) {
      starPositions[i] = (Math.random() - 0.5) * 500;
      starPositions[i + 1] = (Math.random() - 0.5) * 400;
      starPositions[i + 2] = (Math.random() - 0.5) * 400;
    }
    starGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(starPositions, 3)
    );
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.75,
      transparent: true,
      opacity: 0.22,
    });
    const starField = new THREE.Points(starGeom, starMat);
    scene.add(starField);

    // --- 6. Interaction State ---
    let targetX = 0;
    let targetY = 0;
    let mouseX = 0;
    let mouseY = 0;

    const onPointerMove = (e: MouseEvent) => {
      if (prefersReducedMotion || !interactive) return;
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      targetX = x * 0.09;
      targetY = y * 0.06;
    };

    window.addEventListener("mousemove", onPointerMove);

    // --- 7. Lifecycle, Visibility & 60fps Animation Loop ---
    let animId: number | null = null;
    let clock = 0;
    let isRunning = false;

    const introDurationMs = 1850;
    const introStart = performance.now();

    const applyIntroProgress = (rawT: number) => {
      const t = Math.min(1, Math.max(0, rawT));
      const eased = 1 - Math.pow(1 - t, 3);
      celestialGroup.scale.setScalar(0.82 + 0.18 * eased);
      fresnelMat.uniforms.uAlpha.value = 0.55 * eased;
      wireframeMat.opacity = 0.065 * eased;
      pointsMat.opacity = 0.22 * eased;
      const ring1Phase = Math.min(1, Math.max(0, (eased - 0.14) / 0.86));
      const ring2Phase = Math.min(1, Math.max(0, (eased - 0.24) / 0.76));
      ring1Mat.opacity = 0.16 * ring1Phase;
      ring2Mat.opacity = 0.11 * ring2Phase;
      beacon1Mat.opacity = 0.85 * ring1Phase;
      beacon2Mat.opacity = 0.65 * ring2Phase;
      starMat.opacity = 0.22 * eased;
    };

    const renderFrame = () => {
      if (renderer) {
        renderer.render(scene, camera);
      }
    };

    const animate = () => {
      if (!isRunning) return;
      animId = requestAnimationFrame(animate);

      if (!prefersReducedMotion) {
        applyIntroProgress((performance.now() - introStart) / introDurationMs);
        clock += 0.015;

        // Smooth Lerp Mouse Drift
        mouseX += (targetX - mouseX) * 0.035;
        mouseY += (targetY - mouseY) * 0.035;

        celestialGroup.rotation.y += 0.0009;
        celestialGroup.rotation.x = 0.22 + mouseY;
        celestialGroup.rotation.z = mouseX * 0.45;

        // Parametric Orbit for Beacon 1 (PT Ring: local XY plane, radius = 108)
        const s1Angle = clock * 0.24;
        beacon1.position.set(
          Math.cos(s1Angle) * 108,
          Math.sin(s1Angle) * 108,
          0
        );

        // Parametric Orbit for Beacon 2 (YT Ring: local XY plane, radius = 124)
        const s2Angle = -clock * 0.19;
        beacon2.position.set(
          Math.cos(s2Angle) * 124,
          Math.sin(s2Angle) * 124,
          0
        );

        // Gentle Ambient Nebula Counter-Drift
        starField.rotation.y -= 0.00012;
      }

      renderFrame();
    };

    const startLoop = () => {
      if (prefersReducedMotion) {
        applyIntroProgress(1);
        renderFrame(); // Static fallback single frame for accessibility
        return;
      }
      if (isRunning) return;
      isRunning = true;
      animId = requestAnimationFrame(animate);
    };

    const stopLoop = () => {
      isRunning = false;
      if (animId !== null) {
        cancelAnimationFrame(animId);
        animId = null;
      }
    };

    // Tab visibility & Window focus throttles to preserve resources
    const handleVisibility = () => {
      if (document.hidden) {
        stopLoop();
      } else {
        startLoop();
      }
    };

    const handleBlur = () => stopLoop();
    const handleFocus = () => {
      if (!document.hidden) startLoop();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("focus", handleFocus);

    // prefers-reduced-motion dynamic listener
    const handleMotionChange = (e: MediaQueryListEvent) => {
      prefersReducedMotion = e.matches;
      stopLoop();
      if (prefersReducedMotion) {
        applyIntroProgress(1);
        renderFrame();
      } else {
        startLoop();
      }
    };
    motionQuery.addEventListener("change", handleMotionChange);

    // Initial Start
    if (!prefersReducedMotion) {
      applyIntroProgress(0);
    }
    startLoop();

    // --- 8. Responsive Resize Handling ---
    const handleResize = () => {
      if (!container || !renderer) return;
      width = container.clientWidth;
      height = container.clientHeight;
      if (width === 0 || height === 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      if (prefersReducedMotion) renderFrame();
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    // --- 9. Comprehensive Teardown & Context Loss ---
    return () => {
      stopLoop();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("mousemove", onPointerMove);
      motionQuery.removeEventListener("change", handleMotionChange);
      resizeObserver.disconnect();

      // Traverse scene and dispose geometries & materials
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

      // Detach and clean WebGL Renderer
      if (renderer) {
        if (container.contains(renderer.domElement)) {
          container.removeChild(renderer.domElement);
        }
        renderer.dispose();
        renderer.forceContextLoss();

        // Explicitly lose context via extension to immediately release GPU VRAM
        const gl = renderer.getContext();
        if (gl && gl.getExtension) {
          gl.getExtension("WEBGL_lose_context")?.loseContext();
        }
      }
    };
  }, [interactive]);

  return (
    <div
      ref={containerRef}
      className={`pointer-events-none absolute inset-0 -z-10 flex items-center justify-center overflow-hidden transition-opacity duration-700 ${
        dimmed ? "opacity-20" : "opacity-60"
      } ${className}`}
      style={{
        maskImage:
          "radial-gradient(circle at 50% 42%, black 20%, color-mix(in srgb, black 40%, transparent) 60%, transparent 80%)",
        WebkitMaskImage:
          "radial-gradient(circle at 50% 42%, black 20%, color-mix(in srgb, black 40%, transparent) 60%, transparent 80%)",
      }}
    />
  );
}

"use client";

import React from "react";
import { motion, useReducedMotion } from "motion/react";

export type RevealDirection = "top" | "bottom" | "left" | "right" | "scale";

/**
 * Calibrated ease-out curves following /design-taste motion tokens:
 * - EASE_SETTLE: crisp entrance settling without overshoot/bounce
 * - EASE_PLANET: deep slow atmospheric emergence for centerpiece WebGL sphere
 */
export const EASE_SETTLE: [number, number, number, number] = [0.22, 1, 0.36, 1];
export const EASE_PLANET: [number, number, number, number] = [0.16, 1, 0.3, 1];

export const SPRING_TACTILE = {
  type: "spring" as const,
  stiffness: 280,
  damping: 24,
  mass: 0.8,
};

export function getDirectionalOffset(
  from: RevealDirection,
  distance: number
): { opacity: number; x?: number; y?: number; scale?: number } {
  switch (from) {
    case "top":
      return { opacity: 0, y: -distance };
    case "bottom":
      return { opacity: 0, y: distance };
    case "left":
      return { opacity: 0, x: -distance };
    case "right":
      return { opacity: 0, x: distance };
    case "scale":
      return { opacity: 0, scale: 0.94 };
  }
}

export interface PlanetStageProps {
  children: React.ReactNode;
  dimmed?: boolean;
  className?: string;
}

/**
 * Outer stage wrapper for the central CelestialSphere.
 * Slowly materializes the centerpiece planet first (1.65s), then gently
 * attenuates scale/opacity when entering Trading Desk or Portfolio views.
 */
export function PlanetStage({
  children,
  dimmed = false,
  className = "",
}: PlanetStageProps) {
  const prefersReducedMotion = useReducedMotion();

  if (prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.86 }}
      animate={{
        opacity: dimmed ? 0.55 : 1,
        scale: dimmed ? 0.96 : 1,
      }}
      transition={{
        duration: 1.65,
        ease: EASE_PLANET,
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export interface DirectionalRevealProps {
  children: React.ReactNode;
  from?: RevealDirection;
  delay?: number;
  duration?: number;
  distance?: number;
  className?: string;
}

/**
 * Hardware-accelerated directional entrance wrapper (transform + opacity only).
 * Sequences UI elements from top, bottom, left, or right after planet emergence.
 */
export function DirectionalReveal({
  children,
  from = "bottom",
  delay = 0,
  duration = 0.72,
  distance = 26,
  className,
}: DirectionalRevealProps) {
  const prefersReducedMotion = useReducedMotion();

  if (prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  const initialOffset = getDirectionalOffset(from, distance);

  return (
    <motion.div
      initial={initialOffset}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      transition={{
        duration,
        delay,
        ease: EASE_SETTLE,
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export interface InteractiveLiftCardProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Subtle /design-taste hover elevation (-2px lift, 160ms settle, zero tilt).
 */
export function InteractiveLiftCard({
  children,
  className,
}: InteractiveLiftCardProps) {
  const prefersReducedMotion = useReducedMotion();

  if (prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      whileHover={{ y: -2 }}
      transition={{ duration: 0.16, ease: EASE_SETTLE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export interface MotionActionProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Tactile spring hover/press wrapper for primary action controls (-1px hover, 0.985 press).
 */
export function MotionAction({ children, className }: MotionActionProps) {
  const prefersReducedMotion = useReducedMotion();

  if (prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      whileHover={{ y: -1.5 }}
      whileTap={{ y: 1, scale: 0.985 }}
      transition={SPRING_TACTILE}
      className={className}
    >
      {children}
    </motion.div>
  );
}

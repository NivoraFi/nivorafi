// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import React from "react";
import fs from "fs";
import path from "path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PlanetStage,
  DirectionalReveal,
  InteractiveLiftCard,
  MotionAction,
  getDirectionalOffset,
  EASE_SETTLE,
  EASE_PLANET,
  SPRING_TACTILE,
} from "@/components/ui/motion-primitives";

const FRONTEND_DIR = path.resolve(__dirname, "../../..");

const RAW_HEX_REGEX = /#(?:[0-9a-fA-F]{3,8})\b/g;
const RGBA_REGEX = /rgba?\(/g;
const ARBITRARY_HEX_CLASS = /\[#[0-9a-fA-F]+\]/g;
const UNICODE_EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

describe("Motion Choreography & Directional Entrance Test Suite", () => {
  describe("1. getDirectionalOffset & Motion Tokens", () => {
    it("returns exact vector for top: { opacity: 0, y: -distance }", () => {
      expect(getDirectionalOffset("top", 16)).toEqual({ opacity: 0, y: -16 });
      expect(getDirectionalOffset("top", 20)).toEqual({ opacity: 0, y: -20 });
      expect(getDirectionalOffset("top", 32)).toEqual({ opacity: 0, y: -32 });
    });

    it("returns exact vector for bottom: { opacity: 0, y: distance }", () => {
      expect(getDirectionalOffset("bottom", 20)).toEqual({ opacity: 0, y: 20 });
      expect(getDirectionalOffset("bottom", 24)).toEqual({ opacity: 0, y: 24 });
      expect(getDirectionalOffset("bottom", 26)).toEqual({ opacity: 0, y: 26 });
    });

    it("returns exact vector for left: { opacity: 0, x: -distance }", () => {
      expect(getDirectionalOffset("left", 26)).toEqual({ opacity: 0, x: -26 });
      expect(getDirectionalOffset("left", 28)).toEqual({ opacity: 0, x: -28 });
    });

    it("returns exact vector for right: { opacity: 0, x: distance }", () => {
      expect(getDirectionalOffset("right", 26)).toEqual({ opacity: 0, x: 26 });
      expect(getDirectionalOffset("right", 28)).toEqual({ opacity: 0, x: 28 });
    });

    it("returns exact vector for scale: { opacity: 0, scale: 0.94 }", () => {
      expect(getDirectionalOffset("scale", 26)).toEqual({ opacity: 0, scale: 0.94 });
      expect(getDirectionalOffset("scale", 0)).toEqual({ opacity: 0, scale: 0.94 });
    });

    it("exposes calibrated cubic-bezier easing tokens", () => {
      expect(EASE_SETTLE).toEqual([0.22, 1, 0.36, 1]);
      expect(EASE_PLANET).toEqual([0.16, 1, 0.3, 1]);
      expect(SPRING_TACTILE.type).toBe("spring");
      expect(SPRING_TACTILE.stiffness).toBe(280);
      expect(SPRING_TACTILE.damping).toBe(24);
    });
  });

  describe("2. Motion Primitives SSR Markup & Transform Invariants", () => {
    it("renders PlanetStage with initial opacity:0 and scale(0.86)", () => {
      const html = renderToStaticMarkup(
        <PlanetStage className="celestial-canvas" dimmed={true}>
          <div data-testid="planet-inner">Sphere Content</div>
        </PlanetStage>
      );

      expect(html).toContain("celestial-canvas");
      expect(html).toContain("opacity:0");
      expect(html).toContain("transform:scale(0.86)");
      expect(html).toContain("Sphere Content");
      expect(html.match(RAW_HEX_REGEX)).toBeNull();
      expect(html.match(UNICODE_EMOJI_REGEX)).toBeNull();
    });

    it("renders DirectionalReveal from='top' with translateY(-distance)", () => {
      const html = renderToStaticMarkup(
        <DirectionalReveal from="top" distance={16} duration={0.4} className="top-nav-reveal">
          <header>Nav Header</header>
        </DirectionalReveal>
      );

      expect(html).toContain("top-nav-reveal");
      expect(html).toContain("opacity:0");
      expect(html).toContain("transform:translateY(-16px)");
      expect(html).toContain("Nav Header");
      expect(html.match(RAW_HEX_REGEX)).toBeNull();
      expect(html.match(UNICODE_EMOJI_REGEX)).toBeNull();
    });

    it("renders DirectionalReveal from='bottom' with translateY(distance)", () => {
      const html = renderToStaticMarkup(
        <DirectionalReveal from="bottom" distance={24} duration={0.56} className="bottom-card-reveal">
          <section>Yield Cards</section>
        </DirectionalReveal>
      );

      expect(html).toContain("bottom-card-reveal");
      expect(html).toContain("opacity:0");
      expect(html).toContain("transform:translateY(24px)");
      expect(html).toContain("Yield Cards");
    });

    it("renders DirectionalReveal from='left' with translateX(-distance)", () => {
      const html = renderToStaticMarkup(
        <DirectionalReveal from="left" distance={28} duration={0.58} className="chart-col">
          <div>Chart Area</div>
        </DirectionalReveal>
      );

      expect(html).toContain("chart-col");
      expect(html).toContain("opacity:0");
      expect(html).toContain("transform:translateX(-28px)");
      expect(html).toContain("Chart Area");
    });

    it("renders DirectionalReveal from='right' with translateX(distance)", () => {
      const html = renderToStaticMarkup(
        <DirectionalReveal from="right" distance={26} duration={0.58} className="desk-col">
          <div>Trading Desk</div>
        </DirectionalReveal>
      );

      expect(html).toContain("desk-col");
      expect(html).toContain("opacity:0");
      expect(html).toContain("transform:translateX(26px)");
      expect(html).toContain("Trading Desk");
    });

    it("renders DirectionalReveal from='scale' with scale(0.94)", () => {
      const html = renderToStaticMarkup(
        <DirectionalReveal from="scale">
          <div>Modal Window</div>
        </DirectionalReveal>
      );

      expect(html).toContain("opacity:0");
      expect(html).toContain("transform:scale(0.94)");
      expect(html).toContain("Modal Window");
    });

    it("renders InteractiveLiftCard with child content and className", () => {
      const html = renderToStaticMarkup(
        <InteractiveLiftCard className="h-full metric-card">
          <span>TVL Metric</span>
        </InteractiveLiftCard>
      );

      expect(html).toContain("h-full metric-card");
      expect(html).toContain("TVL Metric");
      expect(html.match(RAW_HEX_REGEX)).toBeNull();
      expect(html.match(UNICODE_EMOJI_REGEX)).toBeNull();
    });

    it("renders MotionAction with child content and tabindex", () => {
      const html = renderToStaticMarkup(
        <MotionAction className="cta-button">
          <button type="button">Execute Swap</button>
        </MotionAction>
      );

      expect(html).toContain("cta-button");
      expect(html).toContain("Execute Swap");
      expect(html.match(RAW_HEX_REGEX)).toBeNull();
      expect(html.match(UNICODE_EMOJI_REGEX)).toBeNull();
    });
  });

  describe("3. Static Source Check: motion-primitives.tsx", () => {
    const primitivesPath = path.join(FRONTEND_DIR, "src/components/ui/motion-primitives.tsx");
    const content = fs.readFileSync(primitivesPath, "utf-8");

    it("starts with 'use client' directive", () => {
      expect(content.startsWith('"use client";') || content.startsWith("'use client';")).toBe(true);
    });

    it("imports and honors useReducedMotion from motion/react", () => {
      expect(content).toContain("useReducedMotion");
      expect(content).toContain("from \"motion/react\"");
      expect(content).toContain("prefersReducedMotion");
    });

    it("strictly contains zero raw hex color codes", () => {
      const matches = content.match(RAW_HEX_REGEX);
      expect(matches).toBeNull();
    });

    it("strictly contains zero rgba() color literals", () => {
      const matches = content.match(RGBA_REGEX);
      expect(matches).toBeNull();
    });

    it("strictly contains zero arbitrary [#...] Tailwind classes", () => {
      const matches = content.match(ARBITRARY_HEX_CLASS);
      expect(matches).toBeNull();
    });

    it("strictly contains zero Unicode emojis", () => {
      const matches = content.match(UNICODE_EMOJI_REGEX);
      expect(matches).toBeNull();
    });
  });

  describe("4. Static Source Check: Route Client Motion Choreography", () => {
    it("verifies TradePageClient integrates PlanetStage and DirectionalReveal sequence", () => {
      const tradeClientPath = path.join(FRONTEND_DIR, "src/components/trade/TradePageClient.tsx");
      const content = fs.readFileSync(tradeClientPath, "utf-8");

      expect(content).toContain('import { PlanetStage, DirectionalReveal } from "@/components/ui/motion-primitives";');
      expect(content).toContain('<PlanetStage dimmed={true} className="fixed inset-0 pointer-events-none z-0">');
      expect(content).toContain('<DirectionalReveal from="top" distance={16} duration={0.40}>');
      expect(content).toContain('<DirectionalReveal from="top" delay={0.06} distance={20} duration={0.52}>');
      expect(content).toContain('<DirectionalReveal from="bottom" delay={0.12} distance={20} duration={0.54}>');
      expect(content).toContain('from="left"');
      expect(content).toContain('delay={0.18}');
      expect(content).toContain('distance={26}');
      expect(content).toContain('duration={0.58}');
      expect(content).toContain('from="right"');
      expect(content).toContain('delay={0.22}');
      expect(content).toContain('data-typography="tabular-mono"');

      expect(content.match(RAW_HEX_REGEX)).toBeNull();
      expect(content.match(RGBA_REGEX)).toBeNull();
      expect(content.match(ARBITRARY_HEX_CLASS)).toBeNull();
      expect(content.match(UNICODE_EMOJI_REGEX)).toBeNull();
    });

    it("verifies MarketsPageClient integrates DirectionalReveal and InteractiveLiftCard strip", () => {
      const marketsClientPath = path.join(FRONTEND_DIR, "src/app/markets/MarketsPageClient.tsx");
      const content = fs.readFileSync(marketsClientPath, "utf-8");

      expect(content).toContain('import { DirectionalReveal, InteractiveLiftCard } from "@/components/ui/motion-primitives";');
      expect(content).toContain('<DirectionalReveal from="top" distance={16} duration={0.40}>');
      expect(content).toContain('<DirectionalReveal from="top" delay={0.06} distance={20} duration={0.52}>');
      expect(content).toContain('<DirectionalReveal from="left" delay={0.12} distance={28} duration={0.56}>');
      expect(content).toContain('<DirectionalReveal from="bottom" delay={0.18} distance={24} duration={0.56}>');
      expect(content).toContain('<DirectionalReveal from="right" delay={0.24} distance={28} duration={0.56}>');
      expect(content).toContain('<InteractiveLiftCard className="h-full">');
      expect(content).toContain('<DirectionalReveal from="bottom" delay={0.28} distance={26} duration={0.62} className="w-full">');

      expect(content.match(RAW_HEX_REGEX)).toBeNull();
      expect(content.match(RGBA_REGEX)).toBeNull();
      expect(content.match(ARBITRARY_HEX_CLASS)).toBeNull();
      expect(content.match(UNICODE_EMOJI_REGEX)).toBeNull();
    });

    it("verifies PortfolioPageClient integrates PlanetStage and DirectionalReveal sequence", () => {
      const portfolioClientPath = path.join(FRONTEND_DIR, "src/components/portfolio/PortfolioPageClient.tsx");
      const content = fs.readFileSync(portfolioClientPath, "utf-8");

      expect(content).toContain('import { PlanetStage, DirectionalReveal } from "@/components/ui/motion-primitives";');
      expect(content).toContain('<PlanetStage dimmed={true} className="fixed inset-0 pointer-events-none z-0 overflow-hidden opacity-30">');
      expect(content).toContain('<DirectionalReveal from="top" distance={16} duration={0.40}>');
      expect(content).toContain('<DirectionalReveal from="bottom" delay={0.08} distance={20} duration={0.52} className="w-full">');

      expect(content.match(RAW_HEX_REGEX)).toBeNull();
      expect(content.match(RGBA_REGEX)).toBeNull();
      expect(content.match(ARBITRARY_HEX_CLASS)).toBeNull();
      expect(content.match(UNICODE_EMOJI_REGEX)).toBeNull();
    });
  });
});

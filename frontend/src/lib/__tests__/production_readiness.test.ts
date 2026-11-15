// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";
import { ENV, NETWORK_PASSPHRASES } from "../env";

describe("Production Readiness & Resilience Suite", () => {
  describe("Environment Configuration & Typing", () => {
    it("exports normalized target network and passphrases", () => {
      expect(ENV.network).toBe("testnet");
      expect(ENV.networkPassphrase).toBe("Test SDF Network ; September 2015");
      expect(ENV.rpcUrl).toContain("soroban-testnet.stellar.org");
      expect(ENV.horizonUrl).toContain("horizon-testnet.stellar.org");
      expect(ENV.deployer).toBe("GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27");
    });

    it("maintains verified contract IDs in ENV", () => {
      expect(ENV.contracts.yield_pool).toBe("CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF");
      expect(ENV.contracts.sy_blend_wrapper).toBe("CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5");
      expect(ENV.contracts.pt_token).toBe("CCYQPUI7VI7GJKJM6JZIWVVZPJ4GKZ2ZYQ5FT5JBMSXHZITDOVRMS37A");
      expect(ENV.contracts.yt_token).toBe("CCH3B54EW4XZKA6IBHJ2XFLDQCAJZWQ2N2ZREZDUNPJLLMOD3E5B7Z73");
      expect(ENV.contracts.mock_blend).toBe("CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6");
      expect(ENV.contracts.usdc_sac).toBe("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
    });

    it("contains fallback passphrases for standard networks", () => {
      expect(NETWORK_PASSPHRASES.testnet).toBe("Test SDF Network ; September 2015");
      expect(NETWORK_PASSPHRASES.public).toBe("Public Global Stellar Network ; September 2015");
      expect(NETWORK_PASSPHRASES.futurenet).toBe("Test SDF Future Network ; October 2022");
    });

    it("verifies .env.example and .env.production exist", () => {
      const frontendDir = path.resolve(__dirname, "../../..");
      const envExample = path.join(frontendDir, ".env.example");
      const envProd = path.join(frontendDir, ".env.production");

      expect(fs.existsSync(envExample)).toBe(true);
      expect(fs.existsSync(envProd)).toBe(true);
    });
  });

  describe("Dead Code Elimination Audit", () => {
    it("confirms 4 legacy unreferenced files have been safely eliminated", () => {
      const componentsDir = path.resolve(__dirname, "../../components");

      const deadFiles = [
        "FixedYieldPanel.tsx",
        "MarketHeroStats.tsx",
        "ContractsAndAgentFooter.tsx",
        "PendleGlobe3D.tsx",
      ];

      for (const file of deadFiles) {
        const fullPath = path.join(componentsDir, file);
        expect(fs.existsSync(fullPath)).toBe(false);
      }
    });
  });

  describe("Structured Error Boundaries & Production Assets", () => {
    it("confirms presence of Next.js 15 error boundaries and error boundary component", () => {
      const appDir = path.resolve(__dirname, "../../app");
      const componentsDir = path.resolve(__dirname, "../../components");

      expect(fs.existsSync(path.join(appDir, "error.tsx"))).toBe(true);
      expect(fs.existsSync(path.join(appDir, "global-error.tsx"))).toBe(true);
      expect(fs.existsSync(path.join(appDir, "not-found.tsx"))).toBe(true);
      expect(fs.existsSync(path.join(componentsDir, "ErrorBoundary.tsx"))).toBe(true);
    });

    it("confirms presence of SVG icon and production favicons", () => {
      const publicDir = path.resolve(__dirname, "../../../public");

      expect(fs.existsSync(path.join(publicDir, "icon.svg"))).toBe(true);
      expect(fs.existsSync(path.join(publicDir, "favicon.ico"))).toBe(true);
      expect(fs.existsSync(path.join(publicDir, "favicon.png"))).toBe(true);

      const svgContent = fs.readFileSync(path.join(publicDir, "icon.svg"), "utf-8");
      expect(svgContent).toContain("<svg");
      expect(svgContent).toContain("</svg>");
    });
  });
});

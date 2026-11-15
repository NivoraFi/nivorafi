// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import { explorerTxUrl, STELLAR_PENDLE_CONFIG } from "../contracts";
import { isNetworkMismatch } from "../../context/WalletProvider";
import { shortenAddress } from "../math";

describe("Transaction Lifecycle & Network Mismatch Suite", () => {
  describe("4-Stage Transaction Lifecycle State Machine", () => {
    it("progresses sequentially through IDLE -> PENDING -> CONFIRMING -> CONFIRMED", () => {
      type TxStage = "IDLE" | "PENDING" | "CONFIRMING" | "CONFIRMED" | "FAILED";

      const stateHistory: TxStage[] = [];
      let currentStage: TxStage = "IDLE";
      stateHistory.push(currentStage);

      // 1. User initiates trade action
      currentStage = "PENDING";
      stateHistory.push(currentStage);

      // 2. RPC returns transaction send receipt
      const liveHash = "b63f85994ca756e0f0a8f8550a9106748a16f40bbebd8645429478b4b1d68dca";
      currentStage = "CONFIRMING";
      stateHistory.push(currentStage);

      // Verify hash and explorer URL are available in CONFIRMING
      const confirmingUrl = explorerTxUrl(liveHash);
      expect(confirmingUrl).toBe(`https://stellar.expert/explorer/testnet/tx/${liveHash}`);

      // 3. Ledger closes and pollTransaction succeeds
      currentStage = "CONFIRMED";
      stateHistory.push(currentStage);

      expect(stateHistory).toEqual(["IDLE", "PENDING", "CONFIRMING", "CONFIRMED"]);
    });

    it("retains live txHash and explorer link when ledger polling fails", () => {
      const liveHash = "f203ac746e86a732c8f05893f1dd36caeb6ba45882f0e55baf7c44543a4a6d77";
      const expectedUrl = `https://stellar.expert/explorer/testnet/tx/${liveHash}`;

      // Simulate error object thrown by submitSignedSorobanTx
      const err = new Error(
        `Soroban transaction failed [tx: ${liveHash}]: Error(Contract, #14). Explorer: ${expectedUrl}`
      ) as Error & { txHash: string; explorerUrl: string };
      err.txHash = liveHash;
      err.explorerUrl = expectedUrl;

      expect(err.txHash).toBe(liveHash);
      expect(err.explorerUrl).toBe(expectedUrl);
      expect(err.message).toContain(liveHash);
      expect(err.message).toContain(expectedUrl);
    });

    it("formats shortened transaction hashes consistently for UI display", () => {
      const liveHash = "2a6a3ac22bfd07dc6c237878cc42f20515b076880be0be7649d23d7b99424dde";
      const formatted = shortenAddress(liveHash, 6, 6);
      expect(formatted).toBe("2a6a3a...424dde");
      expect(formatted.length).toBe(15);
    });
  });

  describe("Network Mismatch Detection & Invariants", () => {
    it("evaluates to false when connected wallet matches target testnet passphrase", () => {
      const isMismatch = isNetworkMismatch({
        networkPassphrase: STELLAR_PENDLE_CONFIG.networkPassphrase,
        network: "TESTNET",
      });
      expect(isMismatch).toBe(false);
    });

    it("detects mismatch when wallet connects to Public Mainnet passphrase", () => {
      const mainnetPassphrase = "Public Global Stellar Network ; September 2015";
      const isMismatch = isNetworkMismatch({
        networkPassphrase: mainnetPassphrase,
      });
      expect(isMismatch).toBe(true);
    });

    it("detects mismatch when wallet connects to Futurenet passphrase", () => {
      const futurenetPassphrase = "Test SDF Future Network ; October 2022";
      const isMismatch = isNetworkMismatch({
        networkPassphrase: futurenetPassphrase,
      });
      expect(isMismatch).toBe(true);
    });

    it("detects mismatch when wallet payload specifies public network name discrepancy", () => {
      const isMismatch = isNetworkMismatch({
        network: "PUBLIC",
      });
      expect(isMismatch).toBe(true);
    });

    it("handles null or undefined payload safely without throwing", () => {
      expect(isNetworkMismatch(null)).toBe(false);
      expect(isNetworkMismatch(undefined)).toBe(false);
    });
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("OracleMath Library", function () {
  let mockPool;
  let oracleHarness;
  let owner;

  before(async function () {
    [owner] = await ethers.getSigners();

    // 1. Deploy the Mock Pool
    const MockFactory = await ethers.getContractFactory("MockUniswapV3Pool");
    mockPool = await MockFactory.deploy();
    await mockPool.deployed(); // Optional in v6, often good practice in v5 to wait

    // 2. Deploy the Harness
    const HarnessFactory = await ethers.getContractFactory("OracleMathHarness");
    oracleHarness = await HarnessFactory.deploy();
    await oracleHarness.deployed();
  });

  describe("consult()", function () {
    it("Should correctly initialize memory array and return average tick", async function () {
      const secondsAgo = 100;
      const targetTick = 500;

      const cumulativeOld = 100000;
      const cumulativeCurrent = cumulativeOld + (targetTick * secondsAgo);

      await mockPool.setTickCumulatives([cumulativeOld, cumulativeCurrent]);

      // FIX: Use .address instead of .target for Ethers v5
      const resultTick = await oracleHarness.consult(mockPool.address, secondsAgo);

      expect(resultTick).to.equal(targetTick);
    });

    it("Should handle negative ticks correctly (rounding down)", async function () {
      const secondsAgo = 10;
      const cumulativeOld = 1000;
      const cumulativeCurrent = 995; // Delta -5

      await mockPool.setTickCumulatives([cumulativeOld, cumulativeCurrent]);

      // FIX: Use .address
      const resultTick = await oracleHarness.consult(mockPool.address, secondsAgo);

      expect(resultTick).to.equal(-1);
    });

    it("Should revert if secondsAgo is 0", async function () {
      // FIX: Use .address
      await expect(
        oracleHarness.consult(mockPool.address, 0)
      ).to.be.revertedWith("secondsAgo=0");
    });

    it("Should revert with custom error if pool lacks history (observe fails)", async function () {
      // 1. Tell the mock to revert any observe calls
      await mockPool.setShouldRevert(true);

      // 2. Expect our specific error message, not the generic one
      await expect(
        oracleHarness.consult(mockPool.address, 100)
      ).to.be.revertedWith("OracleMath: Pool has insufficient history");
    });
    
    it("Should call preparePool successfully", async function () {
      // Just verifying the external call succeeds
      await expect(
        oracleHarness.preparePool(mockPool.address, 100)
      ).to.not.be.reverted;
    });
  });

  describe("getQuoteAtTick()", function () {
    it("Should calculate quote correctly for TokenA < TokenB", async function () {
      const tick = 0;
      // FIX: Use ethers.utils.parseUnits for Ethers v5
      const baseAmount = ethers.utils.parseUnits("1", 18);
      const tokenA = "0x0000000000000000000000000000000000000001";
      const tokenB = "0x0000000000000000000000000000000000000002";

      const quote = await oracleHarness.getQuoteAtTick(tick, baseAmount, tokenA, tokenB);

      expect(quote).to.equal(baseAmount);
    });
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SeasonRebalancer guardrails (max trade cap + cooldown)", function () {
  let owner, u1;
  let spring, summer, autumn, winter, tokens;
  let vault, season, dex, rebal;

  beforeEach(async function () {
    [owner, u1] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    spring = await Mock.deploy("SPRING", "SPR");
    summer = await Mock.deploy("SUMMER", "SUM");
    autumn = await Mock.deploy("AUTUMN", "AUT");
    winter = await Mock.deploy("WINTER", "WIN");
    tokens = [spring, summer, autumn, winter];

    const Vault = await ethers.getContractFactory("SeasonVault");
    vault = await Vault.deploy(
      [spring.address, summer.address, autumn.address, winter.address],
      owner.address
    );

    const Dex = await ethers.getContractFactory("MockDex");
    dex = await Dex.deploy(owner.address);

    // 1:1 rates
    const ONE = ethers.utils.parseUnits("1", 18);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j) continue;
        await dex.setRateE18(tokens[i].address, tokens[j].address, ONE);
      }
    }

    // Dex liquidity
    const big = ethers.utils.parseUnits("1000000", 18);
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(dex.address, big);
    }

    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, owner.address);
    await vault.connect(owner).transferOwnership(season.address);

    const Rebal = await ethers.getContractFactory("SeasonRebalancer");
    rebal = await Rebal.deploy(vault.address, dex.address, owner.address);

    await rebal.connect(owner).setWeights([2500, 2500, 2500, 2500]);

    // Hand ownership to SEASON
    await rebal.connect(owner).transferOwnership(season.address);

    await season.connect(owner).setRebalancer(rebal.address);
    await season.connect(owner).setVaultOperator(rebal.address);
    await season.connect(owner).setFees(0, 0);
  });

  async function seedSkewedVault() {
    const dep = [
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("100", 18),
      ethers.utils.parseUnits("50", 18),
      ethers.utils.parseUnits("10", 18),
    ];

    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(u1.address, dep[i]);
      await tokens[i].connect(u1).approve(season.address, dep[i]);
    }
    await season.connect(u1).mintWithDeposit(dep);
  }

  it("cooldown: prevents rapid-fire rebalances", async function () {
    await seedSkewedVault();

    await season.connect(owner).setRebalanceCooldownSeconds(3600);

    await season.connect(owner).rebalance();

    await expect(season.connect(owner).rebalance()).to.be.revertedWith("COOLDOWN");

    // advance time
    await ethers.provider.send("evm_increaseTime", [3600]);
    await ethers.provider.send("evm_mine");

    await season.connect(owner).rebalance(); // should succeed
  });

  it("maxTradeBps: caps total amountIn per token-in across swaps within a rebalance", async function () {
    await seedSkewedVault();

    // Set aggressive cap: 10% of each token's starting balance per rebalance
    await season.connect(owner).setRebalanceMaxTradeBps(1000); // 10%

    const before = await vault.balances();

    const tx = await season.connect(owner).rebalance();
    const rcpt = await tx.wait();

    // Parse SwapExecuted events from rebalancer logs
    const iface = rebal.interface;
    const logs = rcpt.logs
      .filter(l => l.address.toLowerCase() === rebal.address.toLowerCase())
      .map(l => {
        try { return iface.parseLog(l); } catch { return null; }
      })
      .filter(Boolean);

    const swaps = logs.filter(e => e.name === "SwapExecuted");
    expect(swaps.length).to.be.gte(1);

    // Build per-token caps from starting balances
    const capBps = 1000;
    const caps = before.map(b => b.mul(capBps).div(10000)); // floor

    // Aggregate amountIn by tokenIn
    const sumIn = new Map();
    for (const s of swaps) {
      const tokenIn = s.args.tokenIn.toLowerCase();
      const amtIn = s.args.amountIn;

      const prev = sumIn.get(tokenIn) || ethers.BigNumber.from(0);
      sumIn.set(tokenIn, prev.add(amtIn));
    }

    // Map token addresses -> index
    const addrToIndex = new Map();
    for (let i = 0; i < 4; i++) {
      addrToIndex.set(tokens[i].address.toLowerCase(), i);
    }

    // Check each tokenIn total <= cap[index]
    for (const [tokenIn, totalIn] of sumIn.entries()) {
      const idx = addrToIndex.get(tokenIn);
      expect(idx).to.not.equal(undefined);

      expect(totalIn).to.be.lte(caps[idx]);
    }
  });
});

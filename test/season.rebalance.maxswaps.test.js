const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SeasonRebalancer guardrail: max swaps per rebalance", function () {
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

    // 1:1 rates for all pairs
    const ONE = ethers.utils.parseUnits("1", 18);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j) continue;
        await dex.setRateE18(tokens[i].address, tokens[j].address, ONE);
      }
    }

    // Liquidity
    const big = ethers.utils.parseUnits("1000000", 18);
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(dex.address, big);
    }

    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, owner.address);
    await vault.connect(owner).transferOwnership(season.address);

    const Rebal = await ethers.getContractFactory("SeasonRebalancer");
    rebal = await Rebal.deploy(vault.address, dex.address, owner.address);

    // Weights: equal
    await rebal.connect(owner).setWeights([2500, 2500, 2500, 2500]);

    // Hand ownership to SEASON
    await rebal.connect(owner).transferOwnership(season.address);

    await season.connect(owner).setRebalancer(rebal.address);
    await season.connect(owner).setVaultOperator(rebal.address);

    // Disable other guardrails for clarity
    await season.connect(owner).setRebalanceMaxTradeBps(10000);
    await season.connect(owner).setRebalanceCooldownSeconds(0);
    await season.connect(owner).setFees(0, 0);
  });

  it("reverts when maxSwapsPerRebalance is too low for required swaps", async function () {
    // Seed skewed vault to require multiple swaps
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

    // Limit swaps to 1 — should be insufficient for full adjustment (usually needs >=2)
    await season.connect(owner).setRebalanceMaxSwapsPerRebalance(1);

    await expect(season.connect(owner).rebalance()).to.be.revertedWith("MAX_SWAPS");
  });

  it("succeeds when maxSwapsPerRebalance is high enough; emits <= max swaps", async function () {
    // Same skew
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

    await season.connect(owner).setRebalanceMaxSwapsPerRebalance(10);

    const tx = await season.connect(owner).rebalance();
    const rcpt = await tx.wait();

    const iface = rebal.interface;
    const logs = rcpt.logs
      .filter(l => l.address.toLowerCase() === rebal.address.toLowerCase())
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .filter(Boolean);

    const swaps = logs.filter(e => e.name === "SwapExecuted");
    expect(swaps.length).to.be.lte(10);
    expect(swaps.length).to.be.gte(1);
  });
});

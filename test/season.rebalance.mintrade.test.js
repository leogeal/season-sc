const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SeasonRebalancer guardrail: min trade amount (skip dust)", function () {
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

    const ONE = ethers.utils.parseUnits("1", 18);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j) continue;
        await dex.setRateE18(tokens[i].address, tokens[j].address, ONE);
      }
    }

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
    await rebal.connect(owner).transferOwnership(season.address);

    await season.connect(owner).setRebalancer(rebal.address);
    await season.connect(owner).setVaultOperator(rebal.address);

    // disable other guardrails
    await season.connect(owner).setRebalanceMaxTradeBps(10000);
    await season.connect(owner).setRebalanceCooldownSeconds(0);
    await season.connect(owner).setRebalanceMaxSwapsPerRebalance(0); // unlimited
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

  it("skips swaps when minTradeAmount is too high (0 SwapExecuted events)", async function () {
    await seedSkewedVault();

    // Set minTradeAmount larger than any expected single-leg amount in this scenario
    await season.connect(owner).setRebalanceMinTradeAmount(ethers.utils.parseUnits("10000", 18));

    const tx = await season.connect(owner).rebalance();
    const rcpt = await tx.wait();

    const iface = rebal.interface;
    const logs = rcpt.logs
      .filter(l => l.address.toLowerCase() === rebal.address.toLowerCase())
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .filter(Boolean);

    const started = logs.filter(e => e.name === "RebalanceStarted");
    const finished = logs.filter(e => e.name === "RebalanceFinished");
    const swaps = logs.filter(e => e.name === "SwapExecuted");

    expect(started.length).to.equal(1);
    expect(finished.length).to.equal(1);
    expect(swaps.length).to.equal(0);
  });

  it("every executed swap has amountIn >= minTradeAmount", async function () {
    await seedSkewedVault();

    const minAmt = ethers.utils.parseUnits("5", 18);
    await season.connect(owner).setRebalanceMinTradeAmount(minAmt);

    const tx = await season.connect(owner).rebalance();
    const rcpt = await tx.wait();

    const iface = rebal.interface;
    const logs = rcpt.logs
      .filter(l => l.address.toLowerCase() === rebal.address.toLowerCase())
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .filter(Boolean);

    const swaps = logs.filter(e => e.name === "SwapExecuted");
    expect(swaps.length).to.be.gte(1);

    for (const s of swaps) {
      expect(s.args.amountIn).to.be.gte(minAmt);
    }
  });
});

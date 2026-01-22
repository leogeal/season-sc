const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SeasonRebalancer event-level accounting", function () {
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
    await season.connect(owner).setFees(0, 0);
  });

  it("emits RebalanceStarted, SwapExecuted (>=1), and RebalanceFinished with a consistent nonce", async function () {
    // skewed deposit
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

    // Call rebalance via SEASON
    const tx = await season.connect(owner).rebalance();
    const rcpt = await tx.wait();

    // Pull logs from rebalancer address only
    const iface = rebal.interface;
    const logs = rcpt.logs
      .filter(l => l.address.toLowerCase() === rebal.address.toLowerCase())
      .map(l => {
        try { return iface.parseLog(l); } catch { return null; }
      })
      .filter(Boolean);

    const started = logs.filter(e => e.name === "RebalanceStarted");
    const swaps = logs.filter(e => e.name === "SwapExecuted");
    const finished = logs.filter(e => e.name === "RebalanceFinished");

    expect(started.length).to.equal(1);
    expect(finished.length).to.equal(1);
    expect(swaps.length).to.be.gte(1);

    const nonceStart = started[0].args.nonce;
    const nonceFinish = finished[0].args.nonce;

    expect(nonceFinish).to.equal(nonceStart);

    // Every swap should have the same nonce and should satisfy amountOut >= minOut
    for (const s of swaps) {
      expect(s.args.nonce).to.equal(nonceStart);
      expect(s.args.amountOut).to.be.gte(s.args.minOut);
      expect(s.args.quotedOut).to.be.gte(s.args.minOut); // by construction
    }
  });
});
